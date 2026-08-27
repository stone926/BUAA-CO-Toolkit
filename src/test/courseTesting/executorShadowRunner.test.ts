import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

vi.mock('vscode', () => ({
  Uri: URI
}));

vi.mock('../../mips/providers/providerResolver', () => ({
  resolveBuiltinExecutionProvider: vi.fn(),
  preflightFailureMessage: vi.fn((preflight: { diagnostics: Array<{ code: string; message: string }> }) =>
    preflight.diagnostics.map((item) => `[${item.code}] ${item.message}`).join('\n'))
}));

import { runExecutorShadow, writeExecutorShadowBundle } from '../../courseTesting/executorShadowRunner';
import { resolveBuiltinExecutionProvider } from '../../mips/providers/providerResolver';
import { compareExecutorShadow } from '../../courseTesting/oracle/differentialRunner';
import { buildProgramImage } from '../../mips/core/programImage';
import { sourceUnitFingerprint } from '../../mips/core/programImage';
import { BUILTIN_TS_DESCRIPTOR, LEGACY_MARS_DESCRIPTOR, type ExecuteResult } from '../../mips/providers/contracts';
import type { AsmCase } from '../../asmCaseStore';
import type { CpuTraceEvent } from '../../language/mips/traceParser';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-shadow-test-'));
const mockedResolve = vi.mocked(resolveBuiltinExecutionProvider);

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function traceEvent(pc: string, target: string, value: string): CpuTraceEvent {
  return { pc, kind: 'grf', target, value, raw: `@${pc}: $${target} <= ${value}`, lineNumber: 1 };
}

function image() {
  return buildProgramImage({
    entryPc: 0x3000,
    segments: [{ name: 'text', baseAddress: 0x3000, words: [0x3408002a, 0x1000ffff, 0x00000000] }],
    inputGraph: [sourceUnitFingerprint({ id: 'root.asm', text: 'fixture' })]
  });
}

function legacyResult(): ExecuteResult {
  return {
    ok: true,
    outputFile: URI.file('/tmp/legacy.out'),
    status: { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false },
    descriptor: LEGACY_MARS_DESCRIPTOR,
    trace: {
      schemaRevision: 1,
      eventSchema: 'buaa-co-architectural-write-v1',
      events: [traceEvent('00003000', '8', '0000002A')],
      rawText: '@00003000: $8 <= 0000002A\n',
      rawTraceRevision: 1
    },
    stop: { kind: 'halt-loop', haltPc: 0x3004 }
  };
}

function builtinResult(events = [traceEvent('00003000', '8', '0000002A')]): ExecuteResult {
  return {
    ok: true,
    status: { ok: true, exitCode: null, stdout: '', stderr: '', timedOut: false },
    descriptor: BUILTIN_TS_DESCRIPTOR,
    trace: {
      schemaRevision: 1,
      eventSchema: 'buaa-co-architectural-write-v1',
      events,
      rawText: events.map((event) => event.raw).join('\n') + '\n',
      rawTraceRevision: 1
    },
    stop: { kind: 'halt-loop', haltPc: 0x3004 },
    eventDigest: 'builtin-events',
    finalStateDigest: 'builtin-final'
  };
}

function asmCase(): AsmCase {
  const dir = path.join(root, 'cases', 'case-1');
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  const sourceText = 'fixture';
  fs.writeFileSync(path.join(dir, 'source', 'root.asm'), sourceText);
  return {
    id: 'case-1',
    dir: URI.file(dir),
    manifestUri: URI.file(path.join(dir, 'case.json')),
    asm: URI.file('/workspace/root.asm'),
    machineCode: URI.file(path.join(dir, 'code.txt')),
    sourceAsm: URI.file(path.join(dir, 'source', 'root.asm')),
    manifest: {
      version: 2,
      artifacts: {
        source: {
          'root.asm': {
            path: 'source/root.asm',
            sha256: sha256(sourceText),
            bytes: Buffer.byteLength(sourceText)
          }
        }
      }
    } as AsmCase['manifest']
  };
}

describe('executor shadow runner', () => {
  it('passes when the two projected traces match and writes no bundle', async () => {
    mockedResolve.mockResolvedValue({
      provider: { execute: vi.fn(async () => builtinResult()) },
      preflight: { ok: true, diagnostics: [], descriptor: BUILTIN_TS_DESCRIPTOR }
    } as never);
    const outcome = await runExecutorShadow(
      { output: { appendLine: vi.fn() } as never, statusBar: {} as never },
      asmCase(),
      {
        profile: 'P5',
        image: image(),
        maxSteps: 64,
        haltPc: 0x3004,
        legacy: legacyResult(),
        outputRoot: path.join(root, 'shadow')
      }
    );
    expect(outcome.status).toBe('matched');
    expect(outcome.bundleDir).toBeUndefined();
    expect(outcome.builtinResult?.stop?.kind).toBe('halt-loop');
  });

  it('saves a complete reproduction bundle for an inconclusive mismatch', async () => {
    mockedResolve.mockResolvedValue({
      provider: { execute: vi.fn(async () => builtinResult([traceEvent('00003000', '8', '0000002B')])) },
      preflight: { ok: true, diagnostics: [], descriptor: BUILTIN_TS_DESCRIPTOR }
    } as never);
    const caseValue = asmCase();
    const outcome = await runExecutorShadow(
      { output: { appendLine: vi.fn() } as never, statusBar: {} as never },
      caseValue,
      {
        profile: 'P5',
        image: image(),
        maxSteps: 64,
        haltPc: 0x3004,
        legacy: legacyResult(),
        outputRoot: path.join(root, 'shadow')
      }
    );
    expect(outcome.status).toBe('inconclusive');
    expect(outcome.bundleDir).toBeDefined();
    expect(fs.existsSync(path.join(outcome.bundleDir!, 'shadow-result.json'))).toBe(true);
    expect(fs.existsSync(path.join(outcome.bundleDir!, 'program-image.json'))).toBe(true);
    expect(fs.existsSync(path.join(outcome.bundleDir!, 'legacy-trace.out'))).toBe(true);
    expect(fs.existsSync(path.join(outcome.bundleDir!, 'builtin-trace.out'))).toBe(true);
    expect(fs.existsSync(path.join(outcome.bundleDir!, 'case-source', 'source', 'root.asm'))).toBe(true);
    const result = JSON.parse(fs.readFileSync(path.join(outcome.bundleDir!, 'shadow-result.json'), 'utf8'));
    expect(result.kind).toBe('executor-shadow');
    expect(result.differential.disposition).toBe('inconclusive');
    expect(result.contracts.length).toBeGreaterThan(0);
  });

  it('is not comparable when builtin preflight fails', async () => {
    mockedResolve.mockResolvedValue({
      preflight: {
        ok: false,
        diagnostics: [{ code: 'builtin-ts.stdin-unsupported', message: 'stdin unsupported' }],
        descriptor: BUILTIN_TS_DESCRIPTOR
      }
    } as never);
    const outcome = await runExecutorShadow(
      { output: { appendLine: vi.fn() } as never, statusBar: {} as never },
      asmCase(),
      {
        profile: 'P5',
        image: image(),
        maxSteps: 64,
        haltPc: 0x3004,
        legacy: legacyResult(),
        outputRoot: path.join(root, 'shadow')
      }
    );
    expect(outcome.status).toBe('not-comparable');
    expect(outcome.bundleDir).toBeUndefined();
  });
});
