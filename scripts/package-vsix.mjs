#!/usr/bin/env node
// @index scripts — package one platform's complete Icarus runtime using shared VSIX exclusions

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const supportedTargets = new Set(['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']);
const runtimeDirectoryPattern = /^(?:win32|darwin|linux|alpine|freebsd)-[a-z0-9]+$/;

export function parsePackageOptions(args) {
  const { values } = parseArgs({
    args,
    options: { target: { type: 'string' }, out: { type: 'string' } },
    strict: true,
    allowPositionals: false
  });
  if (!supportedTargets.has(values.target)) {
    throw new Error(`--target is required and must be one of: ${[...supportedTargets].join(', ')}`);
  }
  if (values.out !== undefined && values.out.trim() === '') {
    throw new Error('--out must be a non-empty path.');
  }
  return values;
}

export async function packageVsix(options, root = repositoryRoot) {
  const { target, out } = options;
  if (!supportedTargets.has(target)) {
    throw new Error(`Unsupported VSIX target: ${target}`);
  }
  const runtimeRoot = join(root, 'vendor', 'iverilog');
  const runtimeDirectories = (await readdir(runtimeRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && runtimeDirectoryPattern.test(entry.name))
    .map(entry => entry.name)
    .sort();
  if (!runtimeDirectories.includes(target)) {
    throw new Error(`Bundled Icarus runtime is missing: ${join(runtimeRoot, target)}`);
  }

  const sharedIgnore = await readFile(join(root, '.vscodeignore'), 'utf8');
  const exclusions = runtimeDirectories
    .filter(directory => directory !== target)
    .map(directory => `vendor/iverilog/${directory}/**`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'co-package-vsix-'));
  try {
    const ignoreFile = join(temporaryRoot, '.vscodeignore');
    await writeFile(ignoreFile, `${sharedIgnore}\n# Other bundled Icarus platforms.\n${exclusions.join('\n')}\n`);
    // Invoke Node directly so paths with spaces or shell metacharacters work on Windows too.
    const args = [require.resolve('@vscode/vsce/vsce'), 'package', '--target', target, '--ignoreFile', ignoreFile];
    if (out !== undefined) {
      args.push('--out', out);
    }
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`VSIX packaging failed (${result.signal ?? `exit ${result.status}`}).`);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await packageVsix(parsePackageOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
