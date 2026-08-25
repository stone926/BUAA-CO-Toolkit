#!/usr/bin/env node
/**
 * Pinned MARS benchmark harness (plan section 8.1).
 *
 * This phase measures cold, one-JVM-per-cell smoke workloads only. It does not
 * establish a fixed-runner baseline, warm-worker data, an SLO, or an ADR. A
 * baseline still requires an externally provisioned fixed runner with its CPU
 * policy/concurrency recorded and a separately reviewed ADR.
 *
 * Usage: node bench/mars-benchmark.mjs [--quick]
 *   --quick: one 10-word / 1K-step / trace-off harness smoke cell.
 *   default: 4 word counts x 3 step limits x 2 trace modes, all plain workload.
 *
 * Stdout is JSONL: one benchmark-metadata line, benchmark-cell lines, then one
 * benchmark-summary line. Any setup/cell/cleanup failure makes the summary
 * `ok:false` and the process exit non-zero.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceRoles, resolveVerifiedReference } from '../reference/referenceAssets.mjs';
import { effectiveMarsMaxSteps } from '../runner/marsRunner.mjs';

export { effectiveMarsMaxSteps } from '../runner/marsRunner.mjs';

export const benchmarkSchemaRevision = 2;
export const benchmarkRunnerRevision = 2;
export const measurementClass = 'local-cold-smoke';

const fullWordCounts = Object.freeze([10, 200, 1000, 4096]);
const fullStepLimits = Object.freeze([1000, 65536, 1000000]);
const fullTraceModes = Object.freeze(['off', 'coL2']);

export function parseBenchmarkArgs(argv) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) {
    throw new Error('benchmark arguments must be an array of strings');
  }
  let quick = false;
  for (const arg of argv) {
    if (arg === '--quick' && !quick) {
      quick = true;
      continue;
    }
    if (arg === '--quick') {
      throw new Error('--quick may be specified only once');
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return Object.freeze({ quick });
}

export function buildBenchmarkMatrix(options) {
  if (!options || typeof options.quick !== 'boolean') {
    throw new Error('benchmark options must contain boolean quick');
  }
  const wordCounts = options.quick ? [10] : fullWordCounts;
  const stepLimits = options.quick ? [1000] : fullStepLimits;
  const traceModes = options.quick ? ['off'] : fullTraceModes;
  const cells = [];
  for (const wordCount of wordCounts) {
    for (const traceMode of traceModes) {
      for (const requestedSteps of stepLimits) {
        cells.push(Object.freeze({
          wordCount,
          requestedSteps,
          effectiveMaxSteps: effectiveMarsMaxSteps(requestedSteps),
          traceMode,
          workload: 'plain',
          processModel: 'cold-jvm-per-cell'
        }));
      }
    }
  }
  return Object.freeze(cells);
}

export function generateAsm(wordCount) {
  if (!Number.isSafeInteger(wordCount) || wordCount < 2 || wordCount > 4096) {
    throw new Error(`wordCount must be an integer in [2, 4096], got ${wordCount}`);
  }
  const lines = ['.text'];
  const payload = wordCount - 2;
  for (let index = 0; index < payload; index++) {
    lines.push(index % 2 === 0 ? `    ori $t0, $0, ${(index & 0xffff).toString(16)}` : '    addu $t1, $t1, $t0');
  }
  lines.push('_end:', '    beq $0, $0, _end', '    nop');
  return `${lines.join('\n')}\n`;
}

export function summarizeCells(planned, results, infrastructureErrors = 0) {
  if (
    !Number.isSafeInteger(planned)
    || planned < 0
    || !Array.isArray(results)
    || !Number.isSafeInteger(infrastructureErrors)
    || infrastructureErrors < 0
  ) {
    throw new Error('invalid benchmark summary input');
  }
  const passed = results.filter((result) => result.ok === true).length;
  const failed = results.length - passed;
  const completed = results.length;
  return Object.freeze({
    planned,
    completed,
    passed,
    failed,
    infrastructureErrors,
    aborted: completed < planned,
    ok: completed === planned && failed === 0 && infrastructureErrors === 0
  });
}

function inspectJava(spawn, executable) {
  const result = spawn(executable, ['-version'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`Java probe failed: ${result.error?.message ?? `exit ${result.status}`}`);
  }
  const combined = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  const version = combined.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!version) {
    throw new Error('Java probe returned no version text');
  }
  return version;
}

function executeCell(cell, index, temporaryRoot, context) {
  const source = generateAsm(cell.wordCount);
  const asmFile = path.join(temporaryRoot, `cell-${String(index).padStart(3, '0')}.asm`);
  context.writeFile(asmFile, source);

  // Re-resolve by role and re-hash immediately before every benchmark JVM.
  const reference = context.resolveReference(referenceRoles.stockAssembler);
  if (reference.verifiedSha256 !== context.referenceSha256) {
    throw new Error('pinned reference fingerprint changed during benchmark run');
  }
  // Make assembly/runtime failures observable through the process exit status,
  // matching the conformance runner rather than relying only on output text.
  const cliOptions = ['nc', 'mc', 'FixedCompactLargeText', 'ae1', 'se1'];
  if (cell.traceMode === 'coL2') {
    cliOptions.push('coL2');
  }
  cliOptions.push(String(cell.effectiveMaxSteps), asmFile);
  const startedAtEpochMs = context.now();
  const result = context.spawn(context.javaExecutable, ['-jar', reference.file, ...cliOptions], {
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true
  });
  const wallClockMs = context.now() - startedAtEpochMs;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const outputHasCliError = /Invalid Command Argument|Error in .* line|Processing terminated due to errors/i.test(`${stdout}\n${stderr}`);
  const traceMissing = cell.traceMode === 'coL2' && !/^@PC/im.test(stdout);
  const ok = !result.error && result.status === 0 && !outputHasCliError && !traceMissing;
  let error = null;
  if (result.error) {
    error = result.error.message;
  } else if (result.status !== 0) {
    error = `Java exited ${result.status}`;
  } else if (outputHasCliError) {
    error = 'MARS reported a CLI/assembly/runtime error';
  } else if (traceMissing) {
    error = 'coL2 cell produced no instruction trace';
  }
  return Object.freeze({
    type: 'benchmark-cell',
    schemaRevision: benchmarkSchemaRevision,
    runnerRevision: benchmarkRunnerRevision,
    index,
    cell,
    startedAtEpochMs,
    wallClockMs,
    exitCode: result.status,
    signal: result.signal ?? null,
    ok,
    error,
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    stderrHead: ok ? null : stderr.slice(0, 500),
    childPeakRssKb: null,
    resourceMeasurementStatus: 'not-collected-by-phase0-harness',
    referenceSha256: reference.verifiedSha256
  });
}

function emitJson(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function baseSummary(startedAtEpochMs, wallClockMs, counts) {
  return {
    type: 'benchmark-summary',
    schemaRevision: benchmarkSchemaRevision,
    runnerRevision: benchmarkRunnerRevision,
    measurementClass,
    fixedRunnerBaseline: false,
    baselineEligible: false,
    baselineStatus: 'not-established; requires external fixed-runner measurement and reviewed ADR',
    startedAtEpochMs,
    wallClockMs,
    cells: counts,
    ok: counts.ok
  };
}

export function runBenchmark(argv, overrides = {}) {
  const emit = overrides.emit ?? emitJson;
  const now = overrides.now ?? Date.now;
  const runStartedAt = now();
  let options;
  let matrix = [];
  try {
    options = parseBenchmarkArgs(argv);
    matrix = buildBenchmarkMatrix(options);
  } catch (error) {
    emit({
      type: 'benchmark-error',
      schemaRevision: benchmarkSchemaRevision,
      runnerRevision: benchmarkRunnerRevision,
      stage: 'arguments',
      error: error instanceof Error ? error.message : String(error)
    });
    const counts = summarizeCells(0, [], 1);
    emit(baseSummary(runStartedAt, now() - runStartedAt, counts));
    return 2;
  }

  const context = {
    resolveReference: overrides.resolveReference ?? resolveVerifiedReference,
    spawn: overrides.spawn ?? spawnSync,
    writeFile: overrides.writeFile ?? ((file, content) => fs.writeFileSync(file, content, 'utf8')),
    makeTemporaryRoot: overrides.makeTemporaryRoot ?? (() => fs.mkdtempSync(path.join(os.tmpdir(), 'buaa-co-mars-benchmark-'))),
    removeTemporaryRoot: overrides.removeTemporaryRoot ?? ((directory) => fs.rmSync(directory, { recursive: true, force: true })),
    now,
    javaExecutable: overrides.javaExecutable ?? process.env.CONFORMANCE_JAVA ?? 'java',
    referenceSha256: undefined
  };
  const results = [];
  let infrastructureErrors = 0;
  let temporaryRoot;
  try {
    const reference = context.resolveReference(referenceRoles.stockAssembler);
    context.referenceSha256 = reference.verifiedSha256;
    const javaVersion = inspectJava(context.spawn, context.javaExecutable);
    emit({
      type: 'benchmark-metadata',
      schemaRevision: benchmarkSchemaRevision,
      runnerRevision: benchmarkRunnerRevision,
      measurementClass,
      mode: options.quick ? 'quick' : 'full-matrix',
      fixedRunnerBaseline: false,
      baselineEligible: false,
      startedAtEpochMs: runStartedAt,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      javaExecutable: context.javaExecutable,
      javaVersion,
      reference: {
        role: reference.role,
        fileName: reference.fileName,
        sha256: reference.verifiedSha256,
        sourceTag: reference.sourceTag,
        sourceCommit: reference.sourceCommit
      },
      resourceMeasurementStatus: 'child RSS not collected',
      externalBaselineRequirement: 'measure on a fixed runner and approve a separate ADR'
    });
    temporaryRoot = context.makeTemporaryRoot();
    for (let index = 0; index < matrix.length; index++) {
      let cellResult;
      try {
        cellResult = executeCell(matrix[index], index, temporaryRoot, context);
      } catch (error) {
        cellResult = {
          type: 'benchmark-cell',
          schemaRevision: benchmarkSchemaRevision,
          runnerRevision: benchmarkRunnerRevision,
          index,
          cell: matrix[index],
          startedAtEpochMs: null,
          wallClockMs: null,
          exitCode: null,
          signal: null,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          stdoutBytes: 0,
          stderrBytes: 0,
          stderrHead: null,
          childPeakRssKb: null,
          resourceMeasurementStatus: 'not-collected-by-phase0-harness',
          referenceSha256: context.referenceSha256
        };
      }
      results.push(cellResult);
      emit(cellResult);
      if (!cellResult.ok) {
        break;
      }
    }
  } catch (error) {
    infrastructureErrors++;
    emit({
      type: 'benchmark-error',
      schemaRevision: benchmarkSchemaRevision,
      runnerRevision: benchmarkRunnerRevision,
      stage: 'setup',
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (temporaryRoot !== undefined) {
      try {
        context.removeTemporaryRoot(temporaryRoot);
      } catch (error) {
        infrastructureErrors++;
        emit({
          type: 'benchmark-error',
          schemaRevision: benchmarkSchemaRevision,
          runnerRevision: benchmarkRunnerRevision,
          stage: 'cleanup',
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  const counts = summarizeCells(matrix.length, results, infrastructureErrors);
  emit(baseSummary(runStartedAt, now() - runStartedAt, counts));
  return counts.ok ? 0 : 1;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedFile === fileURLToPath(import.meta.url)) {
  process.exitCode = runBenchmark(process.argv.slice(2));
}
