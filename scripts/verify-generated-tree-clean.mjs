#!/usr/bin/env node
/**
 * CI gate for generated sources.
 *
 * A clean checkout must remain clean after the normal compile command, which
 * runs every generator before tsc. This catches both stale checked-in output
 * and non-deterministic generators; checking only after generation would hide
 * drift by silently rewriting the checkout.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    // Windows can only execute .cmd/.bat through a shell (Node >= 20.12 rejects
    // spawnSync('npm.cmd', ...) with EINVAL). The arguments below are static
    // literals, so there is no injection surface.
    shell: options.shell === true
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (!options.inherit) {
      process.stdout.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
    }
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
  return result.stdout ?? '';
}

function assertClean(label) {
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all']).trim();
  if (status) {
    console.error(`${label}: repository is not clean:`);
    console.error(status);
    process.exitCode = 1;
    return false;
  }
  return true;
}

try {
  if (!assertClean('before compile')) {
    process.exit(1);
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, ['run', 'compile'], { inherit: true, shell: process.platform === 'win32' });
  if (!assertClean('after compile')) {
    process.exit(1);
  }
  console.log('Generated tree-clean gate passed: compile left the checkout unchanged.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
