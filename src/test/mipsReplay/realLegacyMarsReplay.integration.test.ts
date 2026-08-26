import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  manifestRunConfigurationHash,
  writeManifestAtomic,
  type AsmCaseManifestV2,
  type ManifestEngineInfo,
  type ManifestRunConfiguration
} from '../../courseTesting/manifestCodec';
import { sha256Bytes } from '../../asmCaseStoreCore';
import { ImmutableEngineArtifactRegistry } from '../../mips/replay/engineRegistry';
import { captureSourceGraph } from '../../mips/replay/sourceBundle';
import {
  oracleEvidenceDigests,
  serializeObservabilitySchema,
  serializeProgramImage
} from '../../mips/replay/programImage';
import { exactReplayCase, reEvaluateCase } from '../../mips/replay/replayService';
import { LegacyMarsReplayAdapter } from '../../mips/replay/legacyMarsAdapter';
import { createDefaultReplayAdapterRegistry } from '../../mips/replay';
import { maximumReplayTraceBytes } from '../../mips/replay/boundedFile';

const realJar = process.env.CO_REAL_MARS_JAR;
const realJava = process.env.CO_REAL_JAVA ?? 'java';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('real legacy MARS offline replay', () => {
  it.runIf(Boolean(realJar))('replays the real JAR after deleting the original workspace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-real-mars-replay-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace-to-delete');
    const caseDir = path.join(root, 'archived-case');
    const registryDir = path.join(root, 'registry');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(caseDir, { recursive: true });
    const sourceFile = path.join(workspace, 'main.asm');
    fs.writeFileSync(sourceFile, [
      '.text',
      'ori $1,$0,1',
      '_co_test_end:',
      'beq $0,$0,_co_test_end',
      'nop',
      ''
    ].join('\n'));
    const sourceBytes = fs.readFileSync(sourceFile);
    fs.writeFileSync(path.join(caseDir, 'program.asm'), sourceBytes);
    const source = await captureSourceGraph(sourceFile, caseDir, sourceBytes);
    const registry = new ImmutableEngineArtifactRegistry(registryDir);
    const artifact = await registry.registerFile('user-configured-mars', realJar!, path.basename(realJar!));
    const configuration = runConfiguration();
    const engine: ManifestEngineInfo = {
      id: 'legacy-mars-configured', build: 'real integration artifact',
      semanticsRevision: 1, capabilitiesRevision: 1, catalogRevision: 1,
      courseContractRevision: 1, normalizerRevision: 1, eventSchemaRevision: 1,
      artifact: artifact.identity,
      legacyProvenance: {
        commandLine: 'java -jar Mars.jar', cwd: root,
        profile: configuration.profile,
        memoryConfiguration: configuration.memoryConfiguration,
        runtime: configuration.runtime,
        wallClockMs: configuration.resourceLimits!.wallClockMs,
        p7RiInstruction: configuration.executionOptions!.p7RiInstruction
      }
    };
    const adapter = new LegacyMarsReplayAdapter({ javaCommand: realJava });
    const context = {
      artifactPath: artifact.path,
      dependencies: new Map<string, string>(),
      sourceRoot: source.rootMaterializedPath,
      inputGraph: source.inputGraph,
      configuration,
      workingDirectory: path.join(root, 'initial-run')
    };
    const assembly = await adapter.assemble(context);
    expect(assembly.ok, assembly.stderr).toBe(true);
    const execution = await adapter.execute(
      { ...context, workingDirectory: path.join(root, 'initial-oracle') },
      { image: assembly.image!, dutBytes: assembly.dutBytes! }
    );
    expect(execution.ok, execution.stderr).toBe(true);

    const codeFile = path.join(caseDir, 'code.txt');
    const imageFile = path.join(caseDir, 'program', 'image.json');
    const observabilityFile = path.join(caseDir, 'program', 'observability.json');
    const traceFile = path.join(caseDir, 'oracle', 'trace.out');
    fs.mkdirSync(path.dirname(imageFile), { recursive: true });
    fs.mkdirSync(path.dirname(traceFile), { recursive: true });
    fs.writeFileSync(codeFile, assembly.dutBytes!);
    fs.writeFileSync(imageFile, serializeProgramImage(assembly.image!));
    fs.writeFileSync(observabilityFile, serializeObservabilitySchema());
    fs.writeFileSync(traceFile, execution.stdout);
    const evidence = oracleEvidenceDigests(execution.stdout, 2);
    const manifest: AsmCaseManifestV2 = {
      version: 2, caseId: 'real-mars-offline', createdAt: '2026-08-26T00:00:00.000Z',
      profile: 'P4', originalAsmPath: sourceFile,
      asmSnapshot: snapshot(caseDir, path.join(caseDir, 'program.asm')),
      source: { kind: 'selected' },
      program: {
        assembler: engine,
        imageFingerprint: assembly.image!.fingerprint,
        machineCode: { ...snapshot(caseDir, codeFile), wordCount: 3, haltPc: 0x3004 },
        sourceGraph: snapshot(caseDir, source.graphPath),
        image: snapshot(caseDir, imageFile),
        observability: snapshot(caseDir, observabilityFile),
        dutInput: snapshot(caseDir, codeFile)
      },
      oracle: {
        engine, runConfiguration: configuration,
        configurationHash: manifestRunConfigurationHash(configuration, engine),
        stopReason: 'halt-loop', steps: evidence.steps, eventCount: evidence.eventCount,
        rawOutputDigest: evidence.rawOutputDigest, eventDigest: evidence.eventDigest,
        finalStateDigest: evidence.finalStateDigest
      },
      artifacts: {
        source: Object.fromEntries([
          ['graph', snapshot(caseDir, source.graphPath)],
          ...source.graph.units.flatMap((unit) => [
            [`blob/${unit.contentHash}`, snapshot(caseDir, path.join(caseDir, ...unit.blobPath.split('/')))],
            [`materialized/${unit.id}`, snapshot(caseDir, path.join(caseDir, ...unit.materializedPath.split('/')))]
          ])
        ]),
        program: {
          image: snapshot(caseDir, imageFile), observability: snapshot(caseDir, observabilityFile),
          dutInput: snapshot(caseDir, codeFile)
        },
        oracle: { traceOut: snapshot(caseDir, traceFile) }
      }
    };
    await writeManifestAtomic(path.join(caseDir, 'case.json'), manifest);
    fs.rmSync(workspace, { recursive: true, force: true });

    const result = await exactReplayCase(caseDir, registry, createDefaultReplayAdapterRegistry(realJava));
    expect(result.ok, result.issues.join('\n')).toBe(true);
    expect(result.oracle).toMatchObject({
      eventDigest: evidence.eventDigest,
      finalStateDigest: evidence.finalStateDigest
    });

    const originalManifest = fs.readFileSync(path.join(caseDir, 'case.json'));
    const reevaluated = await reEvaluateCase(caseDir, registry, createDefaultReplayAdapterRegistry(realJava), {
      assembler: { engine, artifact: artifact.identity },
      oracle: { engine, artifact: artifact.identity },
      now: new Date('2026-08-26T01:02:03.000Z')
    });
    expect(reevaluated.ok, reevaluated.issues.join('\n')).toBe(true);
    expect(reevaluated.comparison).toEqual({
      imageMatchesOriginal: true,
      dutBytesMatchOriginal: true,
      rawOutputDigestMatchesOriginal: true,
      eventDigestMatchesOriginal: true,
      finalStateDigestMatchesOriginal: true,
      stepsMatchesOriginal: true,
      eventCountMatchesOriginal: true,
      stopReasonMatchesOriginal: true
    });
    expect(fs.readFileSync(path.join(caseDir, 'case.json'))).toEqual(originalManifest);
    expect(reevaluated.resultFile).toBeTruthy();
    expect(fs.existsSync(reevaluated.resultFile!)).toBe(true);
  }, 60_000);

  it.runIf(Boolean(realJar))('replays P7 user/kernel image and efc execution with the real adapter', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-real-mars-p7-replay-'));
    roots.push(root);
    const sourceFile = path.join(root, 'p7.asm');
    fs.writeFileSync(sourceFile, [
      '.text', 'ori $1,$0,1', '_co_test_end:', 'beq $0,$0,_co_test_end', 'nop',
      '.ktext 0x4180', 'eret', ''
    ].join('\n'));
    const caseDir = path.join(root, 'case');
    fs.mkdirSync(caseDir);
    const bytes = fs.readFileSync(sourceFile);
    fs.writeFileSync(path.join(caseDir, 'program.asm'), bytes);
    const source = await captureSourceGraph(sourceFile, caseDir, bytes);
    const registry = new ImmutableEngineArtifactRegistry(path.join(root, 'registry'));
    const artifact = await registry.registerFile('user-configured-mars', realJar!, path.basename(realJar!));
    const configuration = runConfiguration('P7');
    const adapter = new LegacyMarsReplayAdapter({ javaCommand: realJava });
    const context = {
      artifactPath: artifact.path, dependencies: new Map<string, string>(),
      sourceRoot: source.rootMaterializedPath, inputGraph: source.inputGraph,
      configuration, workingDirectory: path.join(root, 'assemble')
    };
    const assembly = await adapter.assemble(context);
    expect(assembly.ok, assembly.stderr).toBe(true);
    expect(assembly.image?.segments[0].words[(0x4180 - 0x3000) / 4]).toBe(0x42000018);
    const execution = await adapter.execute(
      { ...context, workingDirectory: path.join(root, 'execute') },
      { image: assembly.image!, dutBytes: assembly.dutBytes! }
    );
    expect(execution.ok, execution.stderr).toBe(true);
    expect(execution.stopReason).toBe('halt-loop');
  }, 60_000);
});

