import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({
  Uri: URI
}));

vi.mock('../../mips/providers/fixedMarsReference', () => ({
  fixedMarsCourseExecutorRole: 'legacy-course-executor',
  verifyConfiguredFixedMarsReference: vi.fn()
}));

import type { AsmCase } from '../../asmCaseStore';
import type { AppServices } from '../../types';
import type { CpuTraceEvent } from '../../language/mips/traceParser';
import { runFullStackShadow } from '../../courseTesting/fullStackShadowRunner';
import { isManifestV2 } from '../../courseTesting/manifestCodec';
import { buildProgramImage } from '../../mips/core/programImage';
import type { ProgramImage, SourceUnitFingerprint } from '../../mips/core/api';
import { wordsToHexText } from '../../mips/core/assembler/artifacts';
import {
  BUILTIN_TS_DESCRIPTOR,
  LEGACY_MARS_CAPABILITIES,
  LEGACY_MARS_DESCRIPTOR,
  type AssembleRequest,
  type AssembleResult,
  type ExecuteRequest,
  type ExecuteResult,
  type MipsAssemblerProvider,
  type MipsExecutionProvider
} from '../../mips/providers/contracts';
import {
  setProviderRegistry
} from '../../mips/providers/providerResolver';
import { verifyConfiguredFixedMarsReference } from '../../mips/providers/fixedMarsReference';
import {
  captureSourceGraph,
  type CapturedSourceBundle
} from '../../mips/replay/sourceBundle';

const fixedSha256 = 'a'.repeat(64);
const otherSha256 = 'b'.repeat(64);
const defaultWords = [0x3408_002a, 0x1000_ffff, 0x0000_0000] as const;
const mockedVerifyFixed = vi.mocked(verifyConfiguredFixedMarsReference);

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-full-stack-shadow-'));
  mockedVerifyFixed.mockReset();
  mockedVerifyFixed.mockResolvedValue(verifiedFixed(fixedSha256));
});

