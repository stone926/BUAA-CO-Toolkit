#!/usr/bin/env node
/**
 * Conformance runner CLI (JSONL).
 *
 * Usage:
 *   node runner/run-conformance.mjs [--lane legacy-baseline|course-vector|assembly-diff]
 *                                  [--filter <case-id-substring>] [--max-steps N]
 *                                  [--record-golden]
 *
 * Prints one JSON line per case result, then a summary line:
 *   {"type":"case-result","caseId":...,"lane":...,"status":"passed|failed|skipped|error",...}
 *   {"type":"summary","lanes":...,"passed":N,"failed":N,"skipped":N,"error":N}
 *
 * Exit code 0 when no case failed or errored; 1 otherwise.
 *
 * Regular runs never update expected data; `--record-golden` is the only
 * command that writes marsGolden files and must be run explicitly.
 */
import { loadCorpusManifest } from './caseManifest.mjs';
import { runLegacyBaselineCase } from './lanes/legacy-baseline.mjs';
import { runCourseVectorCase } from './lanes/course-vector.mjs';
import { runAssemblyDiffCase } from './lanes/assembly-diff.mjs';

function parseArgs(argv) {
  const options = { lanes: new Set(), filter: undefined, maxSteps: undefined, recordGolden: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--lane') {
      options.lanes.add(argv[++index]);
    } else if (arg === '--filter') {
      options.filter = argv[++index];
    } else if (arg === '--max-steps') {
      options.maxSteps = Number(argv[++index]);
    } else if (arg === '--record-golden') {
      options.recordGolden = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const laneRunners = {
  'legacy-baseline': runLegacyBaselineCase,
  'course-vector': runCourseVectorCase,
  'assembly-diff': runAssemblyDiffCase
};

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.lanes.size) {
    for (const lane of Object.keys(laneRunners)) {
      options.lanes.add(lane);
    }
  }
  for (const lane of options.lanes) {
    if (!laneRunners[lane]) {
      console.error(`Unknown lane: ${lane}. Available: ${Object.keys(laneRunners).join(', ')}`);
      process.exitCode = 2;
      return;
    }
  }

  const manifest = loadCorpusManifest();
  const runnerOptions = { maxSteps: options.maxSteps, recordGolden: options.recordGolden };
  const counts = { passed: 0, failed: 0, skipped: 0, error: 0, recorded: 0 };

  for (const manifestCase of manifest.cases) {
    if (options.filter && !manifestCase.caseId.includes(options.filter)) {
      continue;
    }
    for (const lane of manifestCase.lanes) {
      if (!options.lanes.has(lane)) {
        continue;
      }
      const result = laneRunners[lane](manifestCase, runnerOptions);
      counts[result.status === 'recorded' ? 'recorded' : result.status]++;
      process.stdout.write(`${JSON.stringify({ type: 'case-result', ...result })}\n`);
    }
  }

  process.stdout.write(`${JSON.stringify({ type: 'summary', lanes: [...options.lanes].sort(), ...counts })}\n`);
  if (counts.failed > 0 || counts.error > 0) {
    process.exitCode = 1;
  }
}

main();
