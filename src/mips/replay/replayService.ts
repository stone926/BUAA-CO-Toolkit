// @index mips-replay — v2 exact replay 与 append-only re-evaluate orchestration
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  isKnownManifest,
  isManifestV2,
  manifestRunConfigurationHash,
  v2ReplayBundleIssues,
  type AsmCaseManifestV2,
  type ManifestEngineInfo,
  type ManifestRunConfiguration
} from '../../courseTesting/manifestCodec';
import type { EngineArtifactIdentity } from '../providers/contracts';
import { ImmutableEngineArtifactRegistry } from './engineRegistry';
import { materializeSourceGraph } from './sourceBundle';
import { deserializeProgramImage, oracleEvidenceDigests, serializeProgramImage } from './programImage';
import { canonicalJson, sha256Bytes, type CanonicalJson } from './canonical';
import {
  ReplayAdapterRegistry,
  type ReplayAdapterContext,
  type ReplayAssemblyOutput,
  type ReplayEngineSelection,
  type ReplayExecutionOutput
} from './types';
import { assertContainedDirectoryPath, ensureContainedDirectoryPath } from '../../pathContainment';
import {
  maximumReplayManifestBytes,
  maximumReplayStdinBytes,
  readBoundedRegularFile
} from './boundedFile';

export interface ExactReplayResult {
  ok: boolean;
  issues: string[];
  assembly?: { imageFingerprint: string; dutBytesDigest: string };
  oracle?: { rawOutputDigest: string; eventDigest: string; finalStateDigest: string; steps: number; eventCount: number };
}

export interface ReEvaluateResult {
  ok: boolean;
  issues: string[];
  resultFile?: string;
  resultDirectory?: string;
  comparison?: {
    imageMatchesOriginal: boolean;
    dutBytesMatchOriginal: boolean;
    rawOutputDigestMatchesOriginal: boolean;
    eventDigestMatchesOriginal: boolean;
    finalStateDigestMatchesOriginal: boolean;
    stepsMatchesOriginal: boolean;
    eventCountMatchesOriginal: boolean;
    stopReasonMatchesOriginal: boolean;
  };
}

export interface ReEvaluateOptions {
  assembler: ReplayEngineSelection;
  oracle: ReplayEngineSelection;
  outputRoot?: string;
  /** Required trusted anchor when outputRoot is outside the archived case. */
  outputContainmentRoot?: string;
  signal?: AbortSignal;
  now?: Date;
}

interface ReEvaluateOptionsSnapshot {
  readonly assembler: ReplayEngineSelection;
  readonly oracle: ReplayEngineSelection;
  readonly outputRoot?: string;
  readonly outputContainmentRoot?: string;
  readonly signal?: AbortSignal;
  readonly now: Date;
}

