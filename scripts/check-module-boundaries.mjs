#!/usr/bin/env node
/**
 * Enforce the src/mips/core/** module boundary (plan section 5.1).
 *
 * Core must stay a pure engine with no host dependencies:
 *   - forbidden module specifiers: vscode, vscode-languageserver, fs, path,
 *     worker_threads (bare and node: prefixed variants);
 *   - relative imports must resolve inside src/mips/core (no escaping upward
 *     into providers/host or elsewhere in src).
 *
 * Exit code 0 when clean; 1 on any violation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const coreDir = path.join(root, 'src', 'mips', 'core');
const importPattern = /import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\s*\(['"]([^'"]+)['"]\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

const forbiddenBare = new Set([
  'vscode', 'vscode-languageserver', 'vscode-languageserver-textdocument',
  'vscode-uri', 'fs', 'path', 'worker_threads', 'child_process', 'os'
]);

const violations = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }
    if (!entry.name.endsWith('.ts')) {
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const relative = path.relative(coreDir, file).split(path.sep).join('/');
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) {
        continue;
      }
      const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
      if (specifier.startsWith('node:') && forbiddenBare.has(bare)) {
        violations.push(`${relative}: imports forbidden module "${specifier}"`);
        continue;
      }
      if (!specifier.startsWith('.') && forbiddenBare.has(specifier)) {
        violations.push(`${relative}: imports forbidden module "${specifier}"`);
        continue;
      }
      if (specifier.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), specifier);
        if (!resolved.startsWith(coreDir + path.sep)) {
          violations.push(`${relative}: relative import "${specifier}" escapes src/mips/core`);
        }
      }
    }
  }
}

if (!fs.existsSync(coreDir)) {
  console.error('src/mips/core does not exist.');
  process.exitCode = 1;
} else {
  walk(coreDir);
}

if (violations.length) {
  console.error('Module boundary check FAILED:');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log('Module boundary check OK: src/mips/core has no host dependencies.');
}
