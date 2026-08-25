import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import {
  benchmarkRunnerRevision,
  benchmarkSchemaRevision,
  buildBenchmarkMatrix,
  effectiveMarsMaxSteps,
  generateAsm,
  parseBenchmarkArgs,
  runBenchmark,
  summarizeCells
} from '../bench/mars-benchmark.mjs';
import { referenceRoles } from '../reference/referenceAssets.mjs';

test('benchmark arguments are strict and deterministic', () => {
  assert.deepEqual(parseBenchmarkArgs([]), { quick: false });
  assert.deepEqual(parseBenchmarkArgs(['--quick']), { quick: true });
  assert.throws(() => parseBenchmarkArgs(['--quick', '--quick']), /only once/);
  assert.throws(() => parseBenchmarkArgs(['--typo']), /unknown argument/);
  assert.throws(() => parseBenchmarkArgs('--quick'), /array of strings/);
  assert.throws(() => parseBenchmarkArgs([1]), /array of strings/);
});

test('benchmark matrix records requested and unambiguous effective MARS step limits', () => {
  assert.equal(effectiveMarsMaxSteps(1), 32);
  assert.equal(effectiveMarsMaxSteps(31), 32);
  assert.equal(effectiveMarsMaxSteps(32), 32);
  assert.equal(effectiveMarsMaxSteps(1000), 1000);
  assert.throws(() => effectiveMarsMaxSteps(0), /positive safe integer/);

  const quick = buildBenchmarkMatrix({ quick: true });
  assert.deepEqual(quick, [{
    wordCount: 10,
    requestedSteps: 1000,
    effectiveMaxSteps: 1000,
    traceMode: 'off',
    workload: 'plain',
    processModel: 'cold-jvm-per-cell'
  }]);

  const full = buildBenchmarkMatrix({ quick: false });
  assert.equal(full.length, 24);
  assert.ok(full.every((cell) => cell.effectiveMaxSteps === effectiveMarsMaxSteps(cell.requestedSteps)));
  assert.throws(() => buildBenchmarkMatrix({}), /boolean quick/);
});

test('generated benchmark assembly is bounded and deterministic', () => {
  const first = generateAsm(10);
  assert.equal(first, generateAsm(10));
  assert.equal(first.split('\n').filter((line) => /^\s{4}\S/.test(line)).length, 10);
  assert.match(first, /_end:\n    beq \$0, \$0, _end\n    nop\n$/);
  assert.throws(() => generateAsm(1), /\[2, 4096\]/);
  assert.throws(() => generateAsm(4097), /\[2, 4096\]/);
  assert.throws(() => generateAsm(2.5), /integer/);
});

test('benchmark cells ask MARS to fail through the process exit status', () => {
  const hash = 'a'.repeat(64);
  const reference = {
    role: referenceRoles.stockAssembler,
    file: path.resolve('immutable-reference', 'Mars.jar'),
    fileName: 'Mars.jar',
    verifiedSha256: hash,
    sourceTag: 'v0.6.3',
    sourceCommit: 'c'.repeat(40)
  };
  const spawnCalls = [];
  const exitCode = runBenchmark(['--quick'], {
    emit: () => undefined,
    now: (() => {
      let value = 100;
      return () => value++;
    })(),
    resolveReference: () => reference,
    spawn: (_executable, args) => {
      spawnCalls.push(args);
      return args[0] === '-version'
        ? { status: 0, stdout: '', stderr: 'openjdk version "25"' }
        : { status: 0, stdout: '', stderr: '' };
    },
    makeTemporaryRoot: () => path.resolve('isolated-test-root', 'benchmark-cli-flags'),
    writeFile: () => undefined,
    removeTemporaryRoot: () => undefined
  });

  assert.equal(exitCode, 0);
  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(spawnCalls[1].slice(0, 8), [
    '-jar', reference.file, 'nc', 'mc', 'FixedCompactLargeText', 'ae1', 'se1', '1000'
  ]);
});