export async function exactReplayCase(
  caseDir: string,
  artifacts: ImmutableEngineArtifactRegistry,
  adapters: ReplayAdapterRegistry,
  signal?: AbortSignal
): Promise<ExactReplayResult> {
  const loaded = await loadReplayManifest(caseDir);
  if ('issues' in loaded) return { ok: false, issues: loaded.issues };
  const issues = await stableReplayBundleIssues(
    caseDir,
    loaded.manifest,
    loaded.bytes,
    'before exact replay'
  );
  if (issues.length) return { ok: false, issues };

  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-exact-replay-'));
  try {
    const result = await runReplay(caseDir, loaded.manifest, artifacts, adapters, {
      assembler: engineSelection(loaded.manifest.program.assembler),
      oracle: engineSelection(loaded.manifest.oracle.engine),
      signal,
      temp
    });
    issues.push(...result.issues);
    // Adapters execute outside the archived bundle and are not trusted to leave it untouched.
    // Re-validate the entire closure immediately after execution, bracketed by byte-identical
    // manifest reads, before accepting any replay output.
    issues.push(...await stableReplayBundleIssues(
      caseDir,
      parseValidatedManifestCopy(loaded.bytes),
      loaded.bytes,
      'after exact replay'
    ));
    if (result.assembly) {
      if (result.assembly.image.fingerprint !== loaded.manifest.program.imageFingerprint) {
        issues.push('exact replay ProgramImage fingerprint differs from the original');
      }
      if (sha256Bytes(result.assembly.dutBytes) !== loaded.manifest.program.dutInput?.sha256
        || result.assembly.dutBytes.byteLength !== loaded.manifest.program.dutInput?.bytes) {
        issues.push('exact replay DUT bytes differ from the original');
      }
    }
    if (result.oracle) {
      if (result.oracle.stopReason !== loaded.manifest.oracle.stopReason) issues.push('exact replay stop reason differs from the original');
      if (result.oracle.evidence.rawOutputDigest !== loaded.manifest.oracle.rawOutputDigest) issues.push('exact replay raw oracle output digest differs from the original');
      if (result.oracle.evidence.eventDigest !== loaded.manifest.oracle.eventDigest) issues.push('exact replay event digest differs from the original');
      if (result.oracle.evidence.finalStateDigest !== loaded.manifest.oracle.finalStateDigest) issues.push('exact replay final-state digest differs from the original');
      if (result.oracle.evidence.steps !== loaded.manifest.oracle.steps) issues.push('exact replay step count differs from the original');
      if (result.oracle.evidence.eventCount !== loaded.manifest.oracle.eventCount) issues.push('exact replay event count differs from the original');
    }
    return {
      ok: issues.length === 0,
      issues: [...new Set(issues)],
      assembly: result.assembly ? {
        imageFingerprint: result.assembly.image.fingerprint,
        dutBytesDigest: sha256Bytes(result.assembly.dutBytes)
      } : undefined,
      oracle: result.oracle ? { ...result.oracle.evidence } : undefined
    };
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
}

/**
 * Run the same immutable source/run input with caller-selected current engines. Results are
 * append-only under `re-evaluations/`; case.json and every original adjudication digest remain
 * byte-for-byte untouched.
 */
export async function reEvaluateCase(
  caseDir: string,
  artifacts: ImmutableEngineArtifactRegistry,
  adapters: ReplayAdapterRegistry,
  options: ReEvaluateOptions
): Promise<ReEvaluateResult> {
  let replayOptions: ReEvaluateOptionsSnapshot;
  try {
    // The caller owns ReEvaluateOptions and can retain/mutate it while adapters are running.
    // Capture every option before the first await so execution, publication and provenance
    // can never observe different caller-owned values.
    replayOptions = snapshotReEvaluateOptions(options);
  } catch (error) {
    return { ok: false, issues: [`invalid re-evaluate options: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const loaded = await loadReplayManifest(caseDir);
  if ('issues' in loaded) return { ok: false, issues: loaded.issues };
  const closureIssues = await stableReplayBundleIssues(
    caseDir,
    loaded.manifest,
    loaded.bytes,
    'before re-evaluate'
  );
  if (closureIssues.length) return { ok: false, issues: closureIssues };
  const originalManifestBytes = loaded.bytes;
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-re-evaluate-'));
  let pendingResultDirectory: string | undefined;
  try {
    const run = await runReplay(caseDir, loaded.manifest, artifacts, adapters, {
      assembler: replayOptions.assembler,
      oracle: replayOptions.oracle,
      signal: replayOptions.signal,
      temp
    });
    const postRunClosureIssues = await stableReplayBundleIssues(
      caseDir,
      parseValidatedManifestCopy(originalManifestBytes),
      originalManifestBytes,
      'after adapter execution and before re-evaluate publish'
    );
    if (run.issues.length || postRunClosureIssues.length || !run.assembly || !run.oracle) {
      return { ok: false, issues: [...new Set([...run.issues, ...postRunClosureIssues])] };
    }
    const comparison = {
      imageMatchesOriginal: run.assembly.image.fingerprint === loaded.manifest.program.imageFingerprint,
      dutBytesMatchOriginal: sha256Bytes(run.assembly.dutBytes) === loaded.manifest.program.dutInput?.sha256,
      rawOutputDigestMatchesOriginal: run.oracle.evidence.rawOutputDigest === loaded.manifest.oracle.rawOutputDigest,
      eventDigestMatchesOriginal: run.oracle.evidence.eventDigest === loaded.manifest.oracle.eventDigest,
      finalStateDigestMatchesOriginal: run.oracle.evidence.finalStateDigest === loaded.manifest.oracle.finalStateDigest,
      stepsMatchesOriginal: run.oracle.evidence.steps === loaded.manifest.oracle.steps,
      eventCountMatchesOriginal: run.oracle.evidence.eventCount === loaded.manifest.oracle.eventCount,
      stopReasonMatchesOriginal: run.oracle.stopReason === loaded.manifest.oracle.stopReason
    };
    const stamp = replayOptions.now.toISOString().replace(/[:.]/g, '-');
    const realCaseDir = await fs.promises.realpath(caseDir);
    if (replayOptions.outputRoot && !replayOptions.outputContainmentRoot) {
      throw new Error('re-evaluate outputRoot requires an explicit trusted outputContainmentRoot');
    }
    const outputRoot = path.resolve(replayOptions.outputRoot ?? path.join(realCaseDir, 're-evaluations'));
    const outputContainmentRoot = path.resolve(replayOptions.outputContainmentRoot ?? realCaseDir);
    const resultDir = path.join(outputRoot, `${stamp}-${crypto.randomUUID().slice(0, 8)}`);
    await ensureContainedDirectoryPath(outputContainmentRoot, outputRoot, {
      allowRoot: outputRoot === outputContainmentRoot
    });
    await assertContainedDirectoryPath(outputContainmentRoot, outputRoot, {
      allowRoot: outputRoot === outputContainmentRoot
    });
    const tempResultDir = path.join(outputRoot, `.tmp-${process.pid}-${crypto.randomUUID()}`);
    pendingResultDirectory = tempResultDir;
    await fs.promises.mkdir(tempResultDir, { recursive: false });
    const imageBytes = serializeProgramImage(run.assembly.image);
    const dutBytes = Buffer.from(run.assembly.dutBytes);
    const oracleBytes = Buffer.from(run.oracle.stdout, 'utf8');
    await Promise.all([
      fs.promises.writeFile(path.join(tempResultDir, 'program-image.json'), imageBytes, { flag: 'wx' }),
      fs.promises.writeFile(path.join(tempResultDir, 'dut-input.bin'), dutBytes, { flag: 'wx' }),
      fs.promises.writeFile(path.join(tempResultDir, 'oracle.out'), oracleBytes, { flag: 'wx' })
    ]);
    const resultDocument = {
      schemaRevision: 1,
      kind: 're-evaluation',
      createdAt: replayOptions.now.toISOString(),
      original: {
        caseId: loaded.manifest.caseId,
        manifestSha256: sha256Bytes(originalManifestBytes),
        imageFingerprint: loaded.manifest.program.imageFingerprint,
        rawOutputDigest: loaded.manifest.oracle.rawOutputDigest,
        eventDigest: loaded.manifest.oracle.eventDigest,
        finalStateDigest: loaded.manifest.oracle.finalStateDigest,
        steps: loaded.manifest.oracle.steps,
        eventCount: loaded.manifest.oracle.eventCount,
        stopReason: loaded.manifest.oracle.stopReason
      },
      current: {
        assembler: replayOptions.assembler.engine,
        oracle: replayOptions.oracle.engine,
        configurationHash: manifestRunConfigurationHash(loaded.manifest.oracle.runConfiguration!, replayOptions.oracle.engine),
        imageFingerprint: run.assembly.image.fingerprint,
        dutBytesDigest: sha256Bytes(dutBytes),
        rawOutputDigest: run.oracle.evidence.rawOutputDigest,
        eventDigest: run.oracle.evidence.eventDigest,
        finalStateDigest: run.oracle.evidence.finalStateDigest,
        steps: run.oracle.evidence.steps,
        eventCount: run.oracle.evidence.eventCount,
        stopReason: run.oracle.stopReason
      },
      comparison
    };
    await fs.promises.writeFile(
      path.join(tempResultDir, 'result.json'),
      `${canonicalJson(resultDocument as unknown as CanonicalJson)}\n`,
      { flag: 'wx' }
    );
    await fs.promises.rename(tempResultDir, resultDir);
    pendingResultDirectory = resultDir;
    await assertContainedDirectoryPath(outputContainmentRoot, resultDir);
    const publishedClosureIssues = await stableReplayBundleIssues(
      caseDir,
      parseValidatedManifestCopy(originalManifestBytes),
      originalManifestBytes,
      'after re-evaluate publish'
    );
    if (publishedClosureIssues.length) {
      await fs.promises.rm(resultDir, { recursive: true, force: true });
      pendingResultDirectory = undefined;
      return { ok: false, issues: publishedClosureIssues };
    }
    const resultFile = path.join(resultDir, 'result.json');
    pendingResultDirectory = undefined;
    return { ok: true, issues: [], resultFile, resultDirectory: resultDir, comparison };
  } catch (error) {
    if (pendingResultDirectory) {
      await fs.promises.rm(pendingResultDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    return { ok: false, issues: [error instanceof Error ? error.message : String(error)] };
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
}

interface RunReplayOptions {
  assembler: ReplayEngineSelection;
  oracle: ReplayEngineSelection;
  signal?: AbortSignal;
  temp: string;
}

async function runReplay(
  caseDir: string,
  manifest: AsmCaseManifestV2,
  artifacts: ImmutableEngineArtifactRegistry,
  adapters: ReplayAdapterRegistry,
  options: RunReplayOptions
) {
  const issues: string[] = [];
  try {
    const stdinBytes = manifest.stdin
      ? await readVerifiedReplayInput(caseDir, manifest.stdin)
      : undefined;
    const assemblerStage = await createAdapterStage(
      caseDir, manifest, 'assembler', options.assembler, artifacts, stdinBytes,
      path.join(options.temp, 'assembler'), options.signal
    );
    const assemblerContext = assemblerStage.context;
    const assembler = adapters.resolve(options.assembler.engine);
    const assembled = await assembler.assemble(assemblerContext);
    const assemblyFailureDetail = typeof assembled.stderr === 'string' && assembled.stderr
      ? assembled.stderr
      : 'no result';
    // Snapshot the provider result before any further await. Adapter-owned objects may be
    // retained or mutated after their promise resolves; they are never authoritative evidence.
    const authoritativeAssembly = assembled.ok && assembled.image && assembled.dutBytes
      ? captureAuthoritativeAssembly(assemblerContext, assembled)
      : undefined;
    await assertMaterializedSourceUnchanged(assemblerStage.sourceSnapshot);
    if (!authoritativeAssembly) {
      issues.push(`assembler replay failed: ${assemblyFailureDetail}`);
      return { issues };
    }
    const machineCodeIssue = await assembler.validateAssembly?.(
      assemblerContext,
      isolatedAssemblyValidationView(authoritativeAssembly)
    );
    await assertMaterializedSourceUnchanged(assemblerStage.sourceSnapshot);
    if (machineCodeIssue) {
      issues.push(`course machine-code contract failed during replay: ${machineCodeIssue}`);
      return { issues, assembly: authoritativeAssemblyResult(authoritativeAssembly) };
    }
    const oracleStage = await createAdapterStage(
      caseDir, manifest, 'oracle', options.oracle, artifacts, stdinBytes,
      path.join(options.temp, 'oracle'), options.signal
    );
    const oracleContext = oracleStage.context;
    const oracleAdapter = adapters.resolve(options.oracle.engine);
    const executableImage = authoritativeAssembly.image;
    const executableDutBytes = Buffer.from(authoritativeAssembly.dutBytes);
    const executableDutDigest = sha256Bytes(executableDutBytes);
    const adapterExecution = await oracleAdapter.execute(oracleContext, {
      image: executableImage,
      dutBytes: executableDutBytes
    });
    const executed = captureAuthoritativeExecution(adapterExecution);
    if (sha256Bytes(executableDutBytes) !== executableDutDigest) {
      throw new Error('oracle adapter mutated the immutable DUT image supplied for execution');
    }
    await assertMaterializedSourceUnchanged(oracleStage.sourceSnapshot);
    if (!executed.ok) {
      issues.push(`oracle replay failed: ${executed.stderr || 'no result'}`);
      return { issues, assembly: authoritativeAssemblyResult(authoritativeAssembly) };
    }
    const oracleCompatibilityIssue = await oracleAdapter.validateExecution?.(
      oracleContext,
      isolatedAssemblyValidationView(authoritativeAssembly),
      isolatedExecutionValidationView(executed)
    );
    await assertMaterializedSourceUnchanged(oracleStage.sourceSnapshot);
    if (oracleCompatibilityIssue) {
      issues.push(`course oracle compatibility failed during replay: ${oracleCompatibilityIssue}`);
      return { issues, assembly: authoritativeAssemblyResult(authoritativeAssembly) };
    }
    const evidence = oracleEvidenceDigests(executed.stdout, manifest.oracle.runConfiguration?.traceLevel ?? 1);
    return {
      issues,
      assembly: authoritativeAssemblyResult(authoritativeAssembly),
      oracle: { stdout: executed.stdout, stopReason: executed.stopReason, evidence }
    };
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
    return { issues };
  }
}

interface AuthoritativeAssembly {
  image: NonNullable<ReplayAssemblyOutput['image']>;
  dutBytes: Buffer;
  stdout: string;
  stderr: string;
}

function captureAuthoritativeAssembly(
  context: ReplayAdapterContext,
  output: ReplayAssemblyOutput
): AuthoritativeAssembly {
  if (!output.image || !output.dutBytes) throw new Error('assembler replay did not return a complete executable program');
  if (typeof output.stdout !== 'string' || typeof output.stderr !== 'string') {
    throw new Error('assembler replay returned non-string stdout/stderr');
  }
  // serializeProgramImage validates the complete runtime shape and recomputes the canonical
  // fingerprint. Deserialize its canonical bytes to sever every adapter-owned reference.
  const image = deepFreeze(deserializeProgramImage(serializeProgramImage(output.image)));
  const expectedInputGraph = context.inputGraph.map((unit) => ({
    id: unit.id,
    contentHash: unit.contentHash.toLowerCase()
  }));
  const actualInputGraph = image.inputGraph.map((unit) => ({
    id: unit.id,
    contentHash: unit.contentHash.toLowerCase()
  }));
  if (JSON.stringify(actualInputGraph) !== JSON.stringify(expectedInputGraph)) {
    throw new Error('assembler ProgramImage inputGraph does not match the materialized replay source graph');
  }
  return {
    image,
    dutBytes: Buffer.from(output.dutBytes),
    stdout: output.stdout,
    stderr: output.stderr
  };
}

function isolatedAssemblyValidationView(authoritative: AuthoritativeAssembly): ReplayAssemblyOutput {
  return {
    ok: true,
    image: authoritative.image,
    dutBytes: Buffer.from(authoritative.dutBytes),
    stdout: authoritative.stdout,
    stderr: authoritative.stderr
  };
}

function authoritativeAssemblyResult(authoritative: AuthoritativeAssembly) {
  return { image: authoritative.image, dutBytes: Buffer.from(authoritative.dutBytes) };
}

function captureAuthoritativeExecution(output: ReplayExecutionOutput): Readonly<ReplayExecutionOutput> {
  if (typeof output.ok !== 'boolean' || typeof output.stdout !== 'string' || typeof output.stderr !== 'string'
    || !['halt-loop', 'step-limit', 'error'].includes(output.stopReason)) {
    throw new Error('oracle replay returned an invalid execution result');
  }
  return Object.freeze({
    ok: output.ok,
    stdout: output.stdout,
    stderr: output.stderr,
    stopReason: output.stopReason
  });
}

function isolatedExecutionValidationView(
  authoritative: Readonly<ReplayExecutionOutput>
): ReplayExecutionOutput {
  return { ...authoritative };
}

interface MaterializedSourceSnapshot {
  directory: string;
  files: Array<{ name: string; sha256: string; bytes: number }>;
  maximumBytes: number;
}

interface AdapterStage {
  context: ReplayAdapterContext;
  sourceSnapshot: MaterializedSourceSnapshot;
}

async function createAdapterStage(
  caseDir: string,
  manifest: AsmCaseManifestV2,
  stage: 'assembler' | 'oracle',
  selection: ReplayEngineSelection,
  artifacts: ImmutableEngineArtifactRegistry,
  stdinBytes: Buffer | undefined,
  stageDirectory: string,
  signal?: AbortSignal
): Promise<AdapterStage> {
  const sourceDirectory = path.join(stageDirectory, 'source');
  const source = await materializeSourceGraph(caseDir, manifest.program.sourceGraph!.path, sourceDirectory);
  const sourceSnapshot = await captureMaterializedSourceSnapshot(
    sourceDirectory,
    source.graph.units.map((unit) => path.basename(unit.materializedPath)),
    source.graph.limits.maxBytes
  );
  const inputGraph = deepFreeze(source.graph.units.map((unit) => deepFreeze({
    id: unit.id,
    contentHash: unit.contentHash
  })));
  const configuration = replayStageConfiguration(manifest, stage);
  const workingDirectory = path.join(stageDirectory, 'run');
  const declared = selection.engine.artifact;
  if (!declared || declared.sha256.toLowerCase() !== selection.artifact.sha256.toLowerCase()
    || declared.role !== selection.artifact.role
    || (declared.fileName ?? null) !== (selection.artifact.fileName ?? null)
    || JSON.stringify(declared.dependencies ?? []) !== JSON.stringify(selection.artifact.dependencies ?? [])) {
    throw new Error(`replay engine selection ${selection.engine.id} does not match its declared immutable artifact`);
  }
  const primary = await artifacts.stageForExecution(selection.artifact, path.join(workingDirectory, 'engine'));
  const dependencies = new Map<string, string>();
  for (const dependency of selection.artifact.dependencies ?? []) {
    if (!dependency.role) throw new Error('engine dependency role is required');
    const staged = await artifacts.stageForExecution(dependency, path.join(workingDirectory, 'dependencies', dependency.role));
    dependencies.set(dependency.role, staged.path);
  }
  return {
    sourceSnapshot,
    context: {
      artifactPath: primary.path,
      dependencies,
      sourceRoot: source.rootFile,
      sourceKind: manifest.source.kind,
      inputGraph,
      configuration,
      stdinBytes: stdinBytes ? Buffer.from(stdinBytes) : undefined,
      workingDirectory,
      signal
    }
  };
}

async function captureMaterializedSourceSnapshot(
  directory: string,
  fileNames: string[],
  maximumBytes: number
): Promise<MaterializedSourceSnapshot> {
  const names = [...fileNames].sort();
  if (new Set(names).size !== names.length) throw new Error('materialized source file names are not unique');
  await assertMaterializedSourceDirectoryEntries(directory, names);
  const files = await Promise.all(names.map(async (name) => {
    const file = path.join(directory, name);
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`materialized source is not a regular non-symlink file: ${name}`);
    }
    const bytes = await readBoundedRegularFile(file, {
      maximumBytes,
      expectedBytes: stat.size,
      label: `materialized source ${name}`
    });
    return { name, sha256: sha256Bytes(bytes), bytes: bytes.byteLength };
  }));
  return { directory, files, maximumBytes };
}

async function assertMaterializedSourceUnchanged(snapshot: MaterializedSourceSnapshot): Promise<void> {
  await assertMaterializedSourceDirectoryEntries(
    snapshot.directory,
    snapshot.files.map((file) => file.name)
  );
  for (const expected of snapshot.files) {
    const file = path.join(snapshot.directory, expected.name);
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`adapter changed materialized source file type: ${expected.name}`);
    }
    const bytes = await readBoundedRegularFile(file, {
      maximumBytes: snapshot.maximumBytes,
      expectedBytes: expected.bytes,
      label: `materialized source ${expected.name}`
    });
    if (sha256Bytes(bytes) !== expected.sha256) {
      throw new Error(`adapter changed materialized source bytes: ${expected.name}`);
    }
  }
}

async function assertMaterializedSourceDirectoryEntries(directory: string, expectedNames: string[]): Promise<void> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...expectedNames].sort())
    || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('adapter changed the materialized source tree');
  }
}

function replayStageConfiguration(
  manifest: AsmCaseManifestV2,
  stage: 'assembler' | 'oracle'
): ManifestRunConfiguration {
  const configuration = JSON.parse(JSON.stringify(
    manifest.oracle.runConfiguration!
  )) as NonNullable<AsmCaseManifestV2['oracle']['runConfiguration']>;
  if (stage === 'assembler') {
    const provenance = manifest.program.assembler.legacyProvenance as (NonNullable<
      ManifestEngineInfo['legacyProvenance']
    > & {
      profile?: string;
      runtime?: NonNullable<typeof configuration.runtime>;
      wallClockMs?: number;
      p7RiInstruction?: boolean;
    }) | undefined;
    if (provenance?.profile !== undefined) configuration.profile = provenance.profile;
    if (provenance?.memoryConfiguration !== undefined) {
      configuration.memoryConfiguration = provenance.memoryConfiguration;
    }
    if (provenance?.runtime !== undefined) {
      configuration.runtime = JSON.parse(JSON.stringify(provenance.runtime)) as typeof configuration.runtime;
    }
    if (provenance?.wallClockMs !== undefined) {
      if (!configuration.resourceLimits) throw new Error('assembler replay configuration has no resource limits');
      configuration.resourceLimits.wallClockMs = provenance.wallClockMs;
    }
    if (provenance?.p7RiInstruction !== undefined) {
      if (!configuration.executionOptions) throw new Error('assembler replay configuration has no execution options');
      configuration.executionOptions.p7RiInstruction = provenance.p7RiInstruction;
    }
  }
  return deepFreeze(configuration);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function engineSelection(engine: ManifestEngineInfo): ReplayEngineSelection {
  if (!engine.artifact?.role) throw new Error(`engine ${engine.id} has no registry-resolvable artifact`);
  return snapshotReplayEngineSelection({
    engine,
    artifact: {
      sha256: engine.artifact.sha256,
      role: engine.artifact.role,
      fileName: engine.artifact.fileName,
      dependencies: engine.artifact.dependencies?.map((dependency) => ({ ...dependency }))
    }
  });
}

function snapshotReEvaluateOptions(options: ReEvaluateOptions): ReEvaluateOptionsSnapshot {
  const assembler = options.assembler;
  const oracle = options.oracle;
  const outputRoot = options.outputRoot;
  const outputContainmentRoot = options.outputContainmentRoot;
  const signal = options.signal;
  const requestedNow = options.now;
  if (outputRoot !== undefined && typeof outputRoot !== 'string') {
    throw new Error('outputRoot must be a string');
  }
  if (outputContainmentRoot !== undefined && typeof outputContainmentRoot !== 'string') {
    throw new Error('outputContainmentRoot must be a string');
  }
  const now = requestedNow === undefined ? new Date() : new Date(requestedNow.getTime());
  if (!Number.isFinite(now.getTime())) throw new Error('now must be a valid Date');
  return Object.freeze({
    assembler: snapshotReplayEngineSelection(assembler),
    oracle: snapshotReplayEngineSelection(oracle),
    outputRoot,
    outputContainmentRoot,
    signal,
    now
  });
}

function snapshotReplayEngineSelection(selection: ReplayEngineSelection): ReplayEngineSelection {
  const serializedEngine = JSON.stringify(selection.engine);
  if (serializedEngine === undefined) throw new Error('engine descriptor is not JSON-serializable');
  const engine = JSON.parse(serializedEngine) as ManifestEngineInfo;
  const artifact: EngineArtifactIdentity = {
    sha256: selection.artifact.sha256,
    role: selection.artifact.role,
    fileName: selection.artifact.fileName,
    dependencies: selection.artifact.dependencies?.map((dependency) => ({
      sha256: dependency.sha256,
      role: dependency.role,
      fileName: dependency.fileName
    }))
  };
  return deepFreeze({ engine, artifact });
}

async function loadReplayManifest(
  caseDir: string
): Promise<{ manifest: AsmCaseManifestV2; bytes: Buffer; sha256: string } | { issues: string[] }> {
  let parsed: unknown;
  let bytes: Buffer;
  try {
    bytes = await readReplayManifestBytes(caseDir);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      throw new Error('case manifest is not lossless UTF-8');
    }
    parsed = JSON.parse(text) as unknown;
  }
  catch (error) { return { issues: [`case manifest unavailable: ${error instanceof Error ? error.message : String(error)}`] }; }
  if (!isKnownManifest(parsed)) return { issues: ['case manifest structure/version is unknown'] };
  if (!isManifestV2(parsed)) return { issues: ['manifest v1 is read-only and cannot be exact-replayed'] };
  return { manifest: parsed, bytes, sha256: sha256Bytes(bytes) };
}

async function stableReplayBundleIssues(
  caseDir: string,
  manifest: AsmCaseManifestV2,
  originalManifestBytes: Buffer,
  phase: string
): Promise<string[]> {
  const issues: string[] = [];
  if (!await manifestMatchesOriginal(caseDir, originalManifestBytes, issues, `${phase} bundle verification began`)) {
    return issues;
  }
  issues.push(...await v2ReplayBundleIssues(manifest, caseDir));
  await manifestMatchesOriginal(caseDir, originalManifestBytes, issues, `${phase} bundle verification ended`);
  return issues;
}

async function manifestMatchesOriginal(
  caseDir: string,
  original: Buffer,
  issues: string[],
  phase: string
): Promise<boolean> {
  try {
    if (!original.equals(await readReplayManifestBytes(caseDir))) {
      issues.push(`case manifest changed before ${phase}`);
      return false;
    }
  } catch (error) {
    issues.push(`case manifest became unavailable before ${phase}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  return true;
}

function parseValidatedManifestCopy(bytes: Buffer): AsmCaseManifestV2 {
  // loadReplayManifest already validated these exact bytes. Reparse so an adapter cannot make
  // the post-run integrity check trust a manifest object it received through ReplayAdapterContext.
  return JSON.parse(bytes.toString('utf8')) as AsmCaseManifestV2;
}

async function readVerifiedReplayInput(
  caseDir: string,
  snapshot: { path: string; sha256: string; bytes: number }
): Promise<Buffer> {
  const file = await resolveCaseFile(caseDir, snapshot.path);
  const bytes = await readBoundedRegularFile(file, {
    maximumBytes: maximumReplayStdinBytes,
    expectedBytes: snapshot.bytes,
    label: 'stdin replay snapshot'
  });
  if (bytes.byteLength !== snapshot.bytes || sha256Bytes(bytes) !== snapshot.sha256.toLowerCase()) {
    throw new Error('stdin changed between bundle validation and replay input capture');
  }
  return bytes;
}

async function readReplayManifestBytes(caseDir: string, expectedBytes?: number): Promise<Buffer> {
  return readBoundedRegularFile(path.join(caseDir, 'case.json'), {
    maximumBytes: maximumReplayManifestBytes,
    expectedBytes,
    label: 'case manifest'
  });
}

async function resolveCaseFile(caseDir: string, relativePath: string): Promise<string> {
  if (relativePath.includes('\\') || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
    || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`unsafe replay bundle path: ${relativePath}`);
  }
  const root = await fs.promises.realpath(caseDir);
  const real = await fs.promises.realpath(path.resolve(root, ...relativePath.split('/')));
  const relative = path.relative(root, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('replay bundle path escapes case directory');
  const stat = await fs.promises.lstat(real);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('replay bundle path is not a regular file');
  return real;
}
