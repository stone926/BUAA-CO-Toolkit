import { afterEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import * as vscode from 'vscode';
import type { AsmCase } from '../asmCaseStore';
import {
  asmCaseSourceSnapshotIssue,
  copyAsmCaseArtifact,
  updateAsmCaseArtifacts,
  updateAsmCaseMetadata
} from '../asmCaseStore';
import type { AsmCaseManifestV2 } from '../courseTesting/manifestCodec';

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('./helpers/vscodeMock');
  return createVscodeModuleMock(createVscodeMockState(), vi.fn);
});

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createCase(): AsmCase {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-asm-case-v2-'));
  temporaryRoots.push(root);
  const caseDir = path.join(root, 'case-1');
  fs.mkdirSync(caseDir);
  const engine = {
    id: 'legacy-mars-configured',
    semanticsRevision: 1,
    capabilitiesRevision: 1
  };
  const manifest: AsmCaseManifestV2 = {
    version: 2,
    caseId: 'case-1',
    createdAt: '2026-08-26T00:00:00.000Z',
    profile: 'P7',
    originalAsmPath: path.join(root, 'original.asm'),
    asmSnapshot: { path: 'program.asm', sha256: 'a'.repeat(64), bytes: 3 },
    source: { kind: 'builtin' },
    program: { assembler: engine },
    oracle: {
      engine,
      configurationHash: 'b'.repeat(64),
      runConfiguration: { profile: 'P7', memoryConfiguration: 'CompactLargeText' },
      stopReason: 'unknown'
    }
  };
  return {
    id: manifest.caseId,
    dir: URI.file(caseDir),
    manifestUri: URI.file(path.join(caseDir, 'case.json')),
    asm: URI.file(path.join(caseDir, 'program.asm')),
    sourceAsm: URI.file(path.join(caseDir, 'program.asm')),
    machineCode: URI.file(path.join(caseDir, 'code.txt')),
    manifest
  };
}

