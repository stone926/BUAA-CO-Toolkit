#!/usr/bin/env node
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixedBenchmarkMatrix, summarizeFixedSamples } from './fixed-runner-benchmark.mjs';

const shaPattern = /^[0-9a-f]{64}$/;
const allowedRunnerIds = new Set(['github-hosted:ubuntu-24.04', 'github-hosted:windows-2025']);
const runnerContracts = Object.freeze({
  'github-hosted:ubuntu-24.04': { platform: 'linux', imageOsPattern: /^ubuntu24:/ },
  'github-hosted:windows-2025': { platform: 'win32', imageOsPattern: /^win25:/ }
});
const benchRoot = path.dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(fs.readFileSync(path.join(benchRoot, 'benchmark-matrix.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(`benchmark candidate: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateFixedBenchmark(candidate, options = {}) {
  assert(isObject(candidate), 'root must be an object');
  const allowed = ['schemaRevision', 'runnerRevision', 'matrixRevision', 'measurementClass', 'baselineEligible', 'lifecycle', 'warmMeasurementsPresent', 'warmExclusionReason', 'runner', 'runnerFingerprint', 'reference', 'matrixSha256', 'samplePolicy', 'cells', 'rawSamples', 'summaries', 'integrity'];
  assert(Object.keys(candidate).every((key) => allowed.includes(key)), 'root contains unknown fields');
  assert(candidate.schemaRevision === 1 && candidate.runnerRevision === 2 && candidate.matrixRevision === matrix.matrixRevision, 'schema/runner/matrix revision mismatch');
  const quick = candidate.measurementClass === 'controlled-runner-smoke';
  assert(quick || candidate.measurementClass === 'controlled-runner-baseline-candidate', 'measurementClass is invalid');
  assert(candidate.lifecycle === 'cold-end-to-end', 'MARS lifecycle must be cold-end-to-end');
  assert(candidate.warmMeasurementsPresent === false, 'MARS warm data is forbidden until persistent reset equivalence is proven');
  assert(candidate.warmExclusionReason === matrix.marsCold.warmExclusionReason, 'warm exclusion reason drifted');
  const expectedCells = buildFixedBenchmarkMatrix(quick);
  assert(same(candidate.cells, expectedCells), 'cells do not match the frozen matrix');
  assert(candidate.matrixSha256 === hash(matrix), 'matrixSha256 is stale');

  validateRunnerMetadata(candidate.runner);
  assert(candidate.runnerFingerprint === hash(candidate.runner), 'runnerFingerprint is stale');

  assert(isObject(candidate.reference), 'reference metadata is required');
  assert(candidate.reference.role === 'mars-assembler-v0.6.3' && candidate.reference.sha256 === '599957c96b4e94c267a117d548eb5a1bd32d72d879a831a5f695a648c1eafb31', 'reference role/hash is not the pinned MARS baseline');
  assert(shaPattern.test(candidate.reference.sha256), 'reference SHA is invalid');
  assert(isObject(candidate.samplePolicy), 'samplePolicy is required');
  const sampleCount = candidate.samplePolicy.independentSamplesPerCell;
  assert(Number.isSafeInteger(sampleCount) && sampleCount > 0, 'sample count is invalid');
  assert(candidate.samplePolicy.percentileMethod === 'nearest-rank-v1' && candidate.samplePolicy.confidenceInterval === matrix.sampling.confidenceInterval, 'statistical policy drifted');
  assert(Array.isArray(candidate.rawSamples) && candidate.rawSamples.length === expectedCells.length * sampleCount, 'raw sample count is incomplete');
  const seen = new Set();
  for (const sample of candidate.rawSamples) {
    assert(isObject(sample), 'raw sample must be an object');
    assert(expectedCells.some((cell) => cell.cellId === sample.cellId), `unknown sample cell ${sample.cellId}`);
    assert(Number.isSafeInteger(sample.sampleIndex) && sample.sampleIndex >= 0 && sample.sampleIndex < sampleCount, 'sampleIndex is invalid');
    const key = `${sample.cellId}:${sample.sampleIndex}`;
    assert(!seen.has(key), `duplicate sample ${key}`);
    seen.add(key);
    assert(sample.ok === true && sample.error === null && sample.exitCode === 0, `${key} is not successful`);
    assert(Number.isFinite(sample.wallClockMs) && sample.wallClockMs >= 0, `${key} wallClockMs is invalid`);
    assert(Number.isFinite(sample.cpuMs) && sample.cpuMs >= 0, `${key} cpuMs is invalid`);
    assert(Number.isSafeInteger(sample.peakRssBytes) && sample.peakRssBytes > 0, `${key} peakRssBytes is invalid`);
    assert(Number.isSafeInteger(sample.stdoutBytes) && sample.stdoutBytes >= 0 && Number.isSafeInteger(sample.stderrBytes) && sample.stderrBytes >= 0, `${key} byte counts are invalid`);
  }
  const recomputed = expectedCells.map((cell) => summarizeFixedSamples(cell, candidate.rawSamples.filter((sample) => sample.cellId === cell.cellId)));
  assert(same(candidate.summaries, recomputed), 'p50/p95/CI or CPU/RSS summaries are stale');
  const eligible = !quick && sampleCount >= matrix.sampling.minimumIndependentSamples;
  assert(candidate.baselineEligible === eligible, 'baselineEligible is inconsistent with matrix/sample policy');
  if (options.requireEligible) assert(candidate.baselineEligible, 'candidate is smoke-only or undersampled');
  assert(isObject(candidate.integrity) && candidate.integrity.algorithm === 'sha256-canonical-json-v1', 'integrity algorithm is invalid');
  const { integrity: _integrity, ...payload } = candidate;
  assert(candidate.integrity.payloadSha256 === hash(payload), 'payloadSha256 is stale');
  return candidate;
}

export function validateRunnerMetadata(runner) {
  assert(isObject(runner), 'runner metadata is required');
  const runnerFields = ['id', 'imageVersion', 'cpuPolicy', 'concurrency', 'platform', 'arch', 'cpuModel', 'logicalCpuCount', 'totalMemoryBytes', 'nodeVersion', 'javaVersion', 'ci'];
  assert(Object.keys(runner).every((key) => runnerFields.includes(key)) && runnerFields.every((key) => Object.hasOwn(runner, key)), 'runner metadata fields are incomplete/unknown');
  assert(allowedRunnerIds.has(runner.id), `runner.id must be one of ${[...allowedRunnerIds].join(', ')}`);
  const contract = runnerContracts[runner.id];
  assert(runner.platform === contract.platform, `${runner.id} must report platform ${contract.platform}`);
  assert(runner.arch === 'x64', 'controlled baseline runner architecture must be x64');
  assert(typeof runner.imageVersion === 'string' && /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/.test(runner.imageVersion) && contract.imageOsPattern.test(runner.imageVersion), 'runner image version must match the selected hosted image and contain a revision');
  assert(typeof runner.cpuPolicy === 'string' && runner.cpuPolicy.length > 0, 'runner CPU policy is required');
  assert(runner.concurrency === 1, 'runner concurrency must be 1');
  assert(typeof runner.cpuModel === 'string' && runner.cpuModel.length > 0 && runner.cpuModel !== 'unknown', 'CPU model is required');
  assert(Number.isSafeInteger(runner.logicalCpuCount) && runner.logicalCpuCount > 0, 'logical CPU count is invalid');
  assert(Number.isSafeInteger(runner.totalMemoryBytes) && runner.totalMemoryBytes > 0, 'total memory is invalid');
  assert(/^v24\./.test(runner.nodeVersion), 'controlled baseline requires Node 24');
  assert(/(?:version\s+"?25(?:\.|"|\s)|openjdk\s+25(?:\.|\s))/i.test(runner.javaVersion), 'controlled baseline requires Java 25');
  assert(isObject(runner.ci), 'GitHub Actions provenance is required');
  const ciFields = ['provider', 'repository', 'workflowRef', 'eventName', 'job', 'runId', 'runAttempt', 'commitSha', 'runnerEnvironment', 'runnerName', 'runnerOs', 'runnerArch', 'runUrl'];
  assert(Object.keys(runner.ci).every((key) => ciFields.includes(key)) && ciFields.every((key) => Object.hasOwn(runner.ci, key)), 'GitHub Actions provenance fields are incomplete/unknown');
  assert(runner.ci.provider === 'github-actions' && runner.ci.repository === 'stone926/BUAA-CO-Toolkit', 'GitHub Actions repository provenance is invalid');
  assert(runner.ci.eventName === 'workflow_dispatch' && runner.ci.job === 'fixed-mars-benchmark', 'benchmark must originate from the manual fixed-mars-benchmark job');
  assert(runner.ci.runnerEnvironment === 'github-hosted', 'benchmark provenance must identify a GitHub-hosted runner');
  assert(runner.ci.runnerOs === (contract.platform === 'linux' ? 'Linux' : 'Windows') && runner.ci.runnerArch === 'X64', 'GitHub runner OS/architecture does not match runner.id');
  assert(typeof runner.ci.runnerName === 'string' && runner.ci.runnerName.trim().length > 0, 'GitHub runner name is required');
  assert(/^\d+$/.test(runner.ci.runId) && /^[1-9]\d*$/.test(runner.ci.runAttempt), 'GitHub run ID/attempt is invalid');
  assert(/^[0-9a-f]{40}$/.test(runner.ci.commitSha), 'GitHub commit SHA is invalid');
  assert(runner.ci.workflowRef === 'stone926/BUAA-CO-Toolkit/.github/workflows/ci.yml@refs/heads/main', 'GitHub workflow ref must be the protected main CI workflow');
  assert(runner.ci.runUrl === `https://github.com/stone926/BUAA-CO-Toolkit/actions/runs/${runner.ci.runId}/attempts/${runner.ci.runAttempt}`, 'GitHub run URL is inconsistent');
  return runner;
}

export function parseArgs(argv) {
  const options = { input: undefined, requireEligible: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--input') options.input = argv[++index];
    else if (argv[index] === '--require-eligible') options.requireEligible = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!options.input || options.input.startsWith('--')) throw new Error('--input is required');
  return options;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const candidate = validateFixedBenchmark(JSON.parse(fs.readFileSync(options.input, 'utf8')), options);
    process.stdout.write(`benchmark candidate OK: runner=${candidate.runner.id}, cells=${candidate.cells.length}, samples=${candidate.rawSamples.length}, eligible=${candidate.baselineEligible}${os.EOL}`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}${os.EOL}`);
    process.exitCode = 1;
  }
}
