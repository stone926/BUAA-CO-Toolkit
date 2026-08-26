#!/usr/bin/env node
/** Controlled-runner pinned-MARS baseline collector with per-JVM CPU/RSS. */
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceRoles, resolveVerifiedReference } from '../reference/referenceAssets.mjs';
import { effectiveMarsMaxSteps } from '../runner/marsRunner.mjs';

const benchRoot = path.dirname(fileURLToPath(import.meta.url));
const matrixFile = path.join(benchRoot, 'benchmark-matrix.json');
const powershellMeasureScript = path.join(benchRoot, 'measured-process.ps1');
const matrix = JSON.parse(fs.readFileSync(matrixFile, 'utf8'));
const shaPattern = /^[0-9a-f]{64}$/;

export const fixedBenchmarkSchemaRevision = 1;
export const fixedBenchmarkRunnerRevision = 2;

function assert(condition, message) {
  if (!condition) throw new Error(`fixed benchmark: ${message}`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}

export function parseFixedBenchmarkArgs(argv) {
  const options = { quick: false, samples: undefined, output: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--quick' && !options.quick) options.quick = true;
    else if (arg === '--samples') {
      options.samples = Number(argv[++index]);
      if (!Number.isSafeInteger(options.samples) || options.samples <= 0 || options.samples > 100) throw new Error('--samples must be in [1,100]');
    } else if (arg === '--output') {
      options.output = argv[++index];
      if (!options.output || options.output.startsWith('--')) throw new Error('--output requires a file');
    } else throw new Error(`unknown/duplicate argument: ${arg}`);
  }
  options.samples ??= options.quick ? 1 : matrix.sampling.minimumIndependentSamples;
  if (!options.output) throw new Error('--output is required');
  return options;
}

function cellId(cell) {
  return [cell.phase, cell.workload, cell.traceMode, cell.wordCount, cell.requestedSteps].join(':');
}

export function buildFixedBenchmarkMatrix(quick = false) {
  if (quick) {
    const cell = { phase: 'assembly', workload: 'plain', profile: 'P3', memoryConfiguration: 'FixedCompactLargeText', traceMode: 'off', wordCount: 10, requestedSteps: 1000, effectiveMaxSteps: 1000, lifecycle: 'cold-end-to-end', processModel: 'fresh-jvm-per-sample' };
    return [{ ...cell, cellId: cellId(cell) }];
  }
  const cells = [];
  for (const wordCount of matrix.marsCold.assemblyWordCounts) {
    const cell = { phase: 'assembly', workload: 'plain', profile: 'P3', memoryConfiguration: wordCount === 4096 ? 'Default' : 'FixedCompactLargeText', traceMode: 'off', wordCount, requestedSteps: 32, effectiveMaxSteps: 32, lifecycle: matrix.marsCold.lifecycle, processModel: matrix.marsCold.processModel };
    cells.push({ ...cell, cellId: cellId(cell) });
  }
  for (const workload of matrix.marsCold.workloads) {
    for (const traceMode of matrix.marsCold.traceModes) {
      for (const requestedSteps of matrix.marsCold.executionStepCounts) {
        const profile = workload.startsWith('p7-') ? 'P7' : 'P6';
        const cell = { phase: 'execution', workload, profile, memoryConfiguration: profile === 'P7' ? 'CompactLargeText' : 'FixedCompactLargeText', traceMode, wordCount: 200, requestedSteps, effectiveMaxSteps: effectiveMarsMaxSteps(requestedSteps), lifecycle: matrix.marsCold.lifecycle, processModel: matrix.marsCold.processModel };
        cells.push({ ...cell, cellId: cellId(cell) });
      }
    }
  }
  assert(new Set(cells.map((entry) => entry.cellId)).size === cells.length, 'matrix cell IDs are not unique');
  return cells;
}

function paddedProgram(lines, wordCount) {
  const instructionCount = lines.filter((line) => /^\s{4}\S/.test(line)).length;
  assert(instructionCount <= wordCount, `workload needs ${instructionCount} words but cell allows ${wordCount}`);
  const padding = Array.from({ length: wordCount - instructionCount }, () => '    nop');
  const insertion = lines.findIndex((line) => line === '_bench_loop:');
  lines.splice(insertion, 0, ...padding);
  return `${lines.join('\n')}\n`;
}

export function generateFixedBenchmarkAsm(cell) {
  if (cell.workload === 'plain') {
    return paddedProgram(['.text', '    ori $t0, $0, 1', '    ori $t1, $0, 3', '_bench_loop:', '    addu $t0, $t0, $t1', '    subu $t1, $t1, $t0', '    beq $0, $0, _bench_loop', '    nop'], cell.wordCount);
  }
  if (cell.workload === 'memory-intensive') {
    return paddedProgram(['.text', '    ori $t0, $0, 0x100', '    ori $t1, $0, 1', '_bench_loop:', '    sw $t1, 0($t0)', '    lw $t2, 0($t0)', '    sw $t2, 4($t0)', '    lw $t3, 4($t0)', '    beq $0, $0, _bench_loop', '    nop'], cell.wordCount);
  }
  if (cell.workload === 'p7-exception-dense') {
    return paddedProgram(['.text', '_bench_loop:', '    syscall', '    beq $0, $0, _bench_loop', '    nop', '.ktext 0x4180', '    mfc0 $k0, $14', '    addiu $k0, $k0, 4', '    mtc0 $k0, $14', '    eret', '    nop'], cell.wordCount);
  }
  if (cell.workload === 'p7-timer-dense') {
    return paddedProgram(['.text', '    ori $t0, $0, 1', '    sw $t0, 0x7f04($0)', '    ori $t0, $0, 0x0b', '    sw $t0, 0x7f00($0)', '    ori $t0, $0, 0x0401', '    mtc0 $t0, $12', '_bench_loop:', '    addiu $t1, $t1, 1', '    beq $0, $0, _bench_loop', '    nop', '.ktext 0x4180', '    eret', '    nop'], cell.wordCount);
  }
  assert(cell.workload === 'p7-irq-directed', `unsupported workload ${cell.workload}`);
  return paddedProgram(['.text', '    ori $t0, $0, 0x1001', '    mtc0 $t0, $12', '    nop', '    nop', '_bench_loop:', '    addiu $t1, $t1, 1', '    beq $0, $0, _bench_loop', '    nop', '.ktext 0x4180', '    sb $0, 0x7f20($0)', '    eret', '    nop'], cell.wordCount);
}

function readHead(file, maximum = 1024 * 1024) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const size = Math.min(fs.fstatSync(descriptor).size, maximum);
    const buffer = Buffer.alloc(size);
    fs.readSync(descriptor, buffer, 0, size, 0);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function runMeasured(executable, args, files, timeoutMs) {
  if (process.platform === 'win32') {
    const encodedArgs = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
    const powershell = process.env.PWSH_EXE || 'pwsh';
    const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', powershellMeasureScript, '-Executable', executable, '-ArgumentsBase64', encodedArgs, '-StdoutFile', files.stdout, '-StderrFile', files.stderr, '-MetricsFile', files.metrics], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    if (result.error) throw result.error;
  } else {
    const format = 'wallClockSeconds=%e\ncpuUserSeconds=%U\ncpuSystemSeconds=%S\npeakRssKb=%M';
    const stdoutFd = fs.openSync(files.stdout, 'w');
    const stderrFd = fs.openSync(files.stderr, 'w');
    let result;
    try {
      result = spawnSync('/usr/bin/time', ['-f', format, '-o', files.metrics, '--', executable, ...args], { stdio: ['ignore', stdoutFd, stderrFd], timeout: timeoutMs });
    } finally {
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
    }
    if (result.error) throw result.error;
    const parsed = Object.fromEntries(fs.readFileSync(files.metrics, 'utf8').trim().split(/\r?\n/).map((line) => line.split('=')));
    fs.writeFileSync(files.metrics, JSON.stringify({ wallClockMs: Number(parsed.wallClockSeconds) * 1000, cpuMs: (Number(parsed.cpuUserSeconds) + Number(parsed.cpuSystemSeconds)) * 1000, peakRssBytes: Number(parsed.peakRssKb) * 1024, exitCode: result.status }), 'utf8');
  }
  const metrics = JSON.parse(fs.readFileSync(files.metrics, 'utf8'));
  assert(Number.isFinite(metrics.wallClockMs) && metrics.wallClockMs >= 0, 'wall-clock metric is missing');
  assert(Number.isFinite(metrics.cpuMs) && metrics.cpuMs >= 0, 'CPU metric is missing');
  assert(Number.isSafeInteger(metrics.peakRssBytes) && metrics.peakRssBytes > 0, 'RSS metric is missing');
  return metrics;
}

function percentile(values, percentage) {
  assert(values.length > 0, 'percentile requires samples');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1)];
}

