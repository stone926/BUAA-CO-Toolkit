import { assert, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

vi.mock('vscode', () => ({
  Uri: URI
}));

import { BuiltinTsExecutionProvider, type BuiltinWorkerRuntime } from '../../mips/providers/builtinExecutionProvider';
import { ExecutionAssertionObserver } from '../../courseTesting/oracle/executionAssertions';
import { buildProgramImage } from '../../mips/core/programImage';
import { sourceUnitFingerprint } from '../../mips/core/programImage';
import type { ExecuteRequest } from '../../mips/providers/contracts';

function image(words: number[]): ReturnType<typeof buildProgramImage> {
  return buildProgramImage({
    entryPc: 0x3000,
    segments: [{ name: 'text', baseAddress: 0x3000, words }],
    inputGraph: [sourceUnitFingerprint({ id: 'fixture.asm', text: 'fixture' })]
  });
}

function request(overrides: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return {
    profile: 'P5',
    image: image([0x3408002a, 0x1000ffff, 0x00000000]),
    trace: { kind: 'architectural-writes', courseCorrect: true },
    maxSteps: 64,
    haltPc: 0x3004,
    courseTrace: true,
    ...overrides
  };
}

describe('BuiltinTsExecutionProvider', () => {
  it('passes preflight for a pinned legacy ProgramImage', async () => {
    const provider = new BuiltinTsExecutionProvider();
    const preflight = await provider.preflight(request());
    expect(preflight.ok).toBe(true);
    expect(preflight.descriptor.id).toBe('builtin-ts');
    expect(preflight.descriptor.kind).toBe('executor');
  });

  it('executes the P5 course halt loop deterministically', async () => {
    const provider = new BuiltinTsExecutionProvider();
    const first = await provider.execute(request());
    const second = await provider.execute(request());

    expect(first.ok).toBe(true);
    expect(first.stop).toMatchObject({ kind: 'halt-loop', haltPc: 0x3004 });
    expect(first.trace?.events).toHaveLength(1);
    expect(first.trace?.events[0]).toMatchObject({ kind: 'grf', target: '8', value: '0000002A' });
    expect(first.finalStateDigest).toBe(second.finalStateDigest);
    expect(first.eventDigest).toBe(second.eventDigest);
    expect(first.eventCount).toBe(second.eventCount);
    expect(first.coverage?.some((bin) => bin.id.endsWith('.ori') && bin.hits === 1)).toBe(true);
  });

  it('streams the production provider event path into assertion/watchpoint observers', async () => {
    const observer = new ExecutionAssertionObserver(
      [{ id: 'gpr8', kind: 'gpr-write', register: 8 }],
      [
        { id: 'no-trap', kind: 'no-trap' },
        { id: 'halt', kind: 'halt-pc', haltPc: 0x3004 }
      ]
    );
    const result = await new BuiltinTsExecutionProvider().execute(request(), {
      onCommitEvent: (commitEvent) => observer.observe(commitEvent)
    });
    const observation = observer.finish();

    expect(result.ok).toBe(true);
    expect(observation.watchpointHits).toHaveLength(1);
    expect(observation.watchpointHits[0]).toMatchObject({ watchpointId: 'gpr8', sequence: 0 });
    expect(observation.assertionFailures).toEqual([]);
  });

  it('writes raw trace and canonical structured event artifacts atomically', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-builtin-provider-'));
    const outputFile = URI.file(path.join(dir, 'oracle.out'));
    const result = await new BuiltinTsExecutionProvider().execute(request({ runOutputFile: outputFile }));

    expect(result.outputFile?.fsPath).toBe(outputFile.fsPath);
    expect(result.eventArtifact?.fsPath).toBe(`${outputFile.fsPath}.events.json`);
    const trace = fs.readFileSync(outputFile.fsPath, 'utf8');
    expect(trace).toContain('@00003000: $8 <= 0000002A');
    const events = JSON.parse(fs.readFileSync(result.eventArtifact!.fsPath, 'utf8'));
    expect(events.eventSchema).toBe('buaa-co-commit-event-v1');
    assert.isDefined(result.eventCount);
    expect(events.events).toHaveLength(result.eventCount);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects stdin and non-course trace requests during preflight', async () => {
    const provider = new BuiltinTsExecutionProvider();
    const stdin = await provider.preflight(request({ stdin: '42' }));
    expect(stdin.ok).toBe(false);
    expect(stdin.diagnostics.some((item) => item.code === 'builtin-ts.stdin-unsupported')).toBe(true);

    const invalidTraceRequest = request();
    // Exercise the runtime guard for an input that cannot be constructed through the typed API.
    Reflect.set(invalidTraceRequest, 'trace', { kind: 'architectural-writes', courseCorrect: false });
    const trace = await provider.preflight(invalidTraceRequest);
    expect(trace.ok).toBe(false);
    expect(trace.diagnostics.some((item) => item.code === 'builtin-ts.course-trace-required')).toBe(true);
  });

  it('honours a pre-aborted session signal without committing an instruction', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await new BuiltinTsExecutionProvider().execute(request(), { signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(result.stop?.kind).toBe('cancelled');
    expect(result.status).toMatchObject({ stopped: true, stopReason: 'cancelled' });
    expect(result.eventCount).toBe(0);
  });

  it('routes execution through the worker and reconstructs the streamed commit events', async () => {
    const workerEvent = {
      sequence: 0,
      kind: 'instruction',
      pcBefore: 0x3000,
      pcAfter: 0x3004,
      gprWrites: [{ register: 8, value: 0x2a }],
      hiLoWrites: [],
      cp0Writes: [],
      memoryWrites: [],
      deviceEvents: [],
      mnemonic: 'ori'
    };
    const runJob = vi.fn<BuiltinWorkerRuntime['runJob']>(async (_job, options) => {
      await options?.onProgress?.([workerEvent]);
      return {
        protocolVersion: 2,
        kind: 'result',
        requestId: 'req-0',
        ok: true,
        payload: {
          status: 'halted',
          haltReason: 'course-halt-loop',
          haltPc: '0x00003004',
          instructions: 3,
          eventCount: 3,
          finalStateDigest: 'a'.repeat(64),
          trace: ['@00003000: $8 <= 0000002A'],
          coverage: [],
          checkpoints: []
        }
      };
    });
    const onCommitEvent = vi.fn();
    const result = await new BuiltinTsExecutionProvider({ runJob }).execute(request(), { onCommitEvent });
    expect(runJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'machine-execute' }),
      expect.objectContaining({ signal: undefined })
    );
    expect(result.ok).toBe(true);
    expect(result.trace?.events).toHaveLength(1);
    expect(result.events).toHaveLength(1);
    expect(result.events?.[0].mnemonic).toBe('ori');
    expect(onCommitEvent).toHaveBeenCalledWith(workerEvent);
    expect(result.eventDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.stop?.kind).toBe('halt-loop');
  });

  it('normalizes worker cancellation to a stopped provider result', async () => {
    const runJob = vi.fn<BuiltinWorkerRuntime['runJob']>(async () => ({
      protocolVersion: 2,
      kind: 'result',
      requestId: 'req-cancel',
      ok: false,
      error: 'cancelled',
      cancelled: true
    }));

    const result = await new BuiltinTsExecutionProvider({ runJob }).execute(request());
    expect(result).toMatchObject({
      ok: false,
      status: { stopped: true, stopReason: 'cancelled' },
      stop: { kind: 'cancelled' }
    });
  });

  it('does not treat a cancelled worker execution payload as a successful halt', async () => {
    const runJob = vi.fn<BuiltinWorkerRuntime['runJob']>(async () => ({
      protocolVersion: 2,
      kind: 'result',
      requestId: 'req-cancel-payload',
      ok: true,
      payload: {
        status: 'halted',
        haltReason: 'cancelled',
        instructions: 0,
        eventCount: 0,
        finalStateDigest: 'a'.repeat(64),
        trace: [],
        coverage: [],
        checkpoints: []
      }
    }));

    const result = await new BuiltinTsExecutionProvider({ runJob }).execute(request());
    expect(result).toMatchObject({
      ok: false,
      status: { stopped: true, stopReason: 'cancelled' },
      stop: { kind: 'cancelled' }
    });
  });

  it('marks an unmapped instruction fetch as out-of-domain instead of fabricating AdEL', async () => {
    const invalid = image([0xffffffff, 0x1000ffff, 0x00000000]);
    const result = await new BuiltinTsExecutionProvider().execute(request({
      image: invalid,
      haltPc: 0x3004
    }));
    expect(result.ok).toBe(false);
    expect(result.stop?.kind).toBe('out-of-domain');
    expect(result.status.stderr).toContain('mips-core.exec');
  });
});
