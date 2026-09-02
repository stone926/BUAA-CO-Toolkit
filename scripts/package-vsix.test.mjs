// @index scripts-test — real VSIX fixtures verify platform pruning and shared resource retention

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { packageVsix, parsePackageOptions } from './package-vsix.mjs';

// Inspect the actual archive with the ZIP reader already used by the installed vsce.
const require = createRequire(import.meta.url);
const vsceRequire = createRequire(require.resolve('@vscode/vsce'));
const yauzl = vsceRequire('yauzl');
const targets = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];

async function readArchiveEntries(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = [];
      zip.on('error', reject);
      zip.on('entry', entry => {
        entries.push(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(entries));
      zip.readEntry();
    });
  });
}

test('requires an explicit supported target and accepts an output path with spaces', () => {
  for (const args of [[], ['--target', 'alpine-x64'], ['--target', '../win32-x64'], ['--target', 'linux-x64', '--out', '']]) {
    assert.throws(() => parsePackageOptions(args));
  }
  assert.deepEqual({ ...parsePackageOptions(['--target', 'linux-arm64', '--out', '输出目录/test file.vsix']) }, {
    target: 'linux-arm64', out: '输出目录/test file.vsix'
  });
});

test('each platform VSIX retains its complete runtime and shared files only', async t => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'co-package-fixture-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const root = join(temporaryRoot, 'extension 中文 with spaces');
  const sharedIgnore = 'src/**\nout/test/**\n**/*.map\n';
  const fixture = {
    'package.json': JSON.stringify({
      name: 'co-packaging-fixture', version: '0.0.1', publisher: 'fixture',
      engines: { vscode: '^1.90.0' }, main: './out/extension.js', activationEvents: ['onStartupFinished'],
      repository: { type: 'git', url: 'https://github.com/example/co-packaging-fixture.git' }
    }),
    'README.md': '# Packaging fixture\n',
    'LICENSE': 'Test fixture license.\n',
    '.vscodeignore': sharedIgnore,
    'out/extension.js': 'exports.activate = () => {};\n',
    'out/test/development.js': 'should be excluded',
    'src/development.ts': 'should be excluded',
    'vendor/iverilog/CORRESPONDING_SOURCES.json': '{}\n',
    'vendor/iverilog/build-linux.sh': '#!/bin/sh\n',
    // A future platform directory must also be pruned without changing a static denylist.
    'vendor/iverilog/alpine-x64/bin/iverilog': 'future runtime'
  };
  const runtimeFiles = [
    'bin/iverilog', 'bin/vvp', 'lib/ivl/ivl', 'lib/ivl/vvp.tgt', 'lib/ivl/system.vpi',
    'include/iverilog/vpi_user.h', 'share/man/man1/iverilog.1',
    'THIRD_PARTY_NOTICES.md', 'licenses/iverilog-COPYING.txt'
  ];
  for (const target of targets) {
    for (const file of runtimeFiles) fixture[`vendor/iverilog/${target}/${file}`] = `${target}/${file}\n`;
  }
  for (const [file, content] of Object.entries(fixture)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  for (const target of targets) {
    const out = join(temporaryRoot, `输出 ${target}.vsix`);
    await packageVsix({ target, out }, root);
    const entries = await readArchiveEntries(out);
    const vendorEntries = entries.filter(file => file.startsWith('extension/vendor/iverilog/')).sort();
    const expected = [
      'extension/vendor/iverilog/CORRESPONDING_SOURCES.json',
      'extension/vendor/iverilog/build-linux.sh',
      ...runtimeFiles.map(file => `extension/vendor/iverilog/${target}/${file}`)
    ].sort();
    assert.deepEqual(vendorEntries, expected, target);
    assert.ok(entries.includes('extension/out/extension.js'), target);
    assert.ok(!entries.some(file => file.startsWith('extension/src/') || file.startsWith('extension/out/test/')), target);
  }
  assert.equal(await readFile(join(root, '.vscodeignore'), 'utf8'), sharedIgnore);
});
