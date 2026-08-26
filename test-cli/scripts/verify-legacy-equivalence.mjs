#!/usr/bin/env node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  referenceRoles,
  resolveVerifiedReference
} from '../../conformance/mips/reference/referenceAssets.mjs';
import {
  assertEvidence as assert,
  compareLanes,
  expectedProfiles,
  readLaneManifest,
  sha256File
} from './legacy-equivalence-evidence.mjs';

const schemaVersion = 2;
const providerMigrationCommit = '6f67c42311424418bcb4948695e14b8fa8bcebf9';
// The parent of 6f67c42 (provider-neutral contracts) is the last direct-only
// production tree, so this evidence genuinely compares against pre-migration
// runMarsFile rather than an early post-migration hardening snapshot.
const baselineCommit = '044bab029bfb882c4607dc34d1c7e51ab49a1c74';
const baselineTree = '93efd857c0b4500080d193169cb0a1041236d613';
const baselineDirectMipsBlob = 'db9d8fc5e729f41c84190dad0961160f6a52bda6';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const testCliRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(testCliRoot, '..');
const outputFile = process.env.CO_LEGACY_EQUIVALENCE_OUTPUT
  ? path.resolve(process.env.CO_LEGACY_EQUIVALENCE_OUTPUT)
  : undefined;

let tempRoot;
let worktreePath;
let worktreeAdded = false;
let evidence;
let failure;

