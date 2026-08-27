import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFixedBenchmarkMatrix,
  generateFixedBenchmarkAsm,
  parseFixedBenchmarkArgs,
  summarizeFixedSamples
} from '../bench/fixed-runner-benchmark.mjs';
import { parseArgs as parseValidationArgs, validateFixedBenchmark, validateRunnerMetadata } from '../bench/validate-fixed-benchmark.mjs';

test('fixed benchmark matrix freezes all section-8.1 MARS dimensions without fake warm rows', () => {
  const cells = buildFixedBenchmarkMatrix(false);
  assert.equal(cells.length, 49);
  assert.equal(new Set(cells.map((cell) => cell.cellId)).size, 49);
  assert.deepEqual(new Set(cells.filter((cell) => cell.phase === 'assembly').map((cell) => cell.wordCount)), new Set([10, 200, 1000, 4096]));
  assert.deepEqual(new Set(cells.filter((cell) => cell.phase === 'execution').map((cell) => cell.requestedSteps)), new Set([1000, 65536, 1000000]));
  assert.deepEqual(new Set(cells.filter((cell) => cell.phase === 'execution').map((cell) => cell.traceMode)), new Set(['off', 'commit', 'canonical-full']));
  assert.deepEqual(new Set(cells.filter((cell) => cell.phase === 'execution').map((cell) => cell.workload)), new Set(['plain', 'memory-intensive', 'p7-exception-dense', 'p7-timer-dense', 'p7-irq-directed']));
  assert.ok(cells.every((cell) => cell.lifecycle === 'cold-end-to-end' && cell.processModel === 'fresh-jvm-per-sample'));
  assert.ok(cells.every((cell) => !String(cell.lifecycle).includes('warm')));
});

test('fixed benchmark CLI is strict and never infers an output path', () => {
  assert.deepEqual(parseFixedBenchmarkArgs(['--quick', '--output', 'candidate.json']), { quick: true, samples: 1, output: 'candidate.json' });
  assert.deepEqual(parseFixedBenchmarkArgs(['--samples', '7', '--output', 'candidate.json']), { quick: false, samples: 7, output: 'candidate.json' });
  assert.throws(() => parseFixedBenchmarkArgs([]), /--output is required/);
  assert.throws(() => parseFixedBenchmarkArgs(['--output', 'x', '--samples', '0']), /\[1,100\]/);
  assert.throws(() => parseFixedBenchmarkArgs(['--output', 'x', '--warm']), /unknown/);
  assert.deepEqual(parseValidationArgs(['--input', 'candidate.json', '--require-eligible']), { input: 'candidate.json', requireEligible: true });
});

test('workload sources are deterministic, bounded, and retain directed P7 stimuli', () => {
  for (const cell of buildFixedBenchmarkMatrix(false)) {
    const first = generateFixedBenchmarkAsm(cell);
    assert.equal(first, generateFixedBenchmarkAsm(cell));
    assert.equal(first.split('\n').filter((line) => /^\s{4}\S/.test(line)).length, cell.wordCount);
    assert.match(first, /_bench_loop:/);
  }
  const p7 = buildFixedBenchmarkMatrix(false).filter((cell) => cell.workload.startsWith('p7-'));
  assert.ok(p7.some((cell) => /syscall/.test(generateFixedBenchmarkAsm(cell))));
  assert.ok(p7.some((cell) => /0x7f00/.test(generateFixedBenchmarkAsm(cell))));
  assert.ok(p7.some((cell) => /0x7f20/.test(generateFixedBenchmarkAsm(cell))));
});

test('statistics include p50, p95, deterministic 95% CI, CPU, and RSS', () => {
  const cell = buildFixedBenchmarkMatrix(true)[0];
  const samples = [1, 2, 3, 4, 5, 6, 7].map((value, sampleIndex) => ({
    cellId: cell.cellId,
    sampleIndex,
    wallClockMs: value * 10,
    cpuMs: value * 8,
    peakRssBytes: value * 1024,
    exitCode: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    ok: true,
    error: null
  }));
  const summary = summarizeFixedSamples(cell, samples);
  assert.equal(summary.wallClockMs.p50, 40);
  assert.equal(summary.wallClockMs.p95, 70);
  assert.equal(summary.cpuMs.p50, 32);
  assert.equal(summary.peakRssBytes.p95, 7 * 1024);
  assert.equal(summary.wallClockMs.p95ConfidenceInterval.method, 'deterministic-bootstrap-95-v1');
  assert.deepEqual(summary, summarizeFixedSamples(cell, samples));
});

test('candidate validator fails closed rather than accepting partial metadata', () => {
  assert.throws(() => validateFixedBenchmark({}), /schema\/runner\/matrix revision/);
});

test('runner labels cannot be forged across OS/runtime/image contracts', () => {
  const linux = {
    id: 'github-hosted:ubuntu-24.04', imageVersion: 'ubuntu24:20260820.1', cpuPolicy: 'github-managed;governor=performance',
    concurrency: 1, platform: 'linux', arch: 'x64', cpuModel: 'Example CPU', logicalCpuCount: 4,
    totalMemoryBytes: 16 * 1024 ** 3, nodeVersion: 'v24.7.0', javaVersion: 'openjdk version "25.0.2"',
    ci: {
      provider: 'github-actions', repository: 'stone926/BUAA-CO-Toolkit',
      workflowRef: 'stone926/BUAA-CO-Toolkit/.github/workflows/ci.yml@refs/heads/main',
      eventName: 'workflow_dispatch', job: 'fixed-mars-benchmark', runId: '123456789', runAttempt: '1',
      commitSha: 'a'.repeat(40), runnerEnvironment: 'github-hosted', runnerName: 'GitHub Actions 2',
      runnerOs: 'Linux', runnerArch: 'X64',
      runUrl: 'https://github.com/stone926/BUAA-CO-Toolkit/actions/runs/123456789/attempts/1'
    }
  };
  assert.equal(validateRunnerMetadata(linux), linux);
  assert.throws(() => validateRunnerMetadata({ ...linux, platform: 'win32' }), /must report platform linux/);
  assert.throws(() => validateRunnerMetadata({ ...linux, imageVersion: 'ubuntu24:' }), /image version/);
  assert.throws(() => validateRunnerMetadata({ ...linux, nodeVersion: 'v22.0.0' }), /Node 24/);
  assert.throws(() => validateRunnerMetadata({ ...linux, javaVersion: 'openjdk version "21"' }), /Java 25/);
  assert.throws(() => validateRunnerMetadata({ ...linux, ci: { ...linux.ci, repository: 'attacker/fork' } }), /repository provenance/);
  assert.throws(() => validateRunnerMetadata({ ...linux, ci: { ...linux.ci, eventName: 'pull_request' } }), /manual fixed-mars-benchmark/);
  assert.throws(() => validateRunnerMetadata({ ...linux, ci: { ...linux.ci, commitSha: 'not-a-sha' } }), /commit SHA/);
  assert.throws(() => validateRunnerMetadata({ ...linux, ci: { ...linux.ci, runnerOs: 'Windows' } }), /OS\/architecture/);
  assert.throws(() => validateRunnerMetadata({
    ...linux,
    ci: { ...linux.ci, workflowRef: 'stone926/BUAA-CO-Toolkit/.github/workflows/ci.yml@refs/heads/untrusted' }
  }), /protected main CI workflow/);
});
