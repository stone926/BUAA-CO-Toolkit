#!/usr/bin/env node
/**
 * Enforce the conformance dependency whitelist.
 *
 * Conformance is an independent harness: its sources may import only
 *   - node: builtin modules,
 *   - files inside conformance/mips/ (relative paths that resolve within it).
 * Importing the production implementation (../../src/... etc.) or any npm
 * package is a violation, so expected values can never accidentally depend on
 * the code under test.
 *
 * Exit code 0 when clean; 1 on any violation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const root = path.dirname(url.fileURLToPath(import.meta.url));
const importPattern = /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\s*\(['"]([^'"]+)['"]\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

const violations = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.cache') {
        continue;
      }
      walk(file);
      continue;
    }
    if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.js') && !entry.name.endsWith('.ts')) {
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) {
        continue;
      }
      if (specifier.startsWith('node:')) {
        continue;
      }
      if (specifier.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), specifier);
        if (resolved.startsWith(root + path.sep)) {
          continue;
        }
        violations.push(`${file}: imports ${specifier} which escapes conformance/mips`);
        continue;
      }
      violations.push(`${file}: imports external module "${specifier}"`);
    }
  }
}

walk(root);

if (violations.length) {
  console.error('Conformance dependency whitelist FAILED:');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log('Conformance dependency whitelist OK.');
}
