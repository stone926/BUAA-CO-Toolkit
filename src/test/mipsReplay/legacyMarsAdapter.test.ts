import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RunProcessCoreResult } from '../../processCore';
import { LegacyMarsReplayAdapter } from '../../mips/replay/legacyMarsAdapter';
import type { ReplayAdapterContext } from '../../mips/replay/types';
import { maximumReplayTraceBytes, maximumReplayWallClockMs } from '../../mips/replay/boundedFile';
import { createLegacyProgramImage } from '../../mips/replay/programImage';

const processMock = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../processCore', () => ({ runProcessCore: processMock.run }));

const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('LegacyMarsReplayAdapter', () => {
  it('really invokes the trusted Java/JAR adapter for assembly and execution', async () => {
    const context = fixtureContext();
    processMock.run.mockImplementation(async (_command: string, args: readonly string[]) => {
      for (let index = 0; index < args.length - 3; index++) {
        if (args[index] !== 'dump' || args[index + 2] !== 'HexText') continue;
        const range = args[index + 1];
        fs.writeFileSync(args[index + 3], range.startsWith('0x00003000') ? '1000ffff\n00000000\n' : '');
      }
      return success(args.includes('coL2')
        ? '@PC00003000 -> beq $0,$0,-1 (1000ffff)\n'
        : '');
    });
    const adapter = new LegacyMarsReplayAdapter({ javaCommand: 'recorded-java' });

    const assembled = await adapter.assemble(context);
    expect(assembled.ok).toBe(true);
    expect(Buffer.from(assembled.dutBytes!).toString('utf8')).toBe('1000ffff\n00000000\n');
    expect(assembled.image?.segments[0].words).toEqual([0x1000ffff, 0]);
    const executed = await adapter.execute(context, { image: assembled.image!, dutBytes: assembled.dutBytes! });
    expect(executed).toMatchObject({ ok: true, stopReason: 'halt-loop' });
    expect(processMock.run.mock.calls[0][0]).toBe('recorded-java');
    expect(processMock.run.mock.calls[0][1].slice(0, 2)).toEqual(['-jar', context.artifactPath]);
    const executionArgs = processMock.run.mock.calls.find((call) => (call[1] as string[]).includes('coL2'))?.[1];
    expect(executionArgs).toEqual(expect.arrayContaining(['coL2', '64', context.sourceRoot]));
  });

  it('fails closed when a P7 RI runtime dependency is unavailable', async () => {
    const context = fixtureContext();
    context.configuration.profile = 'P7';
    context.configuration.memoryConfiguration = 'CompactLargeText';
    context.configuration.executionOptions!.delayedBranching = true;
    context.configuration.executionOptions!.p7RiInstruction = true;
    const result = await new LegacyMarsReplayAdapter({ javaCommand: 'recorded-java' }).assemble(context);
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/mars-p7-ri-instruction-class/);
    expect(processMock.run).not.toHaveBeenCalled();
  });

  it('never executes a Java command supplied only by an imported manifest', async () => {
    const context = fixtureContext();
    context.configuration.runtime = { kind: 'java', command: 'manifest-controlled-executable' };

    const result = await new LegacyMarsReplayAdapter({ javaCommand: 'trusted-java' }).execute(context, fixtureProgram(context));

    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/not authorized/);
    expect(processMock.run).not.toHaveBeenCalled();
  });

  it('rejects step-limit replay when MARS cannot prove budget exhaustion', async () => {
    const context = fixtureContext();
    context.configuration.stopPolicy = { kind: 'step-limit', haltPc: null };
    context.configuration.haltPc = undefined;

    const result = await new LegacyMarsReplayAdapter({ javaCommand: 'recorded-java' })
      .execute(context, fixtureProgram(context));

    expect(result).toMatchObject({ ok: false, stopReason: 'error' });
    expect(result.stderr).toMatch(/does not support step-limit stops.*cannot be verified/);
    expect(processMock.run).not.toHaveBeenCalled();
  });

  it('rejects exit-zero MARS dump diagnostics before accepting empty data files', async () => {
    const context = fixtureContext();
    processMock.run.mockResolvedValue(success('Error while attempting to save dump, file denied!'));

    const result = await new LegacyMarsReplayAdapter({ javaCommand: 'recorded-java' }).assemble(context);

    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/MARS dump failed/);
  });

  it('rejects exit-zero unsupported modified-MARS arguments in replay', async () => {
    const context = fixtureContext();
    processMock.run.mockImplementation(async (_command: string, args: readonly string[]) => {
      for (let index = 0; index < args.length - 3; index++) {
        if (args[index] !== 'dump' || args[index + 2] !== 'HexText') continue;
        const range = args[index + 1];
        fs.writeFileSync(args[index + 3], range.startsWith('0x00003000') ? '1000ffff\n00000000\n' : '');
      }
      return success(args.includes('coL2') ? 'Invalid Command Argument: coL2' : '');
    });

    const executed = await new LegacyMarsReplayAdapter({ javaCommand: 'recorded-java' }).execute(context, fixtureProgram(context));

    expect(executed.ok).toBe(false);
    expect(executed.stderr).toMatch(/不支持 coL1\/coL2/);
  });

  it('rejects an empty P7 kernel dump unless MARS explicitly reports an empty segment', async () => {
    const context = fixtureContext();
    context.configuration.profile = 'P7';
    context.configuration.memoryConfiguration = 'CompactLargeText';
    context.configuration.executionOptions!.delayedBranching = true;
    processMock.run.mockImplementation(async (_command: string, args: readonly string[]) => {
      for (let index = 0; index < args.length - 3; index++) {
        if (args[index] !== 'dump' || args[index + 2] !== 'HexText') continue;
        const range = args[index + 1];
        fs.writeFileSync(args[index + 3], range.startsWith('0x00003000') ? '1000ffff\n00000000\n' : '');
      }
      return success('');
    });

    const result = await new LegacyMarsReplayAdapter({ javaCommand: 'recorded-java' }).assemble(context);

    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/empty P7 kernel dump/);
  });

  it('enforces trusted local execution ceilings instead of bundle-declared limits', async () => {
    const context = fixtureContext();
    context.configuration.resourceLimits!.wallClockMs = maximumReplayWallClockMs + 1;

    const result = await new LegacyMarsReplayAdapter({ javaCommand: 'recorded-java' }).assemble(context);

    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/wall-clock limit/);
    expect(processMock.run).not.toHaveBeenCalled();
  });
});

