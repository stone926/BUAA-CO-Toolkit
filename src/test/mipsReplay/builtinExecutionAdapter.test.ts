import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BuiltinTsReplayAdapter } from '../../mips/replay/builtinExecutionAdapter';
import { createDefaultReplayAdapterRegistry } from '../../mips/replay';
import { builtinExecutionEngineArtifact } from '../../mips/replay/builtinEngineArtifact';
import { builtinAssemblerEngineArtifact } from '../../mips/replay/builtinAssemblerEngineArtifact';
import { ImmutableEngineArtifactRegistry } from '../../mips/replay/engineRegistry';
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
    const assemblerArtifact = builtinAssemblerEngineArtifact();
    expect(adapter.supportsEngine({
      ...engine,
      semanticsRevision: assemblerArtifact.document.engine.semanticsRevision,
      artifact: assemblerArtifact.identity
    })).toBe(true);
  });

  it('is present in the default replay adapter registry', () => {
    const registry = createDefaultReplayAdapterRegistry('java');
    expect(() => registry.resolve(engine)).not.toThrow();
  });

  it('materializes application-owned logical artifacts in a fresh registry', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-builtin-registry-'));
    try {
      const registryRoot = path.join(directory, 'registry');
      const artifact = builtinAssemblerEngineArtifact();
      const first = new ImmutableEngineArtifactRegistry(registryRoot, directory);
      const staged = await first.stageForExecution(artifact.identity, path.join(directory, 'stage-1'));
      expect(await fs.promises.readFile(staged.path)).toEqual(artifact.bytes);

      const fresh = new ImmutableEngineArtifactRegistry(registryRoot, directory);
      const restaged = await fresh.stageForExecution(artifact.identity, path.join(directory, 'stage-2'));
      expect(await fs.promises.readFile(restaged.path)).toEqual(artifact.bytes);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
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
    expect(result.stdout.endsWith('\n')).toBe(false);
    expect(result.structuredEvidence).toMatchObject({ steps: 3, eventCount: 3 });
    expect(result.structuredEvidence?.eventDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('honours cancellation before assembly and execution start', async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new BuiltinTsReplayAdapter();
    const ctx = context({ signal: controller.signal });
    const image = buildProgramImage({
      entryPc: 0x3000,
      segments: [{ name: 'text', baseAddress: 0x3000, words: [0] }],
      inputGraph: [sourceUnitFingerprint({ id: 'root.asm', text: 'x' })]
    });

    expect(await adapter.assemble(ctx)).toMatchObject({
      ok: false,
      stderr: expect.stringContaining('cancelled')
    });
    expect(await adapter.execute(ctx, { image, dutBytes: Buffer.alloc(0) })).toMatchObject({
      ok: false,
      stopReason: 'cancelled'
    });
  });

  it('cooperatively cancels a running replay between execution slices', async () => {
    let cancellationChecks = 0;
    const signal = {
      get aborted() {
        cancellationChecks++;
        return cancellationChecks >= 4;
      }
    } as AbortSignal;
    const adapter = new BuiltinTsReplayAdapter();
    const image = buildProgramImage({
      entryPc: 0x3000,
      segments: [{ name: 'text', baseAddress: 0x3000, words: Array.from({ length: 512 }, () => 0) }],
      inputGraph: [sourceUnitFingerprint({ id: 'root.asm', text: 'x' })]
    });
    const base = context();
    const ctx = context({
      signal,
      configuration: {
        ...base.configuration,
        stopPolicy: { kind: 'halt-loop', haltPc: 0x6000 },
        stepPolicy: { unit: 'architectural-instruction', limit: 512 },
        resourceLimits: { ...base.configuration.resourceLimits, maxSteps: 512 }
      }
    });

    const result = await adapter.execute(ctx, { image, dutBytes: Buffer.alloc(0) });
    expect(result).toMatchObject({ ok: false, stopReason: 'cancelled' });
    expect(result.structuredEvidence).toMatchObject({ steps: 128, eventCount: 128 });
  });

  it('assembles the materialized source closure with the builtin assembler', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-builtin-replay-asm-'));
    try {
      const sourceText = '.text\nmain:\n    ori $t0, $0, 42\n    beq $0, $0, main\n    nop\n';
      const rootFile = path.join(directory, 'source-0000.asm');
      await fs.promises.writeFile(rootFile, sourceText, 'utf8');
      const artifact = builtinAssemblerEngineArtifact();
      const artifactPath = path.join(directory, 'assembler-engine.json');
      await fs.promises.writeFile(artifactPath, artifact.bytes);
      const adapter = new BuiltinTsReplayAdapter();
      const ctx = context({
        artifactPath,
        sourceRoot: rootFile,
        inputGraph: [sourceUnitFingerprint({ id: 'source-0000', text: sourceText })],
        sourceGraphInput: {
          rootId: 'source-0000',
          sources: [{ id: 'source-0000', text: sourceText }],
          includes: []
        },
        configuration: {
          profile: 'P3',
          memoryConfiguration: 'course-contract-v1',
          courseTrace: true,
          traceOutput: false,
          traceLevel: 1,
          executionOptions: {
            delayedBranching: false,
            courseTrace: true,
            traceOutput: false,
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
            maxSourceBytes: 4096,
            maxIncludeDepth: 8,
            maxIncludeUnits: 16
          },
          runtime: { kind: 'builtin-ts' }
        }
      });
      const result = await adapter.assemble(ctx);
      expect(result.ok).toBe(true);
      expect(result.image?.segments.find((segment) => segment.name === 'text')?.words[0].toString(16).padStart(8, '0')).toBe('3408002a');
      expect(result.dutBytes?.toString('utf8')).toBe('3408002a\n1000fffe\n00000000\n');
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('reassembles includes from original blobs instead of rewritten materialized text', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-builtin-replay-include-'));
    try {
      const rootText = '.include "dir with space/lib.asm"\n.text\n    nop\n';
      const includeText = '    ori $t0, $0, 42\n';
      const rootFile = path.join(directory, 'source-0000.asm');
      await fs.promises.writeFile(rootFile, rootText.replace('dir with space/lib.asm', './source-0001.asm'), 'utf8');
      await fs.promises.writeFile(path.join(directory, 'source-0001.asm'), includeText, 'utf8');
      const artifact = builtinAssemblerEngineArtifact();
      const artifactPath = path.join(directory, 'assembler-engine.json');
      await fs.promises.writeFile(artifactPath, artifact.bytes);
      const inputGraph = [
        sourceUnitFingerprint({ id: 'source-0000', text: rootText }),
        sourceUnitFingerprint({ id: 'source-0001', text: includeText })
      ];
      const adapter = new BuiltinTsReplayAdapter();
      const result = await adapter.assemble(context({
        artifactPath,
        sourceRoot: rootFile,
        inputGraph,
        sourceGraphInput: {
          rootId: 'source-0000',
          sources: [
            { id: 'source-0000', text: rootText },
            { id: 'source-0001', text: includeText }
          ],
          includes: [{
            fromId: 'source-0000',
            specifier: 'dir with space/lib.asm',
            toId: 'source-0001'
          }]
        },
        configuration: {
          ...context().configuration,
          profile: 'P3',
          runtime: { kind: 'builtin-ts' }
        }
      }));

      expect(result.ok).toBe(true);
      expect(result.image?.inputGraph).toEqual(inputGraph);
      expect(result.image?.sourceMap[0]).toMatchObject({ sourceId: 'source-0001' });
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
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