try {
  verifyBaselineObject();
  const references = resolveReferences();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'co-legacy-equivalence-'));
  worktreePath = path.join(tempRoot, 'baseline-worktree');
  addBaselineWorktree(worktreePath);
  worktreeAdded = true;

  const driverSources = installBaselineDriver(worktreePath);
  assertHistoricalProductionTree(worktreePath);
  installBaselineDependencies(worktreePath);

  const inputFile = path.join(tempRoot, 'input.json');
  const baselineArtifacts = path.join(tempRoot, 'baseline-artifacts');
  const currentArtifacts = path.join(tempRoot, 'current-artifacts');
  const baselineManifestFile = path.join(tempRoot, 'baseline-manifest.json');
  const currentManifestFile = path.join(tempRoot, 'current-manifest.json');
  fs.writeFileSync(inputFile, `${JSON.stringify({
    schemaVersion,
    java: process.env.JAVA ?? 'java',
    references: references.map((reference) => ({
      role: reference.role,
      fileName: reference.fileName,
      jar: reference.file,
      sha256: reference.verifiedSha256
    }))
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

  buildAndRunBaseline(worktreePath, inputFile, baselineArtifacts, baselineManifestFile);
  runCurrentLane(inputFile, currentArtifacts, currentManifestFile);

  const baselineManifest = readLaneManifest(baselineManifestFile, schemaVersion, 'baseline-direct-runMarsFile');
  const currentManifest = readLaneManifest(currentManifestFile, schemaVersion, 'current-legacy-provider');
  const comparisons = compareLanes({
    baselineManifest,
    currentManifest,
    baselineArtifacts,
    currentArtifacts,
    references
  });
  const currentHead = git(['rev-parse', 'HEAD']).stdout.trim();
  const currentTree = git(['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const javaVersion = run(process.env.JAVA ?? 'java', ['-version'], { cwd: repoRoot, allowStderr: true });
  evidence = {
    kind: 'legacy-equivalence-evidence',
    schemaVersion,
    status: 'passed',
    generatedAt: new Date().toISOString(),
    baseline: {
      commit: baselineCommit,
      tree: baselineTree,
      directEntry: 'src/mips.ts#runMarsFile',
      directMipsBlob: baselineDirectMipsBlob,
      providerMigrationCommit,
      relation: 'direct-parent-of-provider-migration',
      providersDirectoryAbsent: true,
      artifactIdentityEvidence: 'sha256-before-and-after-each-historical-case',
      executionIsolation: 'detached-temporary-worktree-and-separate-node-process',
      injectedDriverSha256: driverSources
    },
    current: {
      headCommit: currentHead,
      headTree: currentTree,
      trackedWorktreeDirty: git(['status', '--porcelain=v1', '--untracked-files=no']).stdout.trim() !== '',
      providerEntry: 'src/mips/providers/legacyMarsProvider.ts#LegacyMarsProvider',
      providerSourceSha256: sha256File(path.join(repoRoot, 'src', 'mips', 'providers', 'legacyMarsProvider.ts')),
      marsSourceSha256: sha256File(path.join(repoRoot, 'src', 'mips.ts')),
      currentDriverSha256: sha256File(path.join(testCliRoot, 'src', 'legacyEquivalence.ts')),
      orchestratorSha256: sha256File(path.join(scriptDir, 'verify-legacy-equivalence.mjs')),
      comparatorSha256: sha256File(path.join(scriptDir, 'legacy-equivalence-evidence.mjs'))
    },
    runtime: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
      java: firstNonEmptyLine(`${javaVersion.stderr}\n${javaVersion.stdout}`)
    },
    references: references.map((reference) => ({
      role: reference.role,
      fileName: reference.fileName,
      bytes: reference.bytes,
      sha256: reference.verifiedSha256,
      sourceCommit: reference.sourceCommit
    })),
    cases: comparisons,
    summary: {
      total: comparisons.length,
      passed: comparisons.length,
      successCases: comparisons.filter((item) => item.scenario === 'success').length,
      failureVerdictCases: comparisons.filter((item) => item.scenario === 'assembly-failure').length,
      profiles: expectedProfiles,
      referenceRoles: references.map((reference) => reference.role),
      exactFields: ['machineCodeBytes', 'traceBytes', 'verdict', 'haltPc']
    }
  };
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
} finally {
  try {
    cleanupTemporaryWorktree();
  } catch (error) {
    const cleanupFailure = error instanceof Error ? error : new Error(String(error));
    failure = failure
      ? new Error(`${failure.message}; cleanup also failed: ${cleanupFailure.message}`)
      : cleanupFailure;
  }
}

if (failure) {
  evidence = {
    kind: 'legacy-equivalence-evidence',
    schemaVersion,
    status: 'failed',
    generatedAt: new Date().toISOString(),
    baseline: { commit: baselineCommit, tree: baselineTree, directMipsBlob: baselineDirectMipsBlob },
    error: failure.stack ?? failure.message
  };
}

writeEvidence(evidence);
if (failure) {
  process.stderr.write(`legacy-equivalence: ${failure.stack ?? failure.message}\n`);
  process.exitCode = 1;
} else {
  for (const item of evidence.cases) {
    process.stdout.write(`${JSON.stringify({ kind: 'legacy-equivalence-case', ...item })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ kind: 'legacy-equivalence-summary', ...evidence.summary })}\n`);
}

function verifyBaselineObject() {
  const actualCommit = git(['rev-parse', `${baselineCommit}^{commit}`]).stdout.trim();
  const actualTree = git(['rev-parse', `${baselineCommit}^{tree}`]).stdout.trim();
  const actualBlob = git(['rev-parse', `${baselineCommit}:src/mips.ts`]).stdout.trim();
  assert(actualCommit === baselineCommit, `baseline commit mismatch: ${actualCommit}`);
  assert(actualTree === baselineTree, `baseline tree mismatch: ${actualTree}`);
  assert(actualBlob === baselineDirectMipsBlob, `baseline direct mips blob mismatch: ${actualBlob}`);
  const migrationParent = git(['rev-parse', `${providerMigrationCommit}^`]).stdout.trim();
  assert(migrationParent === baselineCommit, `baseline is not the direct parent of provider migration ${providerMigrationCommit}`);
  const providerFiles = git(['ls-tree', '-r', '--name-only', baselineCommit, '--', 'src/mips/providers']).stdout.trim();
  assert(providerFiles === '', `pre-migration baseline unexpectedly contains provider files: ${providerFiles}`);
}

function resolveReferences() {
  return [
    resolveVerifiedReference(referenceRoles.stockAssembler),
    resolveVerifiedReference(referenceRoles.legacyCourseExecutor)
  ];
}

function addBaselineWorktree(target) {
  assert(!fs.existsSync(target), `temporary worktree target already exists: ${target}`);
  git(['worktree', 'add', '--detach', target, baselineCommit]);
  const actual = runGitAt(target, ['rev-parse', 'HEAD']).stdout.trim();
  assert(actual === baselineCommit, `temporary worktree checked out ${actual}, expected ${baselineCommit}`);
}

function installBaselineDriver(target) {
  const relativeSources = [
    'src/legacyBaseline.ts',
    'src/legacyEquivalenceContract.ts',
    'src/legacyEquivalenceRuntime.ts'
  ];
  const digests = {};
  for (const relative of relativeSources) {
    const source = path.join(testCliRoot, relative);
    const destination = path.join(target, 'test-cli', relative);
    assert(fs.existsSync(source), `baseline driver source is missing: ${source}`);
    assert(!fs.existsSync(destination), `baseline driver destination unexpectedly exists in fixed commit: ${destination}`);
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    digests[relative] = sha256File(source);
  }
  const baselineSource = fs.readFileSync(path.join(testCliRoot, 'src', 'legacyBaseline.ts'), 'utf8');
  const currentSource = fs.readFileSync(path.join(testCliRoot, 'src', 'legacyEquivalence.ts'), 'utf8');
  assert(baselineSource.includes("from '../../src/mips'"), 'baseline driver must import the historical direct mips entry');
  assert(!baselineSource.includes('legacyMarsProvider'), 'baseline driver must not import LegacyMarsProvider');
  assert(currentSource.includes("from '../../src/mips/providers/legacyMarsProvider'"), 'current driver must import LegacyMarsProvider');
  assert(!/\brunMarsFile\b/.test(currentSource), 'current driver must not import or call runMarsFile directly');
  return digests;
}

function assertHistoricalProductionTree(target) {
  const diff = runGitAt(target, ['diff', '--quiet', 'HEAD', '--'], { acceptStatuses: [0, 1] });
  assert(diff.status === 0, 'fixed historical checkout has tracked modifications');
  const actualBlob = runGitAt(target, ['hash-object', 'src/mips.ts']).stdout.trim();
  assert(actualBlob === baselineDirectMipsBlob, 'historical direct mips source changed after checkout');
}

function installBaselineDependencies(target) {
  const npmCli = resolveNpmCli();
  run(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: path.join(target, 'test-cli')
  });
}

function buildAndRunBaseline(target, input, artifacts, manifest) {
  const buildScript = path.join(target, 'test-cli', 'scripts', 'build.mjs');
  run(process.execPath, [buildScript], { cwd: path.join(target, 'test-cli') });
  const entry = path.join(target, 'test-cli', 'dist', 'test-cli', 'src', 'legacyBaseline.js');
  assert(fs.existsSync(entry), 'baseline build did not emit the direct runner');
  run(process.execPath, [entry, '--input', input, '--artifacts', artifacts, '--manifest', manifest], {
    cwd: path.join(target, 'test-cli')
  });
}

function runCurrentLane(input, artifacts, manifest) {
  const entry = path.join(testCliRoot, 'dist', 'test-cli', 'src', 'legacyEquivalence.js');
  assert(fs.existsSync(entry), 'current lane is not built; run npm --prefix test-cli run build first');
  run(process.execPath, [entry, '--input', input, '--artifacts', artifacts, '--manifest', manifest], {
    cwd: testCliRoot
  });
}

function cleanupTemporaryWorktree() {
  let cleanupError;
  if (worktreeAdded && worktreePath) {
    try {
      git(['worktree', 'remove', '--force', worktreePath]);
      worktreeAdded = false;
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    git(['worktree', 'prune']);
  } catch (error) {
    cleanupError ??= error;
  }
  if (tempRoot && fs.existsSync(tempRoot)) {
    const resolvedTemp = fs.realpathSync(tempRoot);
    assert(path.dirname(resolvedTemp) === fs.realpathSync(os.tmpdir()), `refusing to remove unexpected temp path: ${resolvedTemp}`);
    try {
      fs.rmSync(resolvedTemp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

function writeEvidence(value) {
  if (outputFile) {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
}

function git(args, options = {}) {
  return run('git', ['-C', repoRoot, ...args], { cwd: repoRoot, ...options });
}

function runGitAt(cwd, args, options = {}) {
  return run('git', ['-C', cwd, ...args], { cwd, ...options });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...options.env }
  });
  if (result.error) {
    throw result.error;
  }
  const accepted = options.acceptStatuses ?? [0];
  if (!accepted.includes(result.status)) {
    throw new Error([
      `command failed (${result.status}): ${command} ${args.join(' ')}`,
      result.stdout?.trim(),
      result.stderr?.trim()
    ].filter(Boolean).join('\n'));
  }
  if (result.stderr && !options.allowStderr && result.status === 0 && command === process.execPath && args[0]?.endsWith('build.mjs')) {
    process.stderr.write(result.stderr);
  }
  return result;
}

function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter(Boolean);
  const npmCli = candidates.find((candidate) => fs.existsSync(candidate));
  assert(npmCli, `cannot locate npm-cli.js beside Node runtime ${process.execPath}`);
  return npmCli;
}

function firstNonEmptyLine(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? 'unknown';
}