function fixtureContext(): ReplayAdapterContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-legacy-replay-adapter-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'program.asm');
  const artifactPath = path.join(root, 'Mars.jar');
  fs.writeFileSync(sourceRoot, 'beq $0,$0,-1\nnop\n');
  fs.writeFileSync(artifactPath, 'jar');
  return {
    artifactPath,
    dependencies: new Map(),
    sourceRoot,
    sourceKind: 'selected',
    inputGraph: [{ id: 'source-0000', contentHash: 'a'.repeat(64) }],
    configuration: {
      profile: 'P4', memoryConfiguration: 'FixedCompactLargeText', courseTrace: true, traceOutput: true,
      traceLevel: 2, maxSteps: 64, haltPc: 0x3000,
      executionOptions: {
        delayedBranching: false, courseTrace: true, traceOutput: true, traceLevel: 2, p7RiInstruction: false
      },
      deviceTimeline: { schemaRevision: 1, events: [], probeMetadataDigest: null },
      stopPolicy: { kind: 'halt-loop', haltPc: 0x3000 },
      stepPolicy: { unit: 'architectural-instruction', limit: 64 },
      resourceLimits: {
        wallClockMs: 10_000, maxSteps: 64, maxTraceBytes: maximumReplayTraceBytes,
        maxSourceBytes: 1024, maxIncludeDepth: 8, maxIncludeUnits: 8
      },
      runtime: { kind: 'java', command: 'recorded-java' }
    },
    workingDirectory: path.join(root, 'work')
  };
}

function fixtureProgram(context: ReplayAdapterContext) {
  const dutBytes = Buffer.from('1000ffff\n00000000\n');
  return {
    image: createLegacyProgramImage(dutBytes.toString('utf8'), context.inputGraph),
    dutBytes
  };
}

function success(stdout: string): RunProcessCoreResult {
  return {
    ok: true, exitCode: 0, stdout, stderr: '', timedOut: false, stopped: false,
    commandLine: 'java', cwd: '.'
  };
}
