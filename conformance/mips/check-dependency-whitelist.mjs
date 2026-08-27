#!/usr/bin/env node
/**
 * Enforce both conformance independence and the expected-data filesystem membrane.
 *
 * General conformance code may import only node: builtins and relative files that
 * remain inside conformance/mips. The expected-data dependency closure is stricter:
 * it cannot import filesystem/process escape hatches and must use
 * expected/guardedFs.mjs, which rejects every lexical or real path outside this
 * directory. Consequently a dynamic path assembled at runtime cannot read the
 * production catalog, source tree, or production contracts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const conformanceDependencyRoot = path.dirname(fileURLToPath(import.meta.url));
const importPattern = /(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const sourceExtensions = Object.freeze(['', '.mjs', '.js', '.ts']);
const expectedArtifactRoots = Object.freeze([
  'runner/caseManifest.mjs',
  'runner/courseVectorArtifact.mjs',
  'runner/isaGoldenArtifact.mjs'
]);
const forbiddenExpectedBuiltins = new Set(['node:child_process', 'node:module', 'node:vm', 'node:worker_threads']);

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sourceFiles(root) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.cache') walk(file);
      } else if (/\.(?:mjs|js|ts)$/.test(entry.name)) {
        files.push(file);
      }
    }
  }
  walk(root);
  return files.sort();
}

function staticSpecifiers(text) {
  return [...text.matchAll(importPattern)].map((match) => match[1] ?? match[2] ?? match[3]).filter(Boolean);
}

function resolveRelativeModule(file, specifier) {
  const base = path.resolve(path.dirname(file), specifier);
  for (const extension of sourceExtensions) {
    const candidate = `${base}${extension}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  for (const extension of sourceExtensions.slice(1)) {
    const candidate = path.join(base, `index${extension}`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

export function analyzeExpectedTrustSource(text, options = {}) {
  const file = options.file ?? '<expected-source>';
  const allowNativeFs = options.allowNativeFs === true;
  const violations = [];
  const specifiers = staticSpecifiers(text);
  for (const specifier of specifiers) {
    if (!allowNativeFs && (specifier === 'node:fs' || specifier === 'node:fs/promises')) {
      violations.push(`${file}: expected-data dependency imports ${specifier}; use expected/guardedFs.mjs`);
    }
    if (forbiddenExpectedBuiltins.has(specifier)) {
      violations.push(`${file}: expected-data dependency imports forbidden escape hatch ${specifier}`);
    }
  }
  const riskyExpressions = [
    [/\bimport\s*\(/u, 'dynamic import'],
    [/\brequire\s*\(/u, 'require()'],
    [/\bcreateRequire\b/u, 'createRequire'],
    [/\bprocess\s*\.\s*getBuiltinModule\b/u, 'process.getBuiltinModule'],
    [/\b(?:eval|Function)\s*\(/u, 'runtime code evaluation']
  ];
  for (const [pattern, label] of riskyExpressions) {
    if (pattern.test(text)) violations.push(`${file}: expected-data dependency uses forbidden ${label}`);
  }
  return violations;
}

function expectedTrustClosure(root, files, violations) {
  const guardedFs = path.join(root, 'expected', 'guardedFs.mjs');
  const roots = [
    ...files.filter((file) => isWithin(path.join(root, 'expected'), file)),
    ...expectedArtifactRoots.map((relative) => path.join(root, ...relative.split('/')))
  ];
  const pending = [...new Set(roots)];
  const closure = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (closure.has(file)) continue;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      violations.push(`expected-data trust root is missing: ${file}`);
      continue;
    }
    closure.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const specifier of staticSpecifiers(text)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveRelativeModule(file, specifier);
      if (!resolved) {
        violations.push(`${file}: cannot resolve expected-data dependency ${specifier}`);
      } else if (isWithin(root, resolved) && !closure.has(resolved)) {
        pending.push(resolved);
      }
    }
  }
  for (const file of closure) {
    violations.push(...analyzeExpectedTrustSource(fs.readFileSync(file, 'utf8'), {
      file,
      allowNativeFs: path.resolve(file) === path.resolve(guardedFs)
    }));
  }
  const directGuardUsers = roots.filter((file) => path.resolve(file) !== path.resolve(guardedFs));
  for (const file of directGuardUsers) {
    const text = fs.readFileSync(file, 'utf8');
    if (/\bfs\s*\./u.test(text) && !staticSpecifiers(text).some((specifier) => specifier.endsWith('/guardedFs.mjs'))) {
      violations.push(`${file}: expected-data filesystem use does not import expected/guardedFs.mjs`);
    }
  }
  return closure;
}

export function analyzeConformanceDependencies(root = conformanceDependencyRoot) {
  const resolvedRoot = path.resolve(root);
  const violations = [];
  const files = sourceFiles(resolvedRoot);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const specifier of staticSpecifiers(text)) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) {
        const resolved = resolveRelativeModule(file, specifier) ?? path.resolve(path.dirname(file), specifier);
        if (isWithin(resolvedRoot, resolved)) continue;
        violations.push(`${file}: imports ${specifier} which escapes conformance/mips`);
      } else {
        violations.push(`${file}: imports external module "${specifier}"`);
      }
    }
  }
  expectedTrustClosure(resolvedRoot, files, violations);
  return Object.freeze([...new Set(violations)].sort());
}

function main() {
  const violations = analyzeConformanceDependencies();
  if (violations.length) {
    process.stderr.write(`Conformance dependency whitelist FAILED:\n${violations.map((violation) => `  - ${violation}`).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Conformance dependency whitelist OK; expected-data filesystem membrane is closed.\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
