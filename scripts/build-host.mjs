#!/usr/bin/env node
// Bundle runtime entry points; tsc's per-file output remains available for local verification.
import * as esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const development = !process.argv.includes('--production');
const entryPoints = {
  extension: 'src/extension.ts',
  server: 'src/server.ts',
  'mips/host/workerMain': 'src/mips/host/workerMain.ts',
  'mips/cli/main': 'src/mips/cli/main.ts',
  // Public helper exports exercised against the unpacked VSIX by the Icarus gate.
  moduleUtils: 'src/language/verilog/moduleUtils.ts',
  traceParser: 'src/language/verilog/traceParser.ts',
  iverilogRuntime: 'src/verilog/iverilogRuntime.ts'
};

const result = await esbuild.build({
  absWorkingDir: projectRoot,
  entryPoints,
  outdir: 'out',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node18'],
  external: ['vscode'],
  charset: 'utf8',
  minify: !development,
  sourcemap: development ? 'linked' : false,
  legalComments: 'eof',
  metafile: true,
  logLevel: 'warning'
});

const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
for (const [output, details] of Object.entries(result.metafile.outputs)) {
  if (details.inputs['src/resourcePaths.ts']?.bytesInOutput > 0 && output.split('/').length !== 2) {
    throw new Error(`${output} uses install resources but is not directly inside out/`);
  }
  for (const dependency of details.imports) {
    if (dependency.external && dependency.path !== 'vscode'
      && !builtins.has(dependency.path.replace(/^node:/, ''))) {
      throw new Error(`${output} still requires an unpackaged dependency: ${dependency.path}`);
    }
  }
}
const hostInputs = result.metafile.outputs['out/extension.js'].inputs;
for (const [input, details] of Object.entries(hostInputs)) {
  if (details.bytesInOutput > 0 && (/node_modules\/vscode-languageserver\//.test(input)
    || /src\/language\/verilog\/(?:parser|diagnostics|\w*Diagnostics|completionProvider|hover|rename|codeActions|inlayHints|signatureHelp)\.ts$/.test(input))) {
    throw new Error(`Extension host includes a server-only module: ${input}`);
  }
}

// Preserve full licenses when node_modules is excluded from the VSIX.
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const bundledPackages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (match) bundledPackages.add(match[1]);
}
const notices = ['# Bundled JavaScript dependencies', '', `${manifest.displayName ?? manifest.name} includes the following dependencies.`, ''];
for (const name of [...bundledPackages].sort()) {
  const packageRoot = new URL(`../node_modules/${name}/`, import.meta.url);
  const info = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'));
  let license;
  for (const filename of ['LICENSE', 'License.txt', 'LICENSE.txt', 'LICENSE.md']) {
    try {
      license = await readFile(new URL(filename, packageRoot), 'utf8');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!license) throw new Error(`Missing bundled dependency license: ${name}`);
  notices.push(`## ${name} ${info.version}`, '', license.trim(), '');
}
await writeFile(new URL('../out/THIRD_PARTY_NOTICES.md', import.meta.url), notices.join('\n'));
await writeFile(new URL('../out/host-meta.json', import.meta.url), JSON.stringify(result.metafile));
