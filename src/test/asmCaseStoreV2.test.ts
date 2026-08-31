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
  listAsmCaseManifests,
  machineCodeValidationOutputMessage,
  maximumAsmCaseIndexEntries,
  maximumAsmCaseIndexManifestBytes,
  prepareAsmCaseMachineCode,
  readAsmCaseManifestForAsm,
  readAsmCaseStdinSnapshot,
  recordAsmCaseTestOutcome,
  recordAsmCaseOracleResult,
  updateAsmCaseArtifacts,
  updateAsmCaseMetadata
} from '../asmCaseStore';
import {
  discardContinuousGeneratedAsmCase,
  discardContinuousPassingAsmCase,
  markContinuousAsmCaseCancelled
} from '../courseTesting/continuousCaseRetention';
import type { AsmCaseManifestV2 } from '../courseTesting/manifestCodec';
import type { ExecuteResult } from '../mips/providers/contracts';
import {
  maximumReplayManifestBytes,
  maximumReplaySnapshotBytes,
  maximumReplaySourceBytes,
  maximumReplayStdinBytes
} from '../mips/replay/boundedFile';
import { builtinExecutionEngineArtifact } from '../mips/replay/builtinEngineArtifact';
import { resolveCourseEnginePlan } from '../mips/providers/courseEnginePolicy';
import { canonicalJson, sha256Canonical, type CanonicalJson } from '../mips/replay/canonical';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('./helpers/vscodeMock').createVscodeMockState> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('./helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  return createVscodeModuleMock(vscodeState.state, vi.fn);
});

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vscodeState.state!.workspaceFolders.splice(0);
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createCase(): AsmCase {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-asm-case-v2-'));
  temporaryRoots.push(root);
  const caseDir = path.join(root, '.co', 'cases', 'case-1');
  fs.mkdirSync(caseDir, { recursive: true });
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
  it('hides word, address and mnemonic diagnostics from automatic output', () => {
    const detail = '0x00004180 word=ffffffff mnemonic=unknown SECRET_INTERNAL';
    expect(machineCodeValidationOutputMessage(detail, true)).toBe('自动测试点校验失败');
    expect(machineCodeValidationOutputMessage(detail, true)).not.toContain('SECRET_INTERNAL');
    expect(machineCodeValidationOutputMessage(detail, false)).toBe(detail);
  });

  it('rejects an assembly plan captured for a different case profile', async () => {
    const asmCase = createCase();
    const result = await prepareAsmCaseMachineCode({} as never, asmCase, {
      enginePlan: resolveCourseEnginePlan('auto', 'P3')
    });

    expect(result).toMatchObject({ ok: false });
    expect(result?.status.stderr).toMatch(/plan profile P3 differs from case profile P7/);
  });

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

  it('moves DUT-affecting metadata into a typed configuration fingerprint', async () => {
    const asmCase = createCase();
    await updateAsmCaseMetadata(asmCase, {
      'dut.verilog.testbenchModule': 'mips_tb',
      'dut.verilog.testbenchSha256': 'a'.repeat(64)
    });
    const manifest = asmCase.manifest as AsmCaseManifestV2;
    expect(manifest.metadata).toBeUndefined();
    expect(manifest.dut?.configuration).toEqual({
      'dut.verilog.testbenchModule': 'mips_tb',
      'dut.verilog.testbenchSha256': 'a'.repeat(64)
    });
    expect(manifest.dut?.configurationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records only the sanitized outcome needed by test history', async () => {
    const asmCase = createCase();
    fs.writeFileSync(asmCase.manifestUri.fsPath, JSON.stringify(asmCase.manifest));

    await recordAsmCaseTestOutcome(asmCase.manifestUri.fsPath, {
      status: 'error',
      stage: 'dut',
      diagnostic: '[AUTO-DUT] CPU 仿真未完成；请检查工具链和顶层接口'
    });

    const written = JSON.parse(fs.readFileSync(asmCase.manifestUri.fsPath, 'utf8')) as AsmCaseManifestV2;
    expect(written.metadata).toEqual({
      'test.status': 'error',
      'test.stage': 'dut',
      'test.diagnostic': '[AUTO-DUT] CPU 仿真未完成；请检查工具链和顶层接口'
    });
  });

  it('moves a matching generated continuous case out of the live case index', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const asmCase = makeContinuousOwnedCase(sessionId, 'generated');

    await expect(discardContinuousGeneratedAsmCase(asmCase.manifestUri.fsPath, sessionId))
      .resolves.toBe(true);

    expect(fs.existsSync(asmCase.dir.fsPath)).toBe(false);
  });

  it('marks a matching generated case cancelled before safely discarding it', async () => {
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const asmCase = makeContinuousOwnedCase(sessionId, 'generated');

    await expect(markContinuousAsmCaseCancelled(asmCase.manifestUri.fsPath, sessionId))
      .resolves.toBe(true);
    const marked = JSON.parse(fs.readFileSync(asmCase.manifestUri.fsPath, 'utf8')) as AsmCaseManifestV2;
    expect(marked.metadata?.['continuous.state']).toBe('cancelled');
    await expect(discardContinuousGeneratedAsmCase(asmCase.manifestUri.fsPath, sessionId))
      .resolves.toBe(true);
  });

  it('refuses continuous cleanup for a different session, manual source, or terminal evidence', async () => {
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const mismatched = makeContinuousOwnedCase(sessionId, 'generated');
    await expect(discardContinuousGeneratedAsmCase(
      mismatched.manifestUri.fsPath,
      '44444444-4444-4444-8444-444444444444'
    )).resolves.toBe(false);
    await expect(recordAsmCaseTestOutcome(mismatched.manifestUri.fsPath, {
      status: 'failed',
      stage: 'compare',
      diagnostic: 'wrong session',
      continuous: {
        sessionId: '44444444-4444-4444-8444-444444444444',
        state: 'failed'
      }
    })).rejects.toThrow(/ownership validation/);
    expect(fs.existsSync(mismatched.dir.fsPath)).toBe(true);

    const manual = makeContinuousOwnedCase(sessionId, 'generated');
    (manual.manifest as AsmCaseManifestV2).source = { kind: 'selected' };
    fs.writeFileSync(manual.manifestUri.fsPath, JSON.stringify(manual.manifest));
    await expect(discardContinuousGeneratedAsmCase(manual.manifestUri.fsPath, sessionId))
      .resolves.toBe(false);
    expect(fs.existsSync(manual.dir.fsPath)).toBe(true);

    const failed = makeContinuousOwnedCase(sessionId, 'failed');
    await expect(discardContinuousGeneratedAsmCase(failed.manifestUri.fsPath, sessionId))
      .resolves.toBe(false);
    expect(fs.existsSync(failed.dir.fsPath)).toBe(true);

    const terminalEvidence = makeContinuousOwnedCase(sessionId, 'generated');
    (terminalEvidence.manifest as AsmCaseManifestV2).metadata!['test.status'] = 'failed';
    fs.writeFileSync(terminalEvidence.manifestUri.fsPath, JSON.stringify(terminalEvidence.manifest));
    await expect(discardContinuousGeneratedAsmCase(terminalEvidence.manifestUri.fsPath, sessionId))
      .resolves.toBe(false);
    expect(fs.existsSync(terminalEvidence.dir.fsPath)).toBe(true);
  });

  it('serializes terminal outcome recording ahead of cleanup for the same case', async () => {
    const sessionId = '77777777-7777-4777-8777-777777777777';
    const asmCase = makeContinuousOwnedCase(sessionId, 'generated');

    const [recorded, discarded] = await Promise.all([
      recordAsmCaseTestOutcome(asmCase.manifestUri.fsPath, {
        status: 'failed',
        stage: 'compare',
        diagnostic: 'mismatch',
        continuous: { sessionId, state: 'failed' }
      }),
      discardContinuousGeneratedAsmCase(asmCase.manifestUri.fsPath, sessionId)
    ]);

    expect(recorded).toBeUndefined();
    expect(discarded).toBe(false);
    expect(fs.existsSync(asmCase.dir.fsPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(asmCase.manifestUri.fsPath, 'utf8')) as AsmCaseManifestV2;
    expect(manifest.metadata).toMatchObject({
      'continuous.state': 'failed',
      'test.status': 'failed',
      'test.stage': 'compare'
    });
  });

  it('prunes only session-owned cases with agreeing passed terminal evidence', async () => {
    const sessionId = '55555555-5555-4555-8555-555555555555';
    const passed = makeContinuousOwnedCase(sessionId, 'passed');
    (passed.manifest as AsmCaseManifestV2).metadata!['test.status'] = 'passed';
    fs.writeFileSync(passed.manifestUri.fsPath, JSON.stringify(passed.manifest));

    await expect(discardContinuousPassingAsmCase(passed.manifestUri.fsPath, sessionId))
      .resolves.toBe(true);
    expect(fs.existsSync(passed.dir.fsPath)).toBe(false);

    const failed = makeContinuousOwnedCase(sessionId, 'failed');
    (failed.manifest as AsmCaseManifestV2).metadata!['test.status'] = 'failed';
    fs.writeFileSync(failed.manifestUri.fsPath, JSON.stringify(failed.manifest));
    await expect(discardContinuousPassingAsmCase(failed.manifestUri.fsPath, sessionId))
      .resolves.toBe(false);
    expect(fs.existsSync(failed.dir.fsPath)).toBe(true);

    const disagreement = makeContinuousOwnedCase(sessionId, 'passed');
    (disagreement.manifest as AsmCaseManifestV2).metadata!['test.status'] = 'failed';
    fs.writeFileSync(disagreement.manifestUri.fsPath, JSON.stringify(disagreement.manifest));
    await expect(discardContinuousPassingAsmCase(disagreement.manifestUri.fsPath, sessionId))
      .resolves.toBe(false);
    expect(fs.existsSync(disagreement.dir.fsPath)).toBe(true);

    const manual = makeContinuousOwnedCase(sessionId, 'passed');
    (manual.manifest as AsmCaseManifestV2).source = { kind: 'selected' };
    (manual.manifest as AsmCaseManifestV2).metadata!['test.status'] = 'passed';
    fs.writeFileSync(manual.manifestUri.fsPath, JSON.stringify(manual.manifest));
    await expect(discardContinuousPassingAsmCase(manual.manifestUri.fsPath, sessionId))
      .resolves.toBe(false);
    expect(fs.existsSync(manual.dir.fsPath)).toBe(true);
  });

  it('refuses cleanup when the controlled trash directory is a link', async () => {
    const sessionId = '66666666-6666-4666-8666-666666666666';
    const asmCase = makeContinuousOwnedCase(sessionId, 'generated');
    const workspaceRoot = path.dirname(path.dirname(path.dirname(asmCase.dir.fsPath)));
    const externalTrash = path.join(workspaceRoot, 'external-trash');
    const trashDir = path.join(workspaceRoot, '.co', 'trash');
    fs.mkdirSync(externalTrash);
    fs.symlinkSync(externalTrash, trashDir, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(discardContinuousGeneratedAsmCase(asmCase.manifestUri.fsPath, sessionId))
      .resolves.toBe(false);
    expect(fs.existsSync(asmCase.dir.fsPath)).toBe(true);
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

  it('rejects a tampered oracle trace path before reading or chmod outside the case', async () => {
    const asmCase = createCase();
    makeSourceSnapshotValid(asmCase);
    const external = path.join(path.dirname(asmCase.dir.fsPath), 'external-oracle.out');
    const bytes = Buffer.from('@00003000: $ 1 <= 00000001\n');
    fs.writeFileSync(external, bytes, { mode: 0o644 });
    (asmCase.manifest as AsmCaseManifestV2).artifacts = {
      oracle: {
        traceOut: {
          path: '../external-oracle.out',
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.byteLength
        }
      }
    };

    await expect(recordAsmCaseOracleResult(
      asmCase,
      successfulExecuteResult(),
      {
        profile: 'P7', memoryConfiguration: 'CompactLargeText', courseTrace: true, traceOutput: true,
        traceLevel: 2, maxSteps: 64, haltPc: 0x3004
      },
      { stopReason: 'halt-loop' }
    )).rejects.toThrow(/must be copied inside the case directory/);
    expect(fs.readFileSync(external)).toEqual(bytes);
  });

  it('reads stdin only from the case-local manifest snapshot and rejects drift', async () => {
    const asmCase = createCase();
    const stdinDir = path.join(asmCase.dir.fsPath, 'stdin');
    const stdinFile = path.join(stdinDir, 'input.txt');
    const bytes = Buffer.from('sealed\n');
    fs.mkdirSync(stdinDir);
    fs.writeFileSync(stdinFile, bytes);
    asmCase.stdin = URI.file(stdinFile);
    (asmCase.manifest as AsmCaseManifestV2).stdin = {
      originalPath: path.join(path.dirname(asmCase.dir.fsPath), 'input.txt'),
      path: 'stdin/input.txt',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength
    };

    await expect(readAsmCaseStdinSnapshot(asmCase)).resolves.toBe('sealed\n');
    fs.writeFileSync(stdinFile, 'drift!\n');
    await expect(readAsmCaseStdinSnapshot(asmCase)).rejects.toThrow(/已偏离 case manifest/);
  });

  it('rejects caller configuration that differs from the provider resolved run', async () => {
    const asmCase = createCase();
    makeSourceSnapshotValid(asmCase);
    const traceDir = path.join(asmCase.dir.fsPath, 'mars');
    fs.mkdirSync(traceDir);
    const trace = path.join(traceDir, 'oracle.out');
    const bytes = Buffer.from('@00003000: $ 1 <= 00000001\n');
    fs.writeFileSync(trace, bytes);
    (asmCase.manifest as AsmCaseManifestV2).artifacts = {
      oracle: {
        traceOut: {
          path: 'mars/oracle.out',
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.byteLength
        }
      }
    };

    await expect(recordAsmCaseOracleResult(
      asmCase,
      successfulExecuteResult(),
      { profile: 'P7', memoryConfiguration: 'Default', traceLevel: 2 },
      { stopReason: 'halt-loop' }
    )).rejects.toThrow(/differs from executed/);
  });

  it('records builtin structured evidence instead of deriving full state from the text trace', async () => {
    const asmCase = createCase();
    makeSourceSnapshotValid(asmCase);
    const oracleDir = path.join(asmCase.dir.fsPath, 'oracle');
    fs.mkdirSync(oracleDir);
    const traceFile = path.join(oracleDir, 'builtin.out');
    const eventFile = path.join(oracleDir, 'builtin.out.events.json');
    fs.writeFileSync(traceFile, '');
    const eventDigest = sha256Canonical([] as CanonicalJson);
    const finalStateDigest = 'f'.repeat(64);
    const imageFingerprint = 'c'.repeat(64);
    (asmCase.manifest as AsmCaseManifestV2).program.imageFingerprint = imageFingerprint;
    const eventDocument = {
      schemaRevision: 1,
      eventSchema: 'buaa-co-commit-event-v1',
      engine: {
        id: 'builtin-ts', kind: 'executor', build: 'test',
        semanticsRevision: 1, capabilitiesRevision: 1
      },
      imageFingerprint,
      profile: 'P7',
      stop: { kind: 'halt-loop', haltPc: 0x3004 },
      status: 'halted',
      instructions: 7,
      eventCount: 0,
      eventDigest,
      finalStateDigest,
      events: []
    };
    fs.writeFileSync(eventFile, `${canonicalJson(eventDocument as CanonicalJson)}\n`);
    await updateAsmCaseArtifacts(asmCase, 'oracle', { traceOut: traceFile, events: eventFile });
    const artifact = builtinExecutionEngineArtifact();
    const result: ExecuteResult = {
      ok: true,
      descriptor: {
        id: 'builtin-ts', kind: 'executor', build: 'test',
        semanticsRevision: 1, capabilitiesRevision: 1
      },
      engineArtifact: artifact.identity,
      status: { ok: true, exitCode: null, stdout: '', stderr: '', timedOut: false },
      resolvedRun: {
        profile: 'P7', memoryConfiguration: 'course-contract-v1',
        runtime: { kind: 'builtin-ts' }, wallClockMs: 10, p7RiInstruction: false
      },
      trace: {
        schemaRevision: 1,
        eventSchema: 'buaa-co-architectural-write-v1',
        events: [],
        rawText: '',
        rawTraceRevision: 1
      },
      events: [],
      instructions: 7,
      eventCount: 0,
      eventDigest,
      finalStateDigest,
      eventArtifact: URI.file(eventFile),
      stop: { kind: 'halt-loop', haltPc: 0x3004 }
    };

    await recordAsmCaseOracleResult(asmCase, result, {
      profile: 'P7', memoryConfiguration: 'course-contract-v1', courseTrace: true,
      traceOutput: true, traceLevel: 1, maxSteps: 64, haltPc: 0x3004
    }, { stopReason: 'halt-loop' });

    const oracle = (asmCase.manifest as AsmCaseManifestV2).oracle;
    expect(oracle).toMatchObject({
      steps: 7,
      eventCount: 0,
      eventDigest,
      finalStateDigest
    });
    expect(oracle.engine.artifact).toEqual(artifact.identity);
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
      'traceOut',
      (snapshot) => ({
        'source.copyStage': 'oracle',
        'source.copySha256': snapshot.sha256
      })
    );

    expect(fs.readFileSync(copied.fsPath, 'utf8')).toBe('trace contents');
    expect((asmCase.manifest as AsmCaseManifestV2).artifacts?.oracle?.traceOut)
      .toMatchObject({ path: 'mars/oracle.out', bytes: 14 });
    expect((asmCase.manifest as AsmCaseManifestV2).metadata)
      .toMatchObject({
        'source.copyStage': 'oracle',
        'source.copySha256': crypto.createHash('sha256').update('trace contents').digest('hex')
      });
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

  it('rejects oversized sparse root, stdin, and artifact files before allocating their declared size', async () => {
    const asmCase = createCase();
    fs.writeFileSync(asmCase.asm.fsPath, '');
    fs.truncateSync(asmCase.asm.fsPath, maximumReplaySourceBytes + 1);
    await expect(asmCaseSourceSnapshotIssue(asmCase)).resolves.toMatch(/hard limit|有界读取/);

    const stdinDir = path.join(asmCase.dir.fsPath, 'stdin');
    const stdinFile = path.join(stdinDir, 'input.txt');
    fs.mkdirSync(stdinDir);
    fs.writeFileSync(stdinFile, '');
    asmCase.stdin = URI.file(stdinFile);
    (asmCase.manifest as AsmCaseManifestV2).stdin = {
      originalPath: 'captured-input.txt',
      path: 'stdin/input.txt',
      sha256: crypto.createHash('sha256').update('').digest('hex'),
      bytes: maximumReplayStdinBytes + 1
    };
    await expect(readAsmCaseStdinSnapshot(asmCase)).rejects.toThrow(/hard limit|有界读取/);

    const artifactDir = path.join(asmCase.dir.fsPath, 'verilog');
    const artifactFile = path.join(artifactDir, 'oversized.vcd');
    fs.mkdirSync(artifactDir);
    fs.writeFileSync(artifactFile, '');
    fs.truncateSync(artifactFile, maximumReplaySnapshotBytes + 1);
    await expect(updateAsmCaseArtifacts(asmCase, 'verilog', { vcd: artifactFile }))
      .rejects.toThrow(/hard limit/);
  });

  it('bounds an adjacent case manifest before JSON parsing', async () => {
    const asmCase = createCase();
    fs.writeFileSync(asmCase.asm.fsPath, 'nop\n');
    fs.writeFileSync(asmCase.manifestUri.fsPath, '');
    fs.truncateSync(asmCase.manifestUri.fsPath, maximumReplayManifestBytes + 1);

    await expect(readAsmCaseManifestForAsm(asmCase.asm)).resolves.toBeUndefined();
  });

  it('streams case discovery and rejects an excessive directory count', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-asm-case-index-'));
    temporaryRoots.push(root);
    const casesDir = path.join(root, '.co', 'cases');
    fs.mkdirSync(casesDir, { recursive: true });
    vscodeState.state!.workspaceFolders.push({ uri: URI.file(root), name: 'test' });
    const entries = Array.from({ length: maximumAsmCaseIndexEntries + 1 }, (_, index) => ({
      name: `case-${index}`,
      isDirectory: () => true
    })) as fs.Dirent[];
    vi.spyOn(fs.promises, 'opendir').mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield* entries;
      }
    } as fs.Dir);

    await expect(listAsmCaseManifests()).rejects.toThrow(/entry limit/);
  });

  it('rejects excessive aggregate case-manifest bytes without retaining parsed manifests', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-asm-case-index-bytes-'));
    temporaryRoots.push(root);
    const casesDir = path.join(root, '.co', 'cases');
    fs.mkdirSync(casesDir, { recursive: true });
    vscodeState.state!.workspaceFolders.push({ uri: URI.file(root), name: 'test' });
    const perManifestBytes = maximumReplayManifestBytes;
    const count = Math.floor(maximumAsmCaseIndexManifestBytes / perManifestBytes) + 1;
    const padding = Buffer.alloc(perManifestBytes - 2, 0x20);
    for (let index = 0; index < count; index += 1) {
      const caseDir = path.join(casesDir, `case-${index}`);
      fs.mkdirSync(caseDir);
      const manifest = path.join(caseDir, 'case.json');
      fs.writeFileSync(manifest, '[]');
      fs.appendFileSync(manifest, padding);
    }

    await expect(listAsmCaseManifests()).rejects.toThrow(/manifest bytes/);
  });
});

