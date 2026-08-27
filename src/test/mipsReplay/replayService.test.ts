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
import { sha256Bytes as snapshotDigest } from '../../asmCaseStoreCore';
import {
  ImmutableEngineArtifactRegistry,
  engineArtifactRetentionPolicy,
  fixedReferenceEngineArtifactTrustManifest,
  maximumEngineArtifactBytes,
  maximumEngineRegistryMetadataBytes
} from '../../mips/replay/engineRegistry';
import { captureSourceGraph } from '../../mips/replay/sourceBundle';
import {
  createLegacyProgramImage,
  oracleEvidenceDigests,
  serializeObservabilitySchema,
  serializeProgramImage
} from '../../mips/replay/programImage';
import { exactReplayCase, reEvaluateCase } from '../../mips/replay/replayService';
import { maximumReplayManifestBytes, maximumReplayTraceBytes } from '../../mips/replay/boundedFile';
import {
  ReplayAdapterRegistry,
  type ReplayAdapterContext,
  type ReplayAssemblyOutput,
  type ReplayEngineAdapter,
  type ReplayEngineSelection,
  type ReplayExecutableProgram,
  type ReplayExecutionOutput
} from '../../mips/replay/types';
import {
  validateLegacyMarsReplayAssembly,
  validateLegacyMarsReplayExecution
} from '../../mips/replay/legacyMarsContract';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('phase-1 offline replay closure', () => {
  it('rejects an oversized case manifest before JSON parsing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-replay-manifest-limit-'));
    roots.push(root);
    const caseDir = path.join(root, 'case');
    fs.mkdirSync(caseDir);
    fs.writeFileSync(path.join(caseDir, 'case.json'), '{');
    fs.truncateSync(path.join(caseDir, 'case.json'), maximumReplayManifestBytes + 1);

    const result = await exactReplayCase(
      caseDir,
      new ImmutableEngineArtifactRegistry(path.join(root, 'registry')),
      new ReplayAdapterRegistry()
    );
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toMatch(/case manifest size .* exceeds the hard limit/);
  });

  it('exact-replays after the original workspace is deleted and keeps re-evaluation append-only', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-replay-test-'));
    roots.push(root);
    const workspace = path.join(root, 'original-workspace');
    const archive = path.join(root, 'archive');
    const caseDir = path.join(archive, 'case');
    const registryDir = path.join(archive, 'engine-registry');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(caseDir, { recursive: true });
    const include = path.join(workspace, 'lib.asm');
    const original = path.join(workspace, 'main.asm');
    const configuredEngine = path.join(workspace, '_co_internal_unknown_instruction.class');
    fs.writeFileSync(include, 'ori $1,$0,1\n');
    fs.writeFileSync(original, '.include "lib.asm"\nbeq $0,$0,-1\nnop\n');
    fs.copyFileSync(
      path.join(process.cwd(), 'resources', 'mars', '_co_internal_unknown_instruction.class'),
      configuredEngine
    );
    const rootBytes = fs.readFileSync(original);
    fs.writeFileSync(path.join(caseDir, 'program.asm'), rootBytes);
    const source = await captureSourceGraph(original, caseDir, rootBytes);

    const code = Buffer.from('34010001\n1000ffff\n00000000\n');
    const codeFile = path.join(caseDir, 'code.txt');
    fs.writeFileSync(codeFile, code);
    const image = createLegacyProgramImage(code.toString('utf8'), source.inputGraph);
    const imageBytes = serializeProgramImage(image);
    const observabilityBytes = serializeObservabilitySchema();
    const imageFile = path.join(caseDir, 'program', 'image.json');
    const observabilityFile = path.join(caseDir, 'program', 'observability.json');
    fs.mkdirSync(path.dirname(imageFile), { recursive: true });
    fs.writeFileSync(imageFile, imageBytes);
    fs.writeFileSync(observabilityFile, observabilityBytes);
    const traceText = [
      '@PC00003000 -> ori $1, $0, 1 (34010001)',
      '\t\t$ 1 <= 00000001',
      '@PC00003004 -> beq $0, $0, -1 (1000ffff)',
      '@PC00003008 -> nop (00000000)',
      ''
    ].join('\n');
    const traceFile = path.join(caseDir, 'oracle', 'trace.out');
    fs.mkdirSync(path.dirname(traceFile), { recursive: true });
    fs.writeFileSync(traceFile, traceText);
    const evidence = oracleEvidenceDigests(traceText, 2);
    const stdinFile = path.join(caseDir, 'stdin.bin');
    fs.writeFileSync(stdinFile, Buffer.from([0x41, 0x00, 0xff]));
    const stdinSnapshot = { ...snapshot(caseDir, stdinFile), originalPath: 'fixture-stdin.bin' };

    let artifactRegistry = new ImmutableEngineArtifactRegistry(registryDir);
    // The fixture adapter does not interpret its artifact. Reuse a real plugin-owned fixed artifact
    // so a new process can authenticate it from the compiled trust root without a test-only bypass.
    const originalArtifact = await artifactRegistry.registerFile(
      'mars-p7-ri-instruction-class',
      configuredEngine,
      '_co_internal_unknown_instruction.class'
    );
    const engine: ManifestEngineInfo = {
      id: 'test-replay-engine', build: 'v1', semanticsRevision: 1, capabilitiesRevision: 1,
      catalogRevision: 1, courseContractRevision: 1, normalizerRevision: 1, eventSchemaRevision: 1,
      artifact: originalArtifact.identity,
      legacyProvenance: {
        profile: 'P4',
        memoryConfiguration: 'FixedCompactLargeText',
        runtime: { kind: 'java', command: 'assembler-java' },
        wallClockMs: 7_777,
        p7RiInstruction: false
      }
    };
    const runConfiguration = completeRunConfiguration(stdinSnapshot);
    const manifest: AsmCaseManifestV2 = {
      version: 2,
      caseId: 'offline-case',
      createdAt: '2026-08-26T00:00:00.000Z',
      profile: 'P4',
      originalAsmPath: original,
      asmSnapshot: snapshot(caseDir, path.join(caseDir, 'program.asm')),
      stdin: stdinSnapshot,
      source: { kind: 'selected' },
      program: {
        assembler: engine,
        imageFingerprint: image.fingerprint,
        machineCode: { ...snapshot(caseDir, codeFile), wordCount: 3, haltPc: 0x3004 },
        sourceGraph: snapshot(caseDir, source.graphPath),
        image: snapshot(caseDir, imageFile),
        observability: snapshot(caseDir, observabilityFile),
        dutInput: snapshot(caseDir, codeFile)
      },
      oracle: {
        engine,
        runConfiguration,
        configurationHash: manifestRunConfigurationHash(runConfiguration, engine),
        stopReason: 'halt-loop',
        steps: evidence.steps,
        eventCount: evidence.eventCount,
        rawOutputDigest: evidence.rawOutputDigest,
        eventDigest: evidence.eventDigest,
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
          image: snapshot(caseDir, imageFile),
          observability: snapshot(caseDir, observabilityFile),
          dutInput: snapshot(caseDir, codeFile)
        },
        oracle: { traceOut: snapshot(caseDir, traceFile) }
      }
    };
    await writeManifestAtomic(path.join(caseDir, 'case.json'), manifest);

    // The provenance path and every original include disappear. Only archive+registry survive.
    fs.rmSync(workspace, { recursive: true, force: true });
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.existsSync(configuredEngine)).toBe(false);

    // Simulate a process restart: in-memory registerBytes authorization is gone, and the workspace
    // source is already unavailable. Only the extension-compiled fixed trust root remains.
    artifactRegistry = new ImmutableEngineArtifactRegistry(registryDir, archive);

    const adapters = new ReplayAdapterRegistry();
    adapters.register(new FixtureAdapter('test-replay-engine', code, traceText));
    const exact = await exactReplayCase(caseDir, artifactRegistry, adapters);
    expect(exact).toMatchObject({ ok: true, issues: [] });
    expect(exact.assembly?.imageFingerprint).toBe(image.fingerprint);

    const changedCode = Buffer.from('34010002\n1000ffff\n00000000\n');
    let executedDut = '';
    const rollbackAdapters = new ReplayAdapterRegistry();
    rollbackAdapters.register(new FixtureAdapter(
      'test-replay-engine',
      changedCode,
      traceText,
      {
        onExecute: (_context, program) => {
          executedDut = Buffer.from(program.dutBytes).toString('utf8');
        },
        onValidateExecution: (assembly, execution) => {
          // A hostile validator may try to replace the already-executed program with the
          // archived one. It is allowed to mutate its validation view, never the evidence.
          assembly.image = createLegacyProgramImage(code.toString('utf8'), assembly.image!.inputGraph);
          assembly.dutBytes = Buffer.from(code);
          execution.stdout = traceText;
          execution.stopReason = 'halt-loop';
        }
      }
    ));
    const rollbackAttempt = await exactReplayCase(caseDir, artifactRegistry, rollbackAdapters);
    expect(executedDut).toBe(changedCode.toString('utf8'));
    expect(rollbackAttempt.ok, rollbackAttempt.issues.join('\n')).toBe(false);
    expect(rollbackAttempt.issues.join('\n')).toMatch(/ProgramImage fingerprint differs|DUT bytes differ/);

    for (const [label, artifactPath] of [
      ['traceOut', traceFile],
      ['program image', imageFile],
      ['machine code', codeFile]
    ] as const) {
      const originalArtifactBytes = fs.readFileSync(artifactPath);
      const mutatingAdapters = new ReplayAdapterRegistry();
      mutatingAdapters.register(new FixtureAdapter(
        'test-replay-engine',
        code,
        traceText,
        { onExecute: () => fs.writeFileSync(artifactPath, `tampered-${label}`) }
      ));
      try {
        const tamperedDuringExecution = await exactReplayCase(caseDir, artifactRegistry, mutatingAdapters);
        expect(tamperedDuringExecution.ok, `${label}: ${tamperedDuringExecution.issues.join('\n')}`).toBe(false);
        expect(tamperedDuringExecution.issues.join('\n')).toMatch(/sha256 mismatch|size mismatch|does not match/);
      } finally {
        fs.writeFileSync(artifactPath, originalArtifactBytes);
      }
    }

    const beforeManifest = fs.readFileSync(path.join(caseDir, 'case.json'));
    const currentArtifact = await artifactRegistry.registerBytes('current-engine', Buffer.from('engine-v2'), 'engine.bin');
    const currentEngine: ManifestEngineInfo = {
      id: 'current-replay-engine', build: 'v2', semanticsRevision: 2, capabilitiesRevision: 1,
      catalogRevision: 1, courseContractRevision: 1, normalizerRevision: 1, eventSchemaRevision: 1,
      artifact: currentArtifact.identity
    };
    const selectionSnapshotEngine = { ...currentEngine, id: 'selection-snapshot-engine' };
    const forgedSelectionEngine = { ...currentEngine, id: 'forged-after-start-engine' };
    const assemblerSelection: ReplayEngineSelection = {
      engine: selectionSnapshotEngine,
      artifact: currentArtifact.identity
    };
    const oracleSelection: ReplayEngineSelection = {
      engine: selectionSnapshotEngine,
      artifact: currentArtifact.identity
    };
    const snapshottedOutputRoot = path.join(caseDir, 'snapshotted-re-evaluations');
    const forgedOutputRoot = path.join(root, 'forged-re-evaluations');
    const selectionOptions = {
      assembler: assemblerSelection,
      oracle: oracleSelection,
      outputRoot: snapshottedOutputRoot,
      outputContainmentRoot: caseDir,
      now: new Date('2026-08-26T10:00:00.000Z')
    };
    adapters.register(new FixtureAdapter(
      selectionSnapshotEngine.id,
      code,
      traceText,
      {
        semanticsRevision: 2,
        onExecute: () => {
          assemblerSelection.engine = forgedSelectionEngine;
          oracleSelection.engine = forgedSelectionEngine;
          selectionOptions.outputRoot = forgedOutputRoot;
          selectionOptions.outputContainmentRoot = root;
          selectionOptions.now.setUTCFullYear(2040);
        }
      }
    ));
    const selectionSnapshot = await reEvaluateCase(caseDir, artifactRegistry, adapters, selectionOptions);
    expect(selectionSnapshot.ok, selectionSnapshot.issues.join('\n')).toBe(true);
    expect(assemblerSelection.engine.id).toBe(forgedSelectionEngine.id);
    expect(oracleSelection.engine.id).toBe(forgedSelectionEngine.id);
    expect(path.dirname(selectionSnapshot.resultDirectory!)).toBe(snapshottedOutputRoot);
    expect(fs.existsSync(forgedOutputRoot)).toBe(false);
    expect(JSON.parse(fs.readFileSync(selectionSnapshot.resultFile!, 'utf8'))).toMatchObject({
      createdAt: '2026-08-26T10:00:00.000Z',
      current: {
        assembler: { id: selectionSnapshotEngine.id },
        oracle: { id: selectionSnapshotEngine.id }
      }
    });
    const invalidMachineEngine = { ...currentEngine, id: 'invalid-course-machine-engine' };
    adapters.register(new FixtureAdapter(
      invalidMachineEngine.id,
      Buffer.from('20010001\n1000ffff\n00000000\n'),
      traceText.replace('ori $1, $0, 1 (34010001)', 'addi $1, $0, 1 (20010001)'),
      { semanticsRevision: 2 }
    ));
    const invalidMachine = await reEvaluateCase(caseDir, artifactRegistry, adapters, {
      assembler: { engine: invalidMachineEngine, artifact: currentArtifact.identity },
      oracle: { engine: invalidMachineEngine, artifact: currentArtifact.identity }
    });
    expect(invalidMachine.ok).toBe(false);
    expect(invalidMachine.issues.join('\n')).toMatch(/course machine-code contract failed/);

    const mismatchedOracleEngine = { ...currentEngine, id: 'mismatched-course-oracle-engine' };
    adapters.register(new FixtureAdapter(
      mismatchedOracleEngine.id,
      code,
      traceText.replace('(34010001)', '(34010002)'),
      { semanticsRevision: 2 }
    ));
    const mismatchedOracle = await reEvaluateCase(caseDir, artifactRegistry, adapters, {
      assembler: { engine: mismatchedOracleEngine, artifact: currentArtifact.identity },
      oracle: { engine: mismatchedOracleEngine, artifact: currentArtifact.identity }
    });
    expect(mismatchedOracle.ok).toBe(false);
    expect(mismatchedOracle.issues.join('\n')).toMatch(/course oracle compatibility failed/);

    const currentTraceText = traceText
      .replace('ori $1, $0, 1 (34010001)', 'ori $1, $0, 2 (34010002)')
      .replace('$ 1 <= 00000001', '$ 1 <= 00000002');
    adapters.register(new FixtureAdapter(
      'current-replay-engine',
      Buffer.from('34010002\n1000ffff\n00000000\n'),
      currentTraceText,
      { semanticsRevision: 2 }
    ));
    const reevaluated = await reEvaluateCase(caseDir, artifactRegistry, adapters, {
      assembler: { engine: currentEngine, artifact: currentArtifact.identity },
      oracle: { engine: currentEngine, artifact: currentArtifact.identity },
      now: new Date('2026-08-26T12:00:00.000Z')
    });
    expect(reevaluated.ok, reevaluated.issues.join('\n')).toBe(true);
    expect(reevaluated.comparison).toEqual({
      imageMatchesOriginal: false,
      dutBytesMatchOriginal: false,
      rawOutputDigestMatchesOriginal: false,
      eventDigestMatchesOriginal: false,
      finalStateDigestMatchesOriginal: false,
      stepsMatchesOriginal: true,
      eventCountMatchesOriginal: true,
      stopReasonMatchesOriginal: true
    });
    expect(fs.readFileSync(path.join(caseDir, 'case.json'))).toEqual(beforeManifest);
    expect(JSON.parse(fs.readFileSync(reevaluated.resultFile!, 'utf8'))).toMatchObject({
      kind: 're-evaluation',
      original: {
        caseId: 'offline-case',
        rawOutputDigest: evidence.rawOutputDigest,
        eventDigest: evidence.eventDigest,
        steps: evidence.steps,
        eventCount: evidence.eventCount
      },
      comparison: { eventDigestMatchesOriginal: false }
    });

    const rawDriftEngine = { ...currentEngine, id: 'raw-output-drift-engine' };
    adapters.register(new FixtureAdapter(
      rawDriftEngine.id,
      code,
      `diagnostic banner\n${traceText}`,
      { semanticsRevision: 2 }
    ));
    const rawDrift = await reEvaluateCase(caseDir, artifactRegistry, adapters, {
      assembler: { engine: rawDriftEngine, artifact: currentArtifact.identity },
      oracle: { engine: rawDriftEngine, artifact: currentArtifact.identity }
    });
    expect(rawDrift.ok, rawDrift.issues.join('\n')).toBe(true);
    expect(rawDrift.comparison).toMatchObject({
      rawOutputDigestMatchesOriginal: false,
      eventDigestMatchesOriginal: true,
      finalStateDigestMatchesOriginal: true,
      stepsMatchesOriginal: true,
      eventCountMatchesOriginal: true
    });

    const stepDriftEngine = { ...currentEngine, id: 'step-count-drift-engine' };
    adapters.register(new FixtureAdapter(
      stepDriftEngine.id,
      code,
      `${traceText}@PC00003004 -> beq $0, $0, -1 (1000ffff)\n@PC00003008 -> nop (00000000)\n`,
      { semanticsRevision: 2 }
    ));
    const stepDrift = await reEvaluateCase(caseDir, artifactRegistry, adapters, {
      assembler: { engine: stepDriftEngine, artifact: currentArtifact.identity },
      oracle: { engine: stepDriftEngine, artifact: currentArtifact.identity }
    });
    expect(stepDrift.ok, stepDrift.issues.join('\n')).toBe(true);
    expect(stepDrift.comparison).toMatchObject({
      stepsMatchesOriginal: false,
      eventCountMatchesOriginal: true,
      eventDigestMatchesOriginal: true,
      finalStateDigestMatchesOriginal: true
    });

    const eventCountDriftEngine = { ...currentEngine, id: 'event-count-drift-engine' };
    adapters.register(new FixtureAdapter(
      eventCountDriftEngine.id,
      code,
      traceText.replace(
        '\t\t$ 1 <= 00000001\n',
        '\t\t$ 1 <= 00000001\n\t\t$ 1 <= 00000001\n'
      ),
      { semanticsRevision: 2 }
    ));
    const eventCountDrift = await reEvaluateCase(caseDir, artifactRegistry, adapters, {
      assembler: { engine: eventCountDriftEngine, artifact: currentArtifact.identity },
      oracle: { engine: eventCountDriftEngine, artifact: currentArtifact.identity }
    });
    expect(eventCountDrift.ok, eventCountDrift.issues.join('\n')).toBe(true);
    expect(eventCountDrift.comparison).toMatchObject({
      stepsMatchesOriginal: true,
      eventCountMatchesOriginal: false,
      finalStateDigestMatchesOriginal: true
    });

    let assemblerSourceRoot = '';
    let assemblerInputGraph: ReplayAdapterContext['inputGraph'] | undefined;
    let assemblerStdin: ReplayAdapterContext['stdinBytes'];
    let configurationWasDeepFrozen = false;
    let inputGraphWasDeepFrozen = false;
    let configurationMutationRejected = false;
    let oracleReceivedIsolatedInputs = false;
    let assemblerConfigurationWasOverlaid = false;
    let oracleConfigurationStayedOriginal = false;
    const isolationEngine = { ...currentEngine, id: 'adapter-stage-isolation-engine' };
    adapters.register(new FixtureAdapter(
      isolationEngine.id,
      code,
      traceText,
      {
        semanticsRevision: 2,
        onAssemble: (context) => {
          assemblerSourceRoot = context.sourceRoot;
          assemblerInputGraph = context.inputGraph;
          assemblerStdin = context.stdinBytes;
          configurationWasDeepFrozen = Object.isFrozen(context.configuration)
            && Object.isFrozen(context.configuration.resourceLimits);
          inputGraphWasDeepFrozen = Object.isFrozen(context.inputGraph)
            && context.inputGraph.every((unit) => Object.isFrozen(unit));
          assemblerConfigurationWasOverlaid = context.configuration.profile === 'P4'
            && context.configuration.runtime?.command === 'assembler-java'
            && context.configuration.resourceLimits?.wallClockMs === 7_777;
          try {
            context.configuration.resourceLimits!.maxSteps = 999;
          } catch {
            configurationMutationRejected = true;
          }
          context.stdinBytes![0] = 0x5a;
        },
        onExecute: (context) => {
          oracleReceivedIsolatedInputs = context.sourceRoot !== assemblerSourceRoot
            && context.inputGraph !== assemblerInputGraph
            && context.stdinBytes !== assemblerStdin
            && context.stdinBytes?.[0] === 0x41
            && context.configuration.resourceLimits?.maxSteps === 64;
          oracleConfigurationStayedOriginal = context.configuration.profile === 'P4'
            && context.configuration.runtime?.command === 'java'
            && context.configuration.resourceLimits?.wallClockMs === 10_000;
        }
      }
    ));
    const isolatedRun = await reEvaluateCase(caseDir, artifactRegistry, adapters, {
      assembler: { engine: isolationEngine, artifact: currentArtifact.identity },
      oracle: { engine: isolationEngine, artifact: currentArtifact.identity }
    });
    expect(isolatedRun.ok, isolatedRun.issues.join('\n')).toBe(true);
    expect(configurationWasDeepFrozen).toBe(true);
    expect(inputGraphWasDeepFrozen).toBe(true);
    expect(configurationMutationRejected).toBe(true);
    expect(oracleReceivedIsolatedInputs).toBe(true);
    expect(assemblerConfigurationWasOverlaid).toBe(true);
    expect(oracleConfigurationStayedOriginal).toBe(true);

    const resultRoot = path.join(caseDir, 're-evaluations');
    const resultsBeforeSourceMutation = fs.readdirSync(resultRoot).sort();
    const sourceMutatingEngine = { ...currentEngine, id: 'source-mutating-engine' };
    adapters.register(new FixtureAdapter(
      sourceMutatingEngine.id,
      code,
      traceText,
      {
        semanticsRevision: 2,
        onAssemble: (context) => {
          fs.chmodSync(context.sourceRoot, 0o644);
          fs.appendFileSync(context.sourceRoot, '# malicious adapter mutation\n');
        }
      }
    ));
    const rejectedSourceMutation = await reEvaluateCase(caseDir, artifactRegistry, adapters, {
      assembler: { engine: sourceMutatingEngine, artifact: currentArtifact.identity },
      oracle: { engine: sourceMutatingEngine, artifact: currentArtifact.identity }
    });
    expect(rejectedSourceMutation.ok).toBe(false);
    expect(rejectedSourceMutation.issues.join('\n')).toMatch(/materialized source/);
    expect(fs.readdirSync(resultRoot).sort()).toEqual(resultsBeforeSourceMutation);

    const resultsBeforeBundleMutation = fs.readdirSync(resultRoot).sort();
    const bundleMutatingEngine = { ...currentEngine, id: 'bundle-mutating-engine' };
    adapters.register(new FixtureAdapter(
      bundleMutatingEngine.id,
      code,
      traceText,
      {
        semanticsRevision: 2,
        onExecute: () => fs.writeFileSync(traceFile, 'tampered archived oracle output\n')
      }
    ));
    const rejectedBundleMutation = await reEvaluateCase(caseDir, artifactRegistry, adapters, {
      assembler: { engine: bundleMutatingEngine, artifact: currentArtifact.identity },
      oracle: { engine: bundleMutatingEngine, artifact: currentArtifact.identity }
    });
    expect(rejectedBundleMutation.ok).toBe(false);
    expect(rejectedBundleMutation.issues.join('\n')).toMatch(/traceOut|snapshot|digest|size/);
    expect(fs.readdirSync(resultRoot).sort()).toEqual(resultsBeforeBundleMutation);
    fs.writeFileSync(traceFile, traceText);

    const resultsBeforeMutation = fs.readdirSync(resultRoot).sort();
    const mutatingEngine = { ...currentEngine, id: 'manifest-mutating-engine' };
    adapters.register(new FixtureAdapter(
      mutatingEngine.id,
      code,
      traceText,
      { semanticsRevision: 2, onAssemble: () => fs.appendFileSync(path.join(caseDir, 'case.json'), '\n') }
    ));
    const rejectedMutation = await reEvaluateCase(caseDir, artifactRegistry, adapters, {
      assembler: { engine: mutatingEngine, artifact: currentArtifact.identity },
      oracle: { engine: mutatingEngine, artifact: currentArtifact.identity }
    });
    expect(rejectedMutation.ok).toBe(false);
    expect(rejectedMutation.issues.join('\n')).toMatch(/case manifest changed/);
    expect(fs.readdirSync(resultRoot).sort()).toEqual(resultsBeforeMutation);
    fs.writeFileSync(path.join(caseDir, 'case.json'), beforeManifest);

    const stopReasonEngine = { ...currentEngine, id: 'stop-reason-engine' };
    adapters.register(new FixtureAdapter(
      stopReasonEngine.id,
      code,
      traceText,
      { semanticsRevision: 2, stopReason: 'step-limit' }
    ));
    const stopReasonDrift = await reEvaluateCase(caseDir, artifactRegistry, adapters, {
      assembler: { engine: stopReasonEngine, artifact: currentArtifact.identity },
      oracle: { engine: stopReasonEngine, artifact: currentArtifact.identity }
    });
    expect(stopReasonDrift.ok, stopReasonDrift.issues.join('\n')).toBe(true);
    expect(stopReasonDrift.comparison?.stopReasonMatchesOriginal).toBe(false);
    expect(JSON.parse(fs.readFileSync(stopReasonDrift.resultFile!, 'utf8'))).toMatchObject({
      original: { stopReason: 'halt-loop' },
      current: { stopReason: 'step-limit' },
      comparison: { stopReasonMatchesOriginal: false }
    });

    const unsupportedRevision = { ...currentEngine, semanticsRevision: 999 };
    const rejectedRevision = await reEvaluateCase(caseDir, artifactRegistry, adapters, {
      assembler: { engine: unsupportedRevision, artifact: currentArtifact.identity },
      oracle: { engine: unsupportedRevision, artifact: currentArtifact.identity }
    });
    expect(rejectedRevision.ok).toBe(false);
    expect(rejectedRevision.issues.join('\n')).toMatch(/does not support the recorded engine revision tuple/);

    fs.rmSync(resultRoot, { recursive: true, force: true });
    const escapedResults = path.join(root, 'escaped-results');
    fs.mkdirSync(escapedResults);
    fs.symlinkSync(escapedResults, resultRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const rejectedOutputJunction = await reEvaluateCase(caseDir, artifactRegistry, adapters, {
      assembler: { engine: currentEngine, artifact: currentArtifact.identity },
      oracle: { engine: currentEngine, artifact: currentArtifact.identity }
    });
    expect(rejectedOutputJunction.ok).toBe(false);
    expect(rejectedOutputJunction.issues.join('\n')).toMatch(/symlink|junction|escapes/);
    expect(fs.readdirSync(escapedResults)).toEqual([]);
  }, 30_000);

  it('fails closed when a role+digest registry artifact is missing or corrupt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-engine-registry-test-'));
    roots.push(root);
    const registry = new ImmutableEngineArtifactRegistry(root);
    const entry = await registry.registerBytes('legacy-course-executor', Buffer.from('immutable'), 'Mars.jar');
    expect(engineArtifactRetentionPolicy).toBe('retain-until-explicit-live-manifest-gc');
    expect(await registry.resolve(entry.identity)).toMatchObject({ bytes: 9 });
    fs.chmodSync(entry.path, 0o644);
    fs.writeFileSync(entry.path, 'corrupt');
    await expect(registry.resolve(entry.identity)).rejects.toThrow(/identity verification/);
    await expect(registry.stageForExecution(entry.identity, path.join(root, 'corrupt-stage')))
      .rejects.toThrow(/identity verification/);
    await expect(registry.resolve({
      role: 'legacy-course-executor', sha256: '0'.repeat(64), fileName: 'Mars.jar'
    })).rejects.toThrow(/not registered/);
  });

  it('rejects retained entries in a fresh registry unless a non-workspace trust root authorizes them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-engine-auth-test-'));
    roots.push(root);
    const registryRoot = path.join(root, 'registry');
    const source = path.join(root, 'trusted-engine.bin');
    fs.writeFileSync(source, 'trusted-engine');

    const writer = new ImmutableEngineArtifactRegistry(registryRoot, root);
    const entry = await writer.registerFile('trusted-engine', source);
    await expect(writer.stageForExecution(entry.identity, path.join(root, 'writer-stage'))).resolves.toMatchObject({
      bytes: Buffer.byteLength('trusted-engine')
    });

    const fresh = new ImmutableEngineArtifactRegistry(registryRoot, root);
    await expect(fresh.resolve(entry.identity)).resolves.toMatchObject({ bytes: Buffer.byteLength('trusted-engine') });
    await expect(fresh.stageForExecution(entry.identity, path.join(root, 'unauthorized-stage')))
      .rejects.toThrow(/not authorized.*register trusted input.*fixed application-owned trust identity/);

    // A workspace-writable file that calls itself an authorization receipt has no authority. The
    // registry never discovers or consumes such files implicitly.
    fs.writeFileSync(path.join(registryRoot, 'execution-authorization.json'), JSON.stringify({
      role: entry.identity.role,
      sha256: entry.identity.sha256
    }));
    const stillFresh = new ImmutableEngineArtifactRegistry(registryRoot, root);
    await expect(stillFresh.stageForExecution(entry.identity, path.join(root, 'workspace-receipt-stage')))
      .rejects.toThrow(/not authorized/);

    const unrelated = path.join(root, 'unrelated-engine.bin');
    fs.writeFileSync(unrelated, 'different-engine');
    await fresh.registerFile('trusted-engine', unrelated);
    await expect(fresh.stageForExecution(entry.identity, path.join(root, 'still-unauthorized-stage')))
      .rejects.toThrow(/not authorized/);

    const matched = await fresh.registerFile('trusted-engine', source);
    expect(matched.identity.sha256).toBe(entry.identity.sha256);
    await expect(fresh.stageForExecution(entry.identity, path.join(root, 'fresh-stage'))).resolves.toMatchObject({
      identity: { role: 'trusted-engine', sha256: entry.identity.sha256 }
    });
  });

  it('stages a fixed plugin artifact in a fresh registry after its capture source is deleted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-engine-fixed-trust-test-'));
    roots.push(root);
    const registryRoot = path.join(root, 'registry');
    const source = path.join(root, '_co_internal_unknown_instruction.class');
    fs.copyFileSync(
      path.join(process.cwd(), 'resources', 'mars', '_co_internal_unknown_instruction.class'),
      source
    );

    const writer = new ImmutableEngineArtifactRegistry(registryRoot, root);
    const entry = await writer.registerFile('mars-p7-ri-instruction-class', source);
    fs.rmSync(source);

    const fresh = new ImmutableEngineArtifactRegistry(registryRoot, root);
    const staged = await fresh.stageForExecution(entry.identity, path.join(root, 'fresh-stage'));
    expect(staged).toMatchObject({
      bytes: 891,
      identity: {
        role: 'mars-p7-ri-instruction-class',
        sha256: '2add0891caacf2f29c683a6afedd859891bceeb22937174f8480b4390ba125f6'
      }
    });
    expect(fs.readFileSync(staged.path)).toEqual(fs.readFileSync(
      path.join(process.cwd(), 'resources', 'mars', '_co_internal_unknown_instruction.class')
    ));
  });

  it('keeps compiled MARS trust identities synchronized with the reviewed reference manifest', () => {
    const reference = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'conformance', 'mips', 'reference', 'reference-manifest.json'),
      'utf8'
    )) as { assets: Array<{ role: string; sha256: string; bytes: number; fileName: string; status: string }> };
    const releasedEngines = reference.assets.filter((asset) =>
      asset.status === 'released' && asset.fileName.toLowerCase().endsWith('.jar')
    );
    for (const asset of releasedEngines) {
      expect(fixedReferenceEngineArtifactTrustManifest.artifacts).toContainEqual({
        role: asset.role,
        sha256: asset.sha256,
        bytes: asset.bytes,
        fileName: asset.fileName
      });
      expect(fixedReferenceEngineArtifactTrustManifest.artifacts).toContainEqual({
        role: 'user-configured-mars',
        sha256: asset.sha256,
        bytes: asset.bytes
      });
    }

    const packagedClass = fs.readFileSync(path.join(
      process.cwd(), 'resources', 'mars', '_co_internal_unknown_instruction.class'
    ));
    expect(fixedReferenceEngineArtifactTrustManifest.artifacts).toContainEqual({
      role: 'mars-p7-ri-instruction-class',
      sha256: snapshotDigest(packagedClass),
      bytes: packagedClass.byteLength,
      fileName: '_co_internal_unknown_instruction.class'
    });
  });

  it('rejects oversized engine input and registry metadata before loading them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-engine-limit-test-'));
    roots.push(root);
    const registryRoot = path.join(root, 'registry');
    const oversized = path.join(root, 'oversized-engine.bin');
    fs.writeFileSync(oversized, '');
    fs.truncateSync(oversized, maximumEngineArtifactBytes + 1);
    const registry = new ImmutableEngineArtifactRegistry(registryRoot, root);
    await expect(registry.registerFile('oversized-engine', oversized)).rejects.toThrow(/exceeds the hard limit/);
    await expect(registry.registerBytes(
      'oversized-bytes',
      { byteLength: maximumEngineArtifactBytes + 1 } as Uint8Array,
      'engine.bin'
    )).rejects.toThrow(/exceeds the hard limit/);

    const entry = await registry.registerBytes('metadata-limit', Buffer.from('small-engine'), 'engine.bin');
    const metadataPath = path.join(path.dirname(entry.path), 'artifact.json');
    fs.chmodSync(metadataPath, 0o644);
    fs.writeFileSync(metadataPath, Buffer.alloc(maximumEngineRegistryMetadataBytes + 1, 0x20));
    await expect(registry.resolve(entry.identity)).rejects.toThrow(/metadata size .* exceeds the hard limit/);
    await expect(registry.stageForExecution(entry.identity, path.join(root, 'metadata-stage')))
      .rejects.toThrow(/metadata size .* exceeds the hard limit/);
  });

  it('rejects a symlink/junction in the registry path before writing outside the workspace', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'co-engine-workspace-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'co-engine-outside-'));
    roots.push(workspace, outside);
    fs.symlinkSync(outside, path.join(workspace, '.co'), process.platform === 'win32' ? 'junction' : 'dir');
    const registry = new ImmutableEngineArtifactRegistry(
      path.join(workspace, '.co', 'engine-registry'),
      workspace
    );

    await expect(registry.registerBytes('escape-role', Buffer.from('must-not-escape'), 'engine.bin'))
      .rejects.toThrow(/symlink|junction|escapes/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

class FixtureAdapter implements ReplayEngineAdapter {
  readonly validateAssembly = validateLegacyMarsReplayAssembly;
  constructor(
    readonly engineId: string,
    private readonly code: Buffer,
    private readonly trace: string,
    private readonly behavior: {
      semanticsRevision?: number;
      onAssemble?: (context: ReplayAdapterContext) => void;
      onExecute?: (context: ReplayAdapterContext, program: ReplayExecutableProgram) => void;
      onValidateExecution?: (assembly: ReplayAssemblyOutput, output: ReplayExecutionOutput) => void;
      stopReason?: ReplayExecutionOutput['stopReason'];
    } = {}
  ) {}

  supportsEngine(engine: ManifestEngineInfo): boolean {
    return engine.id === this.engineId
      && engine.semanticsRevision === (this.behavior.semanticsRevision ?? 1)
      && engine.capabilitiesRevision === 1
      && engine.catalogRevision === 1
      && engine.courseContractRevision === 1
      && engine.normalizerRevision === 1
      && engine.eventSchemaRevision === 1;
  }

  async assemble(context: ReplayAdapterContext): Promise<ReplayAssemblyOutput> {
    const root = fs.readFileSync(context.sourceRoot, 'utf8');
    if (!root.includes('.include "./source-0001.asm"')) {
      return { ok: false, stdout: '', stderr: 'source graph was not materialized from immutable blobs' };
    }
    if (!fs.existsSync(path.join(path.dirname(context.sourceRoot), 'source-0001.asm'))) {
      return { ok: false, stdout: '', stderr: 'included source blob is unavailable' };
    }
    this.behavior.onAssemble?.(context);
    return {
      ok: true,
      image: createLegacyProgramImage(this.code.toString('utf8'), context.inputGraph),
      dutBytes: this.code,
      stdout: '', stderr: ''
    };
  }

  async execute(context: ReplayAdapterContext, program: ReplayExecutableProgram): Promise<ReplayExecutionOutput> {
    this.behavior.onExecute?.(context, program);
    return { ok: true, stdout: this.trace, stderr: '', stopReason: this.behavior.stopReason ?? 'halt-loop' };
  }

  async validateExecution(
    context: ReplayAdapterContext,
    assembly: ReplayAssemblyOutput,
    output: ReplayExecutionOutput
  ): Promise<string | undefined> {
    this.behavior.onValidateExecution?.(assembly, output);
    return validateLegacyMarsReplayExecution(context, assembly, output);
  }
}

function completeRunConfiguration(stdin?: { sha256: string; bytes: number }): ManifestRunConfiguration {
  return {
    profile: 'P4', memoryConfiguration: 'FixedCompactLargeText', courseTrace: true, traceOutput: true,
    traceLevel: 2, maxSteps: 64, haltPc: 0x3004, interruptSchedule: [], stdinSha256: stdin?.sha256,
    executionOptions: {
      delayedBranching: false, courseTrace: true, traceOutput: true, traceLevel: 2, p7RiInstruction: false
    },
    stdin: { sha256: stdin?.sha256 ?? null, bytes: stdin?.bytes ?? 0, mode: 'bytes' },
    deviceTimeline: { schemaRevision: 1, events: [], probeMetadataDigest: null },
    cycleContract: { id: 'architectural-commit-v1', revision: 1 },
    stopPolicy: { kind: 'halt-loop', haltPc: 0x3004 },
    haltPolicy: { kind: 'course-self-branch-nop', branchWord: 0x1000ffff, delaySlotWord: 0 },
    stepPolicy: { unit: 'architectural-instruction', limit: 64 },
    seed: null,
    resourceLimits: {
      wallClockMs: 10_000, maxSteps: 64, maxTraceBytes: maximumReplayTraceBytes,
      maxSourceBytes: 8 * 1024 * 1024, maxIncludeDepth: 32, maxIncludeUnits: 256
    },
    runtime: { kind: 'java', command: 'java' }
  };
}

function snapshot(caseDir: string, file: string) {
  const bytes = fs.readFileSync(file);
  return {
    path: path.relative(caseDir, file).split(path.sep).join('/'),
    sha256: snapshotDigest(bytes),
    bytes: bytes.byteLength
  };
}
