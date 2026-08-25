import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const testCliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(testCliDir, 'dist', 'cli.js');

test('cli prints help', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--instructions/);
  assert.match(result.stdout, /--stress/);
});

test('cli rejects non-P7 memory configuration', () => {
  const result = spawnSync(process.execPath, [cli, '--memory-config', 'FixedCompactLargeText'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /仅支持 P7/);
});

test('one P7 iteration writes a JSON report when MARS fails', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'co-test-cli-'));
  fs.writeFileSync(path.join(project, 'mips.v'), 'module mips; endmodule\n');
  const fakeMars = path.join(project, 'mars.jar');
  fs.writeFileSync(fakeMars, 'not a jar');

  const result = spawnSync(process.execPath, [
    cli,
    '--project', project,
    '--skip-toolchain-check',
    '--count', '4',
    '--stress', 'off',
    '--iterations', '1',
    '--java', process.execPath,
    '--mars', fakeMars,
    '--ise', project,
    '--timeout-ms', '5000',
    '--quiet'
  ], { encoding: 'utf8' });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(fs.readFileSync(path.join(project, '.co', 'out', 'continuous-trace-report.json'), 'utf8'));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.iterations.length, 1);
  assert.equal(report.iterations[0].summary.errors, 1);
  assert.equal(report.iterations[0].results[0].stage, 'assemble');
  assert.equal('marsOut' in report.iterations[0].results[0], false);
  assert.equal('simOut' in report.iterations[0].results[0], false);
});