test('summary is fail-closed for failures, missing cells, and infrastructure errors', () => {
  assert.deepEqual(summarizeCells(1, [{ ok: true }]), {
    planned: 1,
    completed: 1,
    passed: 1,
    failed: 0,
    infrastructureErrors: 0,
    aborted: false,
    ok: true
  });
  assert.equal(summarizeCells(2, [{ ok: true }, { ok: false }]).ok, false);
  assert.equal(summarizeCells(2, [{ ok: true }]).ok, false);
  assert.equal(summarizeCells(1, [{ ok: true }], 1).ok, false);
  assert.throws(() => summarizeCells(1, [], -1), /invalid benchmark summary input/);
});

test('argument errors emit only an error and a non-baseline summary', () => {
  const records = [];
  let clock = 100;
  const exitCode = runBenchmark(['--unknown'], {
    emit: (record) => records.push(record),
    now: () => clock++,
    resolveReference: () => assert.fail('argument rejection must happen before reference resolution'),
    makeTemporaryRoot: () => assert.fail('argument rejection must happen before temporary directory creation')
  });

  assert.equal(exitCode, 2);
  assert.deepEqual(records.map((record) => record.type), ['benchmark-error', 'benchmark-summary']);
  assert.equal(records[0].stage, 'arguments');
  assert.match(records[0].error, /unknown argument/);
  assert.equal(records[1].fixedRunnerBaseline, false);
  assert.equal(records[1].baselineEligible, false);
  assert.equal(records[1].cells.infrastructureErrors, 1);
  assert.equal(records[1].ok, false);
});

test('reference fingerprint changes fail the cell and still clean the unique run root', () => {
  const records = [];
  const roles = [];
  const writes = [];
  const removals = [];
  let referenceCall = 0;
  let spawnCall = 0;
  let clock = 1000;
  const firstHash = 'a'.repeat(64);
  const secondHash = 'b'.repeat(64);
  const temporaryRoot = path.resolve('isolated-test-root', 'buaa-co-mars-benchmark-unique');

  const exitCode = runBenchmark(['--quick'], {
    emit: (record) => records.push(record),
    now: () => clock++,
    resolveReference: (role) => {
      roles.push(role);
      return {
        role,
        file: path.resolve('immutable-reference', 'Mars.jar'),
        fileName: 'Mars.jar',
        verifiedSha256: referenceCall++ === 0 ? firstHash : secondHash,
        sourceTag: 'v0.6.3',
        sourceCommit: 'c'.repeat(40)
      };
    },
    spawn: (_executable, args) => {
      spawnCall++;
      assert.deepEqual(args, ['-version']);
      return { status: 0, stdout: '', stderr: 'openjdk version "25"' };
    },
    makeTemporaryRoot: () => temporaryRoot,
    writeFile: (file, source) => writes.push({ file, source }),
    removeTemporaryRoot: (directory) => removals.push(directory)
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(roles, [referenceRoles.stockAssembler, referenceRoles.stockAssembler]);
  assert.equal(spawnCall, 1, 'changed reference must be rejected before a benchmark JVM starts');
  assert.equal(writes.length, 1);
  assert.ok(writes[0].file.startsWith(`${temporaryRoot}${path.sep}`));
  assert.deepEqual(removals, [temporaryRoot]);
  assert.deepEqual(records.map((record) => record.type), [
    'benchmark-metadata',
    'benchmark-cell',
    'benchmark-summary'
  ]);
  assert.ok(records.every((record) => record.schemaRevision === benchmarkSchemaRevision));
  assert.ok(records.every((record) => record.runnerRevision === benchmarkRunnerRevision));
  assert.match(records[1].error, /fingerprint changed/);
  assert.equal(records[1].referenceSha256, firstHash);
  assert.deepEqual(records[1].cell, {
    wordCount: 10,
    requestedSteps: 1000,
    effectiveMaxSteps: 1000,
    traceMode: 'off',
    workload: 'plain',
    processModel: 'cold-jvm-per-cell'
  });
  assert.equal(records[2].fixedRunnerBaseline, false);
  assert.equal(records[2].baselineEligible, false);
  assert.deepEqual(records[2].cells, {
    planned: 1,
    completed: 1,
    passed: 0,
    failed: 1,
    infrastructureErrors: 0,
    aborted: false,
    ok: false
  });
  assert.equal(records[2].ok, false);
});