function bootstrapP95Interval(values, seedText, iterations = 2000) {
  let state = Number.parseInt(hash(seedText).slice(0, 8), 16) >>> 0;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17; state >>>= 0;
    state ^= state << 5; state >>>= 0;
    return state >>> 0;
  };
  const bootstrapped = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sample = Array.from({ length: values.length }, () => values[next() % values.length]);
    bootstrapped.push(percentile(sample, 95));
  }
  return { method: 'deterministic-bootstrap-95-v1', iterations, lower: percentile(bootstrapped, 2.5), upper: percentile(bootstrapped, 97.5) };
}

export function summarizeFixedSamples(cell, samples) {
  assert(samples.length > 0 && samples.every((entry) => entry.ok), `${cell.cellId} has missing/failed samples`);
  const wall = samples.map((entry) => entry.wallClockMs);
  const cpu = samples.map((entry) => entry.cpuMs);
  const rss = samples.map((entry) => entry.peakRssBytes);
  return {
    cellId: cell.cellId,
    sampleCount: samples.length,
    wallClockMs: { p50: percentile(wall, 50), p95: percentile(wall, 95), p95ConfidenceInterval: bootstrapP95Interval(wall, `${cell.cellId}:wall`) },
    cpuMs: { p50: percentile(cpu, 50), p95: percentile(cpu, 95) },
    peakRssBytes: { p50: percentile(rss, 50), p95: percentile(rss, 95) }
  };
}