function makeContinuousOwnedCase(
  sessionId: string,
  state: 'generated' | 'cancelled' | 'passed' | 'failed' | 'error'
): AsmCase {
  const asmCase = createCase();
  const manifest = asmCase.manifest as AsmCaseManifestV2;
  manifest.source = {
    kind: 'builtin',
    generator: 'builtin:random-asm'
  };
  manifest.metadata = {
    'continuous.sessionId': sessionId,
    'continuous.iteration': '1',
    'continuous.state': state
  };
  fs.writeFileSync(asmCase.manifestUri.fsPath, `${JSON.stringify(manifest)}\n`);
  const workspaceRoot = path.dirname(path.dirname(path.dirname(asmCase.dir.fsPath)));
  vscodeState.state!.workspaceFolders.push({ uri: URI.file(workspaceRoot), name: 'test' });
  return asmCase;
}

function makeSourceSnapshotValid(asmCase: AsmCase): void {
  const bytes = Buffer.from('.text\nnop\n');
  fs.writeFileSync(asmCase.asm.fsPath, bytes);
  (asmCase.manifest as AsmCaseManifestV2).asmSnapshot = {
    path: 'program.asm',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength
  };
}

function successfulExecuteResult(): ExecuteResult {
  return {
    ok: true,
    descriptor: {
      id: 'legacy-mars-configured', kind: 'full-stack', build: 'test',
      semanticsRevision: 1, capabilitiesRevision: 1
    },
    status: {
      ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false,
      commandLine: 'java -jar Mars.jar', cwd: 'case'
    },
    resolvedRun: {
      profile: 'P7',
      memoryConfiguration: 'CompactLargeText',
      runtime: { kind: 'java', command: 'java' },
      wallClockMs: 10_000,
      p7RiInstruction: false
    }
  };
}
