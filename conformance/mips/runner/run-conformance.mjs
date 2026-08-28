#!/usr/bin/env node
/** Fail-closed conformance runner CLI (JSONL). */
import { loadCorpusManifest } from './caseManifest.mjs';
import { runLegacyBaselineCase } from './lanes/legacy-baseline.mjs';
import { runCourseVectorCase } from './lanes/course-vector.mjs';
import { runAssemblyDiffCase } from './lanes/assembly-diff.mjs';

const laneRunners = Object.freeze({
  'legacy-baseline': runLegacyBaselineCase,
  'course-vector': runCourseVectorCase,
  'assembly-diff': runAssemblyDiffCase
});
const defaultRequiredLanes = ['legacy-baseline', 'course-vector'];
const resultStatuses = new Set(['passed', 'validated', 'failed', 'skipped', 'error', 'recorded']);

function nextValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = { lanes: new Set(), filter: undefined, maxSteps: undefined, recordGolden: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--lane') {
      options.lanes.add(nextValue(argv, index, arg));
      index++;
    } else if (arg === '--filter') {
      options.filter = nextValue(argv, index, arg);
      index++;
    } else if (arg === '--max-steps') {
      const raw = nextValue(argv, index, arg);
      options.maxSteps = Number(raw);
      if (!Number.isSafeInteger(options.maxSteps) || options.maxSteps <= 0) {
        throw new Error(`--max-steps must be a positive safe integer, got ${raw}`);
      }
      index++;
    } else if (arg === '--record-golden') {
      options.recordGolden = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.lanes.size) {
    for (const lane of defaultRequiredLanes) {
      options.lanes.add(lane);
    }
  }
  for (const lane of options.lanes) {
    if (!laneRunners[lane]) {
      throw new Error(`unknown lane: ${lane}. Available: ${Object.keys(laneRunners).join(', ')}`);
    }
  }
  if (options.recordGolden && (options.lanes.size !== 1 || !options.lanes.has('legacy-baseline'))) {
    throw new Error('--record-golden requires exactly --lane legacy-baseline');
  }
  return options;
}

function emptyLaneCounts() {
  return { selected: 0, passed: 0, validated: 0, failed: 0, skipped: 0, error: 0, recorded: 0 };
}

function main() {
  let options;
  let manifest;
  try {
    options = parseArgs(process.argv.slice(2));
    manifest = loadCorpusManifest();
  } catch (error) {
    process.stderr.write(`Conformance configuration error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }

  const runnerOptions = {
    maxSteps: options.maxSteps,
    recordGolden: options.recordGolden,
    corpusCandidate: manifest.candidate
  };
  const counts = { passed: 0, validated: 0, failed: 0, skipped: 0, error: 0, recorded: 0 };
  const perLane = Object.fromEntries([...options.lanes].map((lane) => [lane, emptyLaneCounts()]));

  for (const manifestCase of manifest.cases) {
    if (options.filter && !manifestCase.caseId.includes(options.filter)) {
      continue;
    }
    for (const lane of manifestCase.lanes) {
      if (!options.lanes.has(lane)) {
        continue;
      }
      perLane[lane].selected++;
      let result;
      try {
        result = laneRunners[lane](manifestCase, runnerOptions);
      } catch (error) {
        result = {
          caseId: manifestCase.caseId,
          lane,
          status: 'error',
          message: error instanceof Error ? error.message : String(error)
        };
      }
      if (!result || result.caseId !== manifestCase.caseId || result.lane !== lane || !resultStatuses.has(result.status)) {
        result = {
          caseId: manifestCase.caseId,
          lane,
          status: 'error',
          message: 'lane returned an invalid result schema/status'
        };
      }
      counts[result.status]++;
      perLane[lane][result.status]++;
      process.stdout.write(`${JSON.stringify({ type: 'case-result', ...result })}\n`);
    }
  }

  let gateFailed = counts.failed > 0 || counts.error > 0 || counts.skipped > 0;
  for (const [lane, laneCounts] of Object.entries(perLane)) {
    if (laneCounts.selected === 0) {
      gateFailed = true;
      counts.error++;
      laneCounts.error++;
      process.stdout.write(`${JSON.stringify({
        type: 'lane-error',
        lane,
        status: 'error',
        message: 'required lane selected zero cases'
      })}\n`);
    }
  }
  if (!options.recordGolden && counts.recorded > 0) {
    gateFailed = true;
  }
  process.stdout.write(`${JSON.stringify({
    type: 'summary',
    gate: 'runner',
    lanes: [...options.lanes].sort(),
    required: false,
    perLane,
    ...counts
  })}\n`);
  if (gateFailed) {
    process.exitCode = 1;
  }
}

main();