function runConfiguration(profile: 'P4' | 'P7' = 'P4'): ManifestRunConfiguration {
  const p7 = profile === 'P7';
  return {
    profile, memoryConfiguration: p7 ? 'CompactLargeText' : 'FixedCompactLargeText', courseTrace: true, traceOutput: true,
    traceLevel: 2, maxSteps: 64, haltPc: 0x3004, interruptSchedule: [],
    executionOptions: {
      delayedBranching: p7, courseTrace: true, traceOutput: true, traceLevel: 2, p7RiInstruction: false
    },
    stdin: { sha256: null, bytes: 0, mode: 'bytes' },
    deviceTimeline: { schemaRevision: 1, events: [], probeMetadataDigest: null },
    cycleContract: { id: p7 ? 'buaa-co-p7-cycle-contract' : 'architectural-commit-v1', revision: 1 },
    stopPolicy: { kind: 'halt-loop', haltPc: 0x3004 },
    haltPolicy: { kind: 'course-self-branch-nop', branchWord: 0x1000ffff, delaySlotWord: 0 },
    stepPolicy: { unit: 'architectural-instruction', limit: 64 }, seed: null,
    resourceLimits: {
      wallClockMs: 30_000, maxSteps: 64, maxTraceBytes: maximumReplayTraceBytes,
      maxSourceBytes: 8 * 1024 * 1024, maxIncludeDepth: 32, maxIncludeUnits: 256
    },
    runtime: { kind: 'java', command: realJava }
  };
}

function snapshot(caseDir: string, file: string) {
  const bytes = fs.readFileSync(file);
  return {
    path: path.relative(caseDir, file).split(path.sep).join('/'),
    sha256: sha256Bytes(bytes), bytes: bytes.byteLength
  };
}
