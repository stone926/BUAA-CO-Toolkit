import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const testCliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(testCliDir, 'dist', 'cli.js');
const require = createRequire(import.meta.url);

const removedPolicyOptions = [
  'count',
  'instruction-count',
  'interval',
  'interval-ms',
  'iterations',
  'max-iterations',
  'stop-on-failure',
  'no-stop-on-failure',
  'retained-cases',
  'retained-passing-cases',
  'retained-iterations',
  'report-retained-iterations',
  'stress',
  'mode',
  'stress-mode',
  'interrupt',
  'no-interrupt',
  'timer-interrupt',
  'no-timer-interrupt',
  'external-intensity',
  'external-interrupt-intensity',
  'timer-intensity',
  'probe-scenarios',
  'probe-scenario-count',
  'exception-rate',
  'exception-types',
  'seed',
  'sim-time',
  'memory-config',
  'memory-configuration',
  'skip-toolchain-check',
  'timeout',
  'timeout-ms',
  'testbench',
  'machine-code'
];

test('help exposes only project, ISE, DUT wiring, instructions, and output controls', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  for (const option of [
    '--project',
    '--instructions',
    '--ise',
    '--top-module',
    '--report',
    '--json'
  ]) {
    assert.match(result.stdout, new RegExp(option.replace('-', '\\-')));
  }
  for (const option of [...removedPolicyOptions, 'java', 'mars', 'mars-p7']) {
    assert.equal(result.stdout.includes(`--${option}`), false, `help leaked --${option}`);
  }
  assert.match(result.stdout, /启动持续测试/);
  assert.doesNotMatch(result.stdout, /co-test continuous/);
});

test('legacy positional test selector is rejected', () => {
  const result = spawnSync(process.execPath, [cli, 'continuous'], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /未知命令行参数: continuous/);
});

test('former automatic-policy options are explicitly rejected', () => {
  for (const option of removedPolicyOptions) {
    const result = spawnSync(process.execPath, [cli, `--${option}`], { encoding: 'utf8' });
    assert.equal(result.status, 2, `--${option}: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, /最强持续测试策略接管/);
  }
});

test('shared default policy is maximum-strength P7 and unbounded continuous testing', () => {
  const {
    automaticTestPolicy,
    automaticTestEngineMode,
    continuousAutomaticTestPolicy
  } = require(path.join(testCliDir, 'dist', 'src', 'courseTesting', 'automaticTestPolicy.js'));
  const {
    p7CourseInstructionCountMaximum,
    p7ProbeMaxScenarioCount
  } = require(path.join(testCliDir, 'dist', 'src', 'courseTesting', 'p7Hardware.js'));

  assert.equal(automaticTestEngineMode, 'builtin');
  const policy = automaticTestPolicy('P7');
  assert.equal(policy.instructionCount, p7CourseInstructionCountMaximum);
  assert.equal(policy.p7StressMode, 'hybrid');
  assert.equal(policy.interrupt, true);
  assert.equal(policy.timerInterrupt, true);
  assert.equal(policy.probeScenarioCount, p7ProbeMaxScenarioCount);
  assert.deepEqual(policy.exceptionTypes, ['AdEL', 'AdES', 'Syscall', 'RI', 'Ov']);
  assert.deepEqual(continuousAutomaticTestPolicy, {
    intervalMs: 0,
    maxIterations: 0,
    stopOnFailure: true,
    retainedPassingCases: 20,
    reportRetainedIterations: 200
  });
});

test('default CLI generates anchor, core probe, and timer probe and writes a sanitized report', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'co-test-cli-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, 'mips.v'), 'module mips; endmodule\n');

  const fakeFuse = path.join(project, 'ise', 'bin', 'nt64', 'fuse.exe');
  fs.mkdirSync(path.dirname(fakeFuse), { recursive: true });
  fs.writeFileSync(fakeFuse, 'not an executable');

  const result = spawnSync(process.execPath, [
    cli,
    '--project', project,
    '--ise', path.join(project, 'ise'),
    '--instructions', 'add sub'
  ], { encoding: 'utf8', timeout: 30000 });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stdout.includes(project), false, 'stdout leaked a project path');
  assert.equal(result.stderr.includes(project), false, 'stderr leaked a project path');
  assert.doesNotMatch(result.stdout, /builtin-random-asm|--profile|--count|\bcwd\b|fuse\.exe/i);
  const reportPath = path.join(project, '.co', 'out', 'continuous-trace-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.running, false);
  assert.equal(report.iterations.length, 1);
  assert.deepEqual(report.iterations[0].source, { kind: 'generator' });
  assert.equal(report.iterations[0].summary.errors + report.iterations[0].summary.failed > 0, true);
  assert.equal(report.iterations[0].results.length, 1, 'default testing must stop after the first error');
  assert.equal(report.iterations[0].results[0].asm, '测试点 1');

  const reportKeys = allObjectKeys(report);
  for (const privateKey of [
    'generator',
    'commandLine',
    'cwd',
    'options',
    'retention',
    'caseManifest',
    'asmSnapshot',
    'machineCode',
    'oracleOut',
    'dutOut',
    'dutRawOut',
    'marsOut',
    'simOut',
    'logisimOut',
    'logisimCircuit'
  ]) {
    assert.equal(reportKeys.has(privateKey), false, `report leaked ${privateKey}`);
  }
  assert.equal(JSON.stringify(report).includes(project), false, 'report leaked a project path');
  assert.equal(JSON.stringify(report).includes('fuse.exe'), false, 'report leaked a tool command');

  const casesRoot = path.join(project, '.co', 'cases');
  const caseDirs = fs.readdirSync(casesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(casesRoot, entry.name));
  assert.equal(caseDirs.length, 3);
  const manifests = caseDirs.map((caseDir) => JSON.parse(fs.readFileSync(path.join(caseDir, 'case.json'), 'utf8')));
  assert.deepEqual(
    manifests.map((manifest) => manifest.metadata?.['source.mode']).sort(),
    ['anchor', 'probe', 'probe']
  );
  assert.deepEqual(
    manifests.map((manifest) => manifest.metadata?.['source.probeShard']).filter(Boolean).sort(),
    ['core', 'timer']
  );
  assert.equal(manifests.some((manifest) => manifest.metadata?.['test.status']), true);

  const { p7CourseInstructionCountMaximum } = require(
    path.join(testCliDir, 'dist', 'src', 'courseTesting', 'p7Hardware.js')
  );
  const anchorIndex = manifests.findIndex((manifest) => manifest.metadata?.['source.mode'] === 'anchor');
  const anchorAsm = fs.readFileSync(path.join(caseDirs[anchorIndex], 'program.asm'), 'utf8');
  assert.match(anchorAsm, new RegExp(`# instruction_count: ${p7CourseInstructionCountMaximum}\\b`));
  assert.match(anchorAsm, /^# instruction_set: add sub$/m);
});

function allObjectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) {
      allObjectKeys(item, keys);
    }
    return keys;
  }
  if (!value || typeof value !== 'object') {
    return keys;
  }
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    allObjectKeys(child, keys);
  }
  return keys;
}