describe('ASM case manifest v2 artifact storage', () => {
  it('stores case-relative content fingerprints and keeps metadata separate', async () => {
    const asmCase = createCase();
    const artifactDir = path.join(asmCase.dir.fsPath, 'verilog');
    fs.mkdirSync(artifactDir);
    const artifactFile = path.join(artifactDir, 'trace.out');
    const contents = Buffer.from('@00003000: $ 1 <= 00000001\n');
    fs.writeFileSync(artifactFile, contents);

    await updateAsmCaseArtifacts(asmCase, 'verilog', { traceOut: artifactFile });
    await updateAsmCaseMetadata(asmCase, { 'source.seed': 'seed-1' });

    const manifest = asmCase.manifest as AsmCaseManifestV2;
    expect(manifest.artifacts?.dut?.['verilog/traceOut']).toEqual({
      path: 'verilog/trace.out',
      sha256: crypto.createHash('sha256').update(contents).digest('hex'),
      bytes: contents.byteLength
    });
    expect(manifest.metadata).toEqual({ 'source.seed': 'seed-1' });
    const written = JSON.parse(fs.readFileSync(asmCase.manifestUri.fsPath, 'utf8')) as AsmCaseManifestV2;
    expect(written.artifacts).toEqual(manifest.artifacts);
    expect(written.metadata).toEqual(manifest.metadata);
  });

  it('rejects direct references outside the case directory', async () => {
    const asmCase = createCase();
    const external = path.join(path.dirname(asmCase.dir.fsPath), 'external.out');
    fs.writeFileSync(external, 'external');

    await expect(updateAsmCaseArtifacts(asmCase, 'mars', { traceOut: external }))
      .rejects.toThrow(/must be copied inside the case directory/);
    expect((asmCase.manifest as AsmCaseManifestV2).artifacts).toBeUndefined();
  });

  it('rejects a case-local link that resolves outside the case directory', async () => {
    const asmCase = createCase();
    const externalDir = path.join(path.dirname(asmCase.dir.fsPath), 'external-dir');
    fs.mkdirSync(externalDir);
    fs.writeFileSync(path.join(externalDir, 'trace.out'), 'external');
    const linkedDir = path.join(asmCase.dir.fsPath, 'linked');
    fs.symlinkSync(externalDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(updateAsmCaseArtifacts(asmCase, 'mars', {
      traceOut: path.join(linkedDir, 'trace.out')
    })).rejects.toThrow(/resolves outside the case directory/);
    expect((asmCase.manifest as AsmCaseManifestV2).artifacts).toBeUndefined();
  });

  it('does not mutate a legacy v1 manifest', async () => {
    const asmCase = createCase();
    asmCase.manifest = {
      version: 1,
      caseId: 'legacy-case',
      createdAt: '2026-08-25T00:00:00.000Z',
      profile: 'P7',
      originalAsmPath: 'E:/work/legacy.asm',
      asmSnapshot: { path: 'program.asm', sha256: 'a'.repeat(64), bytes: 3 },
      source: { kind: 'selected' }
    };

    await expect(updateAsmCaseMetadata(asmCase, { 'source.seed': 'seed' }))
      .rejects.toThrow(/manifest v1 is read-only/);
    expect(asmCase.manifest).not.toHaveProperty('artifacts');
  });

  it('rejects empty or unsafe manifest map entries before writing', async () => {
    const asmCase = createCase();

    await expect(updateAsmCaseMetadata(asmCase, { '': 'value' }))
      .rejects.toThrow(/metadata key is invalid/);
    await expect(updateAsmCaseMetadata(asmCase, { constructor: 'value' }))
      .rejects.toThrow(/metadata key is invalid/);
    await expect(updateAsmCaseArtifacts(asmCase, 'mars', {}))
      .rejects.toThrow(/must contain at least one entry/);
    expect(fs.existsSync(asmCase.manifestUri.fsPath)).toBe(false);
  });

  it('copies an external file into the case before recording its fingerprint', async () => {
    const asmCase = createCase();
    const source = path.join(path.dirname(asmCase.dir.fsPath), 'external-trace.out');
    fs.writeFileSync(source, 'trace contents');
    vi.mocked(vscode.workspace.fs.createDirectory).mockImplementationOnce(async (uri) => {
      await fs.promises.mkdir(uri.fsPath, { recursive: true });
    });
    vi.mocked(vscode.workspace.fs.readFile).mockImplementationOnce(async (uri) =>
      await fs.promises.readFile(uri.fsPath));
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementationOnce(async (uri, bytes) => {
      await fs.promises.writeFile(uri.fsPath, bytes);
    });

    const copied = await copyAsmCaseArtifact(
      asmCase,
      'mars',
      URI.file(source),
      'oracle.out',
      'traceOut'
    );

    expect(fs.readFileSync(copied.fsPath, 'utf8')).toBe('trace contents');
    expect((asmCase.manifest as AsmCaseManifestV2).artifacts?.oracle?.traceOut)
      .toMatchObject({ path: 'mars/oracle.out', bytes: 14 });
  });

  it('rejects source or case-local root bytes that drift from the immutable snapshot', async () => {
    const asmCase = createCase();
    const original = path.join(path.dirname(asmCase.dir.fsPath), 'original.asm');
    const source = Buffer.from('.text\nori $t0,$0,1\n');
    fs.writeFileSync(asmCase.asm.fsPath, source);
    fs.writeFileSync(original, source);
    asmCase.sourceAsm = URI.file(original);
    (asmCase.manifest as AsmCaseManifestV2).asmSnapshot = {
      path: 'program.asm',
      sha256: crypto.createHash('sha256').update(source).digest('hex'),
      bytes: source.byteLength
    };

    await expect(asmCaseSourceSnapshotIssue(asmCase)).resolves.toBeUndefined();

    fs.writeFileSync(original, '.text\nori $t0,$0,2\n');
    await expect(asmCaseSourceSnapshotIssue(asmCase)).resolves.toMatch(/ASM source 已偏离/);

    fs.writeFileSync(original, source);
    fs.writeFileSync(asmCase.asm.fsPath, '.text\nori $t0,$0,3\n');
    await expect(asmCaseSourceSnapshotIssue(asmCase)).resolves.toMatch(/case-local ASM snapshot 已偏离/);
  });
});
