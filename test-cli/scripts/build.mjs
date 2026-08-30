import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const testCliDir = path.resolve(scriptDir, '..');
const repoDir = path.resolve(testCliDir, '..');
const buildDir = path.join(testCliDir, '.build-src');
const outDir = path.join(testCliDir, 'dist');

const cleanOnly = process.argv.includes('--clean');
const typecheckOnly = process.argv.includes('--typecheck-only');

const backslash = String.fromCharCode(92);
const slashPath = (value) => value.split(backslash).join('/');

function rm(file) {
  rmSync(file, { recursive: true, force: true });
}

rm(buildDir);
if (cleanOnly) {
  rm(outDir);
  console.log(`[test-cli] cleaned ${outDir}`);
  process.exit(0);
}

mkdirSync(buildDir, { recursive: true });

function copyTree(sourceDir, targetDir, filter = () => true) {
  if (!existsSync(sourceDir)) {
    throw new Error(`missing source directory: ${sourceDir}`);
  }
  cpSync(sourceDir, targetDir, {
    recursive: true,
    filter(source) {
      const relative = slashPath(path.relative(sourceDir, source));
      return relative === '' || filter(source, relative);
    }
  });
}

// Extracted plugin pipeline sources. The original extension files stay untouched; a headless
// `vscode` shim is installed under dist/node_modules at build time for standalone runtime.
copyTree(path.join(repoDir, 'src'), path.join(buildDir, 'src'), (_source, relative) => {
  return !relative.startsWith('test/');
});
copyTree(path.join(testCliDir, 'src'), path.join(buildDir, 'test-cli', 'src'));

const vscodeShimSource = path.join(buildDir, 'test-cli', 'src', 'vscodeShim.ts');
if (!existsSync(vscodeShimSource)) {
  throw new Error(`missing vscode shim: ${vscodeShimSource}`);
}

if (!typecheckOnly) {
  rm(outDir);
}

// Course pipeline modules load machine-readable resources relative to __dirname:
// dist/src/** -> dist/resources and dist/test-cli/src -> dist/resources.
mkdirSync(path.join(outDir, 'resources'), { recursive: true });
copyTree(path.join(repoDir, 'resources'), path.join(outDir, 'resources'));

const requireFromTestCli = createRequire(path.join(testCliDir, 'package.json'));
let tscPath;
try {
  tscPath = requireFromTestCli.resolve('typescript/lib/tsc.js');
} catch {
  const requireFromRepo = createRequire(path.join(repoDir, 'package.json'));
  tscPath = requireFromRepo.resolve('typescript/lib/tsc.js');
}

const tscArgs = ['-p', path.join(testCliDir, 'tsconfig.json')];
if (typecheckOnly) {
  tscArgs.push('--noEmit');
}
const result = spawnSync(process.execPath, [tscPath, ...tscArgs], {
  cwd: testCliDir,
  stdio: 'inherit',
  env: { ...process.env }
});
if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (typecheckOnly) {
  console.log('[test-cli] typecheck passed');
  process.exit(0);
}

const forbiddenHeadlessOutputs = [
  path.join(outDir, 'src', 'languageClient.js'),
  path.join(outDir, 'src', 'verilog.js')
];
const leakedHeadlessOutputs = forbiddenHeadlessOutputs.filter(existsSync);
if (leakedHeadlessOutputs.length) {
  throw new Error(`headless import closure reached VS Code command glue: ${leakedHeadlessOutputs.join(', ')}`);
}

const cliEntry = 'test-cli/src/cli.js';
const runtimeVscodeDir = path.join(outDir, 'node_modules', 'vscode');
mkdirSync(runtimeVscodeDir, { recursive: true });
writeFileSync(
  path.join(runtimeVscodeDir, 'package.json'),
  JSON.stringify({ name: 'vscode', version: '1.90.0-headless', main: 'index.js' }, null, 2) + '\n'
);
writeFileSync(
  path.join(runtimeVscodeDir, 'index.js'),
  `"use strict";
module.exports = require('../../test-cli/src/vscodeShim.js');
`
);

writeFileSync(
  path.join(outDir, 'cli.js'),
  `"use strict";\nrequire('./${slashPath(cliEntry)}').main();\n`
);
writeFileSync(
  path.join(outDir, 'index.js'),
  `"use strict";\nmodule.exports = require('./${slashPath(cliEntry)}');\n`
);
console.log(`[test-cli] built ${path.join(outDir, cliEntry)}`);
console.log(`[test-cli] copied ${path.join(outDir, 'resources')}`);
