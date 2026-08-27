import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BuiltinTsReplayAdapter } from '../../mips/replay/builtinExecutionAdapter';
import { createDefaultReplayAdapterRegistry } from '../../mips/replay';
import { builtinExecutionEngineArtifact } from '../../mips/replay/builtinEngineArtifact';
import { buildProgramImage } from '../../mips/core/programImage';
import { sourceUnitFingerprint } from '../../mips/core/programImage';
import type { ManifestEngineInfo } from '../../courseTesting/manifestCodec';
import type { ReplayAdapterContext } from '../../mips/replay/types';

function context(overrides: Partial<ReplayAdapterContext> = {}): ReplayAdapterContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-builtin-replay-'));
  const artifact = builtinExecutionEngineArtifact();
  const artifactPath = path.join(dir, 'engine.json');
  fs.writeFileSync(artifactPath, artifact.bytes);
  return {
    artifactPath,
    dependencies: new Map(),
    sourceRoot: path.join(dir, 'source.asm'),
    sourceKind: 'file',
    inputGraph: [sourceUnitFingerprint({ id: 'root.asm', text: 'x' })],
    configuration: {
      profile: 'P5',
      memoryConfiguration: 'Default',
      courseTrace: true,
      traceOutput: true,
      traceLevel: 1,
      executionOptions: {
        delayedBranching: true,
        courseTrace: true,
        traceOutput: true,
        traceLevel: 1,
        p7RiInstruction: false
      },
      stdin: { sha256: null, bytes: 0, mode: 'bytes' },
      deviceTimeline: { schemaRevision: 1, events: [], probeMetadataDigest: null },
      cycleContract: { id: 'architectural-commit-v1', revision: 1 },
      stopPolicy: { kind: 'halt-loop', haltPc: 0x3004 },
      haltPolicy: { kind: 'course-self-branch-nop', branchWord: 0x1000ffff, delaySlotWord: 0 },
      stepPolicy: { unit: 'architectural-instruction', limit: 64 },
      seed: null,
      resourceLimits: {
        wallClockMs: 5000,
        maxSteps: 64,
        maxTraceBytes: 1024 * 1024,
        maxSourceBytes: 1024,
        maxIncludeDepth: 8,
        maxIncludeUnits: 16
      },
      runtime: { kind: 'builtin-ts' }
    },
    workingDirectory: dir,
    ...overrides
  };
}

const engine: ManifestEngineInfo = {
  id: 'builtin-ts',
  semanticsRevision: 1,
  capabilitiesRevision: 1,
  catalogRevision: 1,
  courseContractRevision: 1,
  normalizerRevision: 1,
  eventSchemaRevision: 1
};

describe('BuiltinTsReplayAdapter', () => {
  it('declares the compiled executor revision tuple', () => {
    const adapter = new BuiltinTsReplayAdapter();
    expect(adapter.supportsEngine(engine)).toBe(true);
    expect(adapter.supportsEngine({ ...engine, semanticsRevision: 2 })).toBe(false);
  });

  it('is present in the default replay adapter registry', () => {
    const registry = createDefaultReplayAdapterRegistry('java');
    expect(() => registry.resolve(engine)).not.toThrow();
  });

  it('replays a pinned ProgramImage and returns the same projected trace', async () => {
    const adapter = new BuiltinTsReplayAdapter();
    const image = buildProgramImage({
      entryPc: 0x3000,
      segments: [{ name: 'text', baseAddress: 0x3000, words: [0x3408002a, 0x1000ffff, 0x00000000] }],
      inputGraph: [sourceUnitFingerprint({ id: 'root.asm', text: 'x' })]
    });
    const ctx = context();
    const result = await adapter.execute(ctx, {
      image,
      dutBytes: Buffer.from('3408002a\n1000ffff\n00000000\n')
    });
    expect(result).toMatchObject({ ok: true, stopReason: 'halt-loop' });
    expect(result.stdout).toContain('@00003000: $8 <= 0000002A');
  });

  it('rejects stdin and a mismatched logical artifact', async () => {
    const adapter = new BuiltinTsReplayAdapter();
    const image = buildProgramImage({
      entryPc: 0x3000,
      segments: [{ name: 'text', baseAddress: 0x3000, words: [0x3408002a, 0x1000ffff, 0x00000000] }],
      inputGraph: [sourceUnitFingerprint({ id: 'root.asm', text: 'x' })]
    });
    const stdin = context({ stdinBytes: Buffer.from('42') });
    expect((await adapter.execute(stdin, { image, dutBytes: Buffer.alloc(0) })).ok).toBe(false);

    const bad = context();
    fs.writeFileSync(bad.artifactPath, 'wrong');
    expect((await adapter.execute(bad, { image, dutBytes: Buffer.alloc(0) })).stderr).toContain('does not match');
  });
});