afterEach(() => {
  setProviderRegistry(undefined);
  vi.clearAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('full-stack shadow runner', () => {
  it('retains matched full-stack evidence from two independently assembled images', async () => {
    const fixture = await createFixture();
    const providers = installProviders();

    const outcome = await runFixture(fixture);

    expect(outcome.status).toBe('matched');
    expect(outcome.evidenceKind).toBe('full-stack');
    expect(outcome.assembly.matched).toBe(true);
    expect(providers.execute).toHaveBeenCalledOnce();
    expect(fs.existsSync(outcome.resultFile)).toBe(true);
    expect(fs.existsSync(path.join(outcome.bundleDir, 'builtin-program-image.json'))).toBe(true);
    expect(fs.existsSync(path.join(outcome.bundleDir, 'legacy-program-image.json'))).toBe(true);
    expect(fs.existsSync(path.join(outcome.bundleDir, 'case-source', 'program.asm'))).toBe(true);
    expect(fs.existsSync(path.join(outcome.bundleDir, 'case-source', 'source', 'graph.json'))).toBe(true);
    const evidence = JSON.parse(fs.readFileSync(outcome.resultFile, 'utf8'));
    expect(evidence).toMatchObject({
      kind: 'course-full-stack-shadow',
      evidenceKind: 'full-stack',
      status: 'matched'
    });
    expect(evidence.input.builtinImageFingerprint).toBe(fixture.image.fingerprint);
    expect(evidence.input.legacyImageFingerprint).toBe(fixture.image.fingerprint);
    expect(fs.readdirSync(path.dirname(outcome.bundleDir)).some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('retains an inconclusive bundle for an unregistered assembly image mismatch', async () => {
    const fixture = await createFixture();
    const providers = installProviders({ legacyWords: [0x3408_002b, ...defaultWords.slice(1)] });

    const outcome = await runFixture(fixture);

    expect(outcome.status).toBe('inconclusive');
    expect(outcome.assembly).toMatchObject({
      matched: false,
      disposition: 'inconclusive',
      firstDiffIndex: 0
    });
    expect(providers.execute).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(outcome.bundleDir, 'full-stack-result.json'))).toBe(true);
  });

  it('rejects a legacy dump that disagrees with the independently returned ProgramImage', async () => {
    const fixture = await createFixture();
    const providers = installProviders({ legacyDumpWords: [0x3408_002b, ...defaultWords.slice(1)] });

    const outcome = await runFixture(fixture);

    expect(outcome.status).toBe('inconclusive');
    expect(outcome.assembly.message).toContain('HexText 与其 ProgramImage 不一致');
    expect(providers.execute).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(outcome.bundleDir, 'legacy-program-image.json'))).toBe(true);
  });

  it('classifies only a diagnostic-backed raw .word rejection as registered course-correct', async () => {
    const fixture = await createFixture('.text\n.word 0x12345678\nbeq $0,$0,-1\nnop\n');
    installProviders({
      assemblyFailure: '".word" directive cannot appear in text segment'
    });

    const outcome = await runFixture(fixture);

    expect(outcome.status).toBe('course-correct');
    expect(outcome.assembly).toMatchObject({
      matched: false,
      disposition: 'course-correct',
      contractId: 'MARS-DIV-RAW-TEXT-WORD-001'
    });
    expect(fs.existsSync(outcome.resultFile)).toBe(true);
  });

  it('recognizes only the exact 4096-to-4095 compact boundary, including a trailing zero word', async () => {
    const fixture = await createFixture(
      '.text\nbeq $0,$0,-1\nnop\n',
      [...Array.from({ length: 4095 }, () => 0x0000_0001), 0x0000_0000]
    );
    installProviders({ legacyWords: Array.from({ length: 4095 }, () => 0x0000_0001) });

    const outcome = await runFixture(fixture);

    expect(outcome.status).toBe('course-correct');
    expect(outcome.assembly).toMatchObject({
      matched: false,
      builtinWords: 4096,
      legacyWords: 4095,
      firstDiffIndex: 4095,
      builtinWord: 0,
      contractId: 'MARS-DIV-COMPACT-001'
    });
    expect(outcome.assembly).not.toHaveProperty('legacyWord');
  });

  it('retains an inconclusive full-stack bundle for a legacy execution difference', async () => {
    const fixture = await createFixture();
    installProviders({ legacyTraceValue: '0000002B' });

    const outcome = await runFixture(fixture);

    expect(outcome.status).toBe('inconclusive');
    expect(outcome.execution).toMatchObject({ matched: false, disposition: 'inconclusive' });
    expect(fs.existsSync(path.join(outcome.bundleDir, 'legacy-trace.out'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(outcome.resultFile, 'utf8')).status).toBe('inconclusive');
  });

  it('fails closed with a retained bundle when the fixed MARS hash changes after assembly', async () => {
    const fixture = await createFixture();
    const providers = installProviders();
    mockedVerifyFixed
      .mockResolvedValueOnce(verifiedFixed(fixedSha256))
      .mockResolvedValueOnce(verifiedFixed(otherSha256));

    const outcome = await runFixture(fixture);

    expect(outcome.status).toBe('inconclusive');
    expect(outcome.assembly.contractId).toBeUndefined();
    expect(outcome.message).toContain('SHA-256 身份变化');
    expect(providers.execute).not.toHaveBeenCalled();
    expect(fs.existsSync(outcome.resultFile)).toBe(true);
  });

  it('does not turn a cancelled raw-word assembly into a registered divergence', async () => {
    const fixture = await createFixture('.text\n.word 0x12345678\n');
    installProviders({
      assemblyFailure: '".word" directive cannot appear in text segment',
      assemblyCancelled: true
    });

    const outcome = await runFixture(fixture);

    expect(outcome.status).toBe('not-comparable');
    expect(outcome.assembly.contractId).toBeUndefined();
    expect(fs.existsSync(outcome.resultFile)).toBe(true);
  });

  it('rejects a source artifact that escapes the v2 closure and removes the temporary bundle', async () => {
    const fixture = await createFixture();
    const providers = installProviders();
    if (!isManifestV2(fixture.asmCase.manifest)) throw new Error('test fixture must be v2');
    fixture.asmCase.manifest.artifacts!.source!.escape = {
      path: '../escape.asm',
      sha256: 'c'.repeat(64),
      bytes: 1
    };
    const outputRoot = path.join(root, 'shadow-containment');

    await expect(runFixture(fixture, outputRoot)).rejects.toThrow(/not safe and case-relative/);

    expect(providers.assemble).not.toHaveBeenCalled();
    expect(fs.existsSync(outputRoot)).toBe(true);
    expect(fs.readdirSync(outputRoot)).toEqual([]);
  });
});

interface Fixture {
  readonly asmCase: AsmCase;
  readonly capture: CapturedSourceBundle;
  readonly image: ProgramImage;
}

async function createFixture(
  sourceText = '.text\nori $8,$0,42\nbeq $0,$0,-1\nnop\n',
  words: readonly number[] = defaultWords
): Promise<Fixture> {
  const caseDir = path.join(root, `case-${crypto.randomUUID()}`);
  await fs.promises.mkdir(caseDir, { recursive: true });
  const programFile = path.join(caseDir, 'program.asm');
  const sourceBytes = Buffer.from(sourceText, 'utf8');
  await fs.promises.writeFile(programFile, sourceBytes);
  const capture = await captureSourceGraph(
    programFile,
    caseDir,
    sourceBytes,
    undefined,
    { allowedRoot: caseDir }
  );
  const graphSnapshot = snapshot(caseDir, capture.graphPath);
  const sourceArtifacts: Record<string, ReturnType<typeof snapshot>> = {
    graph: graphSnapshot
  };
  for (const unit of capture.graph.units) {
    sourceArtifacts[`blob/${unit.contentHash}`] = {
      path: unit.blobPath,
      sha256: unit.contentHash,
      bytes: unit.bytes
    };
    sourceArtifacts[`materialized/${unit.id}`] = snapshot(
      caseDir,
      path.join(caseDir, ...unit.materializedPath.split('/'))
    );
  }
  const asmSnapshot = snapshot(caseDir, programFile);
  const image = programImage(words, capture.inputGraph);
  const caseId = path.basename(caseDir);
  const asmCase: AsmCase = {
    id: caseId,
    dir: URI.file(caseDir),
    manifestUri: URI.file(path.join(caseDir, 'case.json')),
    asm: URI.file(programFile),
    machineCode: URI.file(path.join(caseDir, 'code.txt')),
    sourceAsm: URI.file(capture.rootMaterializedPath),
    manifest: {
      version: 2,
      caseId,
      createdAt: '2026-08-29T00:00:00.000Z',
      profile: 'P5',
      originalAsmPath: programFile,
      asmSnapshot,
      source: { kind: 'selected' },
      program: {
        assembler: manifestEngine(BUILTIN_TS_DESCRIPTOR),
        imageFingerprint: image.fingerprint,
        sourceGraph: graphSnapshot
      },
      oracle: {
        engine: manifestEngine(BUILTIN_TS_DESCRIPTOR),
        configurationHash: 'fixture',
        stopReason: 'halt-loop'
      },
      artifacts: { source: sourceArtifacts }
    }
  };
  return { asmCase, capture, image };
}

interface ProviderScenario {
  readonly legacyWords?: readonly number[];
  readonly legacyDumpWords?: readonly number[];
  readonly assemblyFailure?: string;
  readonly assemblyCancelled?: boolean;
  readonly legacyTraceValue?: string;
}

function installProviders(scenario: ProviderScenario = {}): {
  readonly assemble: ReturnType<typeof vi.fn>;
  readonly execute: ReturnType<typeof vi.fn>;
} {
  const assemble = vi.fn(async (request: AssembleRequest): Promise<AssembleResult> => {
    const failure = scenario.assemblyFailure;
    if (failure) {
      return {
        ok: false,
        status: {
          ok: false,
          exitCode: scenario.assemblyCancelled ? null : 1,
          stdout: '',
          stderr: failure,
          timedOut: false,
          ...(scenario.assemblyCancelled
            ? { stopped: true, stopReason: 'cancelled' }
            : { stopReason: 'engine-error' })
        },
        descriptor: LEGACY_MARS_DESCRIPTOR,
        engineArtifact: legacyArtifact()
      };
    }
    const words = [...(scenario.legacyWords ?? defaultWords)];
    const image = programImage(words, request.inputGraph ?? []);
    if (!request.target.outputFile) throw new Error('test provider requires outputFile');
    await fs.promises.writeFile(
      request.target.outputFile.fsPath,
      wordsToHexText(scenario.legacyDumpWords ?? words),
      'utf8'
    );
    // Prove the provider received an isolated source closure, not asmCase.sourceAsm.
    expect(request.sourceUri.fsPath).toContain(`${path.sep}legacy-source${path.sep}`);
    expect(await fs.promises.readFile(request.sourceUri.fsPath, 'utf8')).toContain('.text');
    return {
      ok: true,
      outputFile: request.target.outputFile,
      courseHaltPc: 0x3004,
      status: successfulStatus(),
      descriptor: LEGACY_MARS_DESCRIPTOR,
      engineArtifact: legacyArtifact(),
      image,
      executionBinding: {
        kind: 'source-reassembly',
        providerId: LEGACY_MARS_DESCRIPTOR.id,
        sourceUri: request.sourceUri,
        imageFingerprint: image.fingerprint
      }
    };
  });
  const execute = vi.fn(async (request: ExecuteRequest): Promise<ExecuteResult> => {
    expect(request.executionBinding?.imageFingerprint).toBe(request.image.fingerprint);
    const event = traceEvent(scenario.legacyTraceValue ?? '0000002A');
    return {
      ok: true,
      outputFile: request.runOutputFile,
      status: successfulStatus(),
      descriptor: LEGACY_MARS_DESCRIPTOR,
      engineArtifact: legacyArtifact(),
      trace: {
        schemaRevision: 1,
        eventSchema: 'buaa-co-architectural-write-v1',
        events: [event],
        rawText: `${event.raw}\n`,
        rawTraceRevision: 1
      },
      stop: { kind: 'halt-loop', haltPc: 0x3004 }
    };
  });
  const assemblerProvider: MipsAssemblerProvider = {
    descriptor: LEGACY_MARS_DESCRIPTOR,
    capabilities: LEGACY_MARS_CAPABILITIES,
    preflight: vi.fn(async () => ({
      ok: true,
      diagnostics: [],
      descriptor: LEGACY_MARS_DESCRIPTOR
    })),
    assemble
  };
  const executionProvider: MipsExecutionProvider = {
    descriptor: LEGACY_MARS_DESCRIPTOR,
    capabilities: LEGACY_MARS_CAPABILITIES,
    preflight: vi.fn(async () => ({
      ok: true,
      diagnostics: [],
      descriptor: LEGACY_MARS_DESCRIPTOR
    })),
    execute
  };
  setProviderRegistry({
    assemblerProviders: [assemblerProvider],
    executionProviders: [executionProvider]
  });
  return { assemble, execute };
}

async function runFixture(fixture: Fixture, outputRoot = path.join(root, 'shadow')) {
  return runFullStackShadow(services(), fixture.asmCase, {
    profile: 'P5',
    builtinAssembly: builtinAssembly(fixture.image),
    builtinExecution: builtinExecution(),
    maxSteps: 64,
    haltPc: 0x3004,
    outputRoot,
    expectedLegacySha256: fixedSha256,
    now: new Date('2026-08-29T00:00:00.000Z')
  });
}

function builtinAssembly(image: ProgramImage): AssembleResult {
  return {
    ok: true,
    status: successfulStatus(),
    descriptor: BUILTIN_TS_DESCRIPTOR,
    image
  };
}

function builtinExecution(): ExecuteResult {
  const event = traceEvent('0000002A');
  return {
    ok: true,
    status: successfulStatus(),
    descriptor: BUILTIN_TS_DESCRIPTOR,
    trace: {
      schemaRevision: 1,
      eventSchema: 'buaa-co-architectural-write-v1',
      events: [event],
      rawText: `${event.raw}\n`,
      rawTraceRevision: 1
    },
    stop: { kind: 'halt-loop', haltPc: 0x3004 }
  };
}

function programImage(words: readonly number[], inputGraph: readonly SourceUnitFingerprint[]): ProgramImage {
  return buildProgramImage({
    entryPc: 0x3000,
    segments: [{ name: 'text', baseAddress: 0x3000, words }],
    inputGraph
  });
}

function traceEvent(value: string): CpuTraceEvent {
  return {
    pc: '00003000',
    kind: 'grf',
    target: '8',
    value,
    raw: `@00003000: $8 <= ${value}`,
    lineNumber: 1
  };
}

function successfulStatus() {
  return { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false };
}

function legacyArtifact() {
  return { sha256: fixedSha256, role: 'user-configured-mars' };
}

function verifiedFixed(sha256: string) {
  return {
    ok: true as const,
    path: path.join(root, 'Mars.jar'),
    identity: { sha256, role: 'legacy-course-executor' },
    bytes: 1,
    authority: 'test',
    trustRevision: 'test'
  };
}

function snapshot(caseDir: string, file: string) {
  const bytes = fs.readFileSync(file);
  return {
    path: path.relative(caseDir, file).split(path.sep).join('/'),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength
  };
}

function manifestEngine(descriptor: typeof BUILTIN_TS_DESCRIPTOR) {
  return {
    id: descriptor.id,
    build: descriptor.build,
    semanticsRevision: descriptor.semanticsRevision,
    capabilitiesRevision: descriptor.capabilitiesRevision
  };
}

function services(): AppServices {
  return {
    output: { appendLine: vi.fn() } as never,
    statusBar: {} as never
  };
}
