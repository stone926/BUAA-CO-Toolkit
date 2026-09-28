#!/usr/bin/env node
// Measure entry-point loading only. Activation and the real VS Code API are verified separately.
const path = require('node:path');
const Module = require('node:module');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const entry = path.resolve(process.argv[2] ?? 'out/extension.js');
// Top-level imports may extend VS Code classes or create event emitters; no
// activation functions are invoked by this probe.
const api = new Proxy(function () {}, {
  get: (_target, key) => key === 'version' ? '1.90.0' : key === 'then' ? undefined : api,
  apply: () => api,
  construct: () => api
});
const declarations = fs.readFileSync(require.resolve('@types/vscode/index.d.ts'), 'utf8');
const names = [...declarations.matchAll(/export\s+(?:abstract\s+)?(?:class|namespace|enum|function|const|let)\s+(\w+)/g)]
  .map(match => match[1]);
const vscode = Object.fromEntries(names.map(key => [key, api]));
vscode.version = '1.90.0';
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
const before = new Set(Object.keys(require.cache));
const start = performance.now();
try {
  const extension = require(entry);
  if (typeof extension.activate !== 'function') throw new Error('Missing extension activate export');
  const milliseconds = performance.now() - start;
  const modules = Object.keys(require.cache).filter(file => !before.has(file));
  console.log(JSON.stringify({
    entry,
    milliseconds: Number(milliseconds.toFixed(2)),
    modulesLoaded: modules.length,
    serverModulesLoaded: modules.filter(file => /vscode-languageserver[\\/]lib/.test(file)).length
  }));
} finally {
  Module._load = originalLoad;
}