function javaVersion(javaExecutable) {
  const result = spawnSync(javaExecutable, ['-version'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert(!result.error && result.status === 0, `Java probe failed: ${result.error?.message ?? result.status}`);
  return `${result.stderr ?? ''}\n${result.stdout ?? ''}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function requiredEnvironment() {
  const names = [
    'CONFORMANCE_BENCHMARK_RUNNER_ID',
    'CONFORMANCE_BENCHMARK_IMAGE_VERSION',
    'CONFORMANCE_BENCHMARK_CPU_POLICY',
    'CONFORMANCE_BENCHMARK_CONCURRENCY',
    'GITHUB_ACTIONS',
    'GITHUB_EVENT_NAME',
    'GITHUB_JOB',
    'GITHUB_REPOSITORY',
    'GITHUB_REF',
    'GITHUB_RUN_ATTEMPT',
    'GITHUB_RUN_ID',
    'GITHUB_SERVER_URL',
    'GITHUB_SHA',
    'GITHUB_WORKFLOW_REF',
    'RUNNER_ARCH',
    'RUNNER_ENVIRONMENT',
    'RUNNER_NAME',
    'RUNNER_OS'
  ];
  const values = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) assert(typeof values[name] === 'string' && values[name].length > 0, `${name} is required`);
  assert(values.CONFORMANCE_BENCHMARK_CONCURRENCY === '1', 'benchmark concurrency must be exactly 1');
  assert(values.GITHUB_ACTIONS === 'true', 'fixed benchmark must run in GitHub Actions');
  assert(values.GITHUB_EVENT_NAME === 'workflow_dispatch', 'fixed benchmark must be manually dispatched');
  assert(values.GITHUB_JOB === 'fixed-mars-benchmark', 'fixed benchmark GitHub job identity drifted');
  assert(values.GITHUB_REPOSITORY === 'stone926/BUAA-CO-Toolkit', 'fixed benchmark repository identity drifted');
  assert(values.GITHUB_REF === 'refs/heads/main', 'fixed benchmark must be dispatched from the protected main branch');
  assert(values.GITHUB_WORKFLOW_REF === 'stone926/BUAA-CO-Toolkit/.github/workflows/ci.yml@refs/heads/main', 'fixed benchmark workflow must come from the protected main branch');
  assert(values.GITHUB_SERVER_URL === 'https://github.com', 'fixed benchmark server identity drifted');
  assert(values.RUNNER_ENVIRONMENT === 'github-hosted', 'fixed benchmark requires a GitHub-hosted runner');
  return values;
}

export function runFixedBenchmark(argv) {
  const options = parseFixedBenchmarkArgs(argv);
  const environment = requiredEnvironment();
  const cells = buildFixedBenchmarkMatrix(options.quick);
  const reference = resolveVerifiedReference(referenceRoles.stockAssembler);
  assert(shaPattern.test(reference.verifiedSha256), 'reference hash is invalid');
  const javaExecutable = process.env.CONFORMANCE_JAVA || 'java';
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buaa-co-fixed-benchmark-'));
  const rawSamples = [];
  let sequence = 0;
  try {
    for (const cell of cells) {
      const source = generateFixedBenchmarkAsm(cell);
      const asmFile = path.join(temporaryRoot, `${String(sequence).padStart(4, '0')}.asm`);
      fs.writeFileSync(asmFile, source, 'utf8');
      for (let sampleIndex = 0; sampleIndex < options.samples; sampleIndex++) {
        const currentReference = resolveVerifiedReference(referenceRoles.stockAssembler);
        assert(currentReference.verifiedSha256 === reference.verifiedSha256, 'reference hash changed during collection');
        const stem = path.join(temporaryRoot, `${String(sequence++).padStart(5, '0')}`);
        const files = { stdout: `${stem}.stdout`, stderr: `${stem}.stderr`, metrics: `${stem}.metrics.json` };
        const cli = ['-jar', currentReference.file, 'nc', 'mc', cell.memoryConfiguration, 'ae1', 'se1'];
        if (cell.profile === 'P7') cli.push('db', 'efc');
        if (cell.workload === 'p7-irq-directed') cli.push('p7irq=0x00003010');
        if (cell.traceMode === 'commit') cli.push('coL1');
        if (cell.traceMode === 'canonical-full') cli.push('coL2');
        cli.push(String(cell.effectiveMaxSteps), asmFile);
        const metrics = runMeasured(javaExecutable, cli, files, 15 * 60 * 1000);
        const stdoutHead = readHead(files.stdout);
        const stderrHead = readHead(files.stderr);
        const outputError = /Invalid Command Argument|Error in .* line|Processing terminated due to errors/i.test(`${stdoutHead}\n${stderrHead}`);
        const traceMissing = cell.traceMode === 'canonical-full' && !/^@PC/im.test(stdoutHead);
        const ok = metrics.exitCode === 0 && !outputError && !traceMissing;
        rawSamples.push({ cellId: cell.cellId, sampleIndex, ...metrics, stdoutBytes: fs.statSync(files.stdout).size, stderrBytes: fs.statSync(files.stderr).size, ok, error: ok ? null : (outputError ? 'MARS reported an error' : traceMissing ? 'canonical trace missing' : `exit ${metrics.exitCode}`) });
        // Full 1M-step traces can be very large. Metrics and byte counts are the
        // benchmark evidence; never accumulate process output across 343 JVMs.
        for (const file of Object.values(files)) fs.rmSync(file, { force: true });
        assert(ok, `${cell.cellId} sample ${sampleIndex} failed`);
      }
    }
    const summaries = cells.map((cell) => summarizeFixedSamples(cell, rawSamples.filter((entry) => entry.cellId === cell.cellId)));
    const runner = {
      id: environment.CONFORMANCE_BENCHMARK_RUNNER_ID,
      imageVersion: environment.CONFORMANCE_BENCHMARK_IMAGE_VERSION,
      cpuPolicy: environment.CONFORMANCE_BENCHMARK_CPU_POLICY,
      concurrency: 1,
      platform: process.platform,
      arch: process.arch,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      nodeVersion: process.version,
      javaVersion: javaVersion(javaExecutable),
      ci: {
        provider: 'github-actions',
        repository: environment.GITHUB_REPOSITORY,
        workflowRef: environment.GITHUB_WORKFLOW_REF,
        eventName: environment.GITHUB_EVENT_NAME,
        job: environment.GITHUB_JOB,
        runId: environment.GITHUB_RUN_ID,
        runAttempt: environment.GITHUB_RUN_ATTEMPT,
        commitSha: environment.GITHUB_SHA,
        runnerEnvironment: environment.RUNNER_ENVIRONMENT,
        runnerName: environment.RUNNER_NAME,
        runnerOs: environment.RUNNER_OS,
        runnerArch: environment.RUNNER_ARCH,
        runUrl: `${environment.GITHUB_SERVER_URL}/${environment.GITHUB_REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}/attempts/${environment.GITHUB_RUN_ATTEMPT}`
      }
    };
    const result = {
      schemaRevision: fixedBenchmarkSchemaRevision,
      runnerRevision: fixedBenchmarkRunnerRevision,
      matrixRevision: matrix.matrixRevision,
      measurementClass: options.quick ? 'controlled-runner-smoke' : 'controlled-runner-baseline-candidate',
      baselineEligible: !options.quick && options.samples >= matrix.sampling.minimumIndependentSamples,
      lifecycle: 'cold-end-to-end',
      warmMeasurementsPresent: false,
      warmExclusionReason: matrix.marsCold.warmExclusionReason,
      runner,
      runnerFingerprint: hash(runner),
      reference: { role: reference.role, fileName: reference.fileName, sha256: reference.verifiedSha256, sourceTag: reference.sourceTag, sourceCommit: reference.sourceCommit },
      matrixSha256: hash(matrix),
      samplePolicy: { independentSamplesPerCell: options.samples, percentileMethod: 'nearest-rank-v1', confidenceInterval: matrix.sampling.confidenceInterval },
      cells,
      rawSamples,
      summaries,
      integrity: { algorithm: 'sha256-canonical-json-v1', payloadSha256: '' }
    };
    const { integrity: _integrity, ...payload } = result;
    result.integrity.payloadSha256 = hash(payload);
    const output = path.resolve(options.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporaryOutput = `${output}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryOutput, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryOutput, output);
    process.stdout.write(`fixed benchmark OK: cells=${cells.length}, samples=${rawSamples.length}, eligible=${result.baselineEligible}, output=${output}\n`);
    return 0;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedFile === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runFixedBenchmark(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
