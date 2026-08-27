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
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import * as url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const coreDir = path.join(root, 'src', 'mips', 'core');
const moduleSpecifierPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|\bimport\s*\(['"]([^'"]+)['"]\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

const forbiddenBare = new Set([
  'vscode', 'vscode-languageserver', 'vscode-languageserver-textdocument',
  'vscode-uri', 'fs', 'path', 'worker_threads', 'child_process', 'os'
]);
const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, '').split('/')[0]));

const violations = [];
const legacyProcessConsumers = new Set([
  'src/mips.ts',
  'src/mips/providers/legacyMarsProvider.ts'
]);
const providerNeutralOrchestration = new Set([
  'src/courseTesting/traceRunner.ts',
  'src/courseTestLogisim.ts'
]);
const legacyTraceApiPattern = /\b(?:iterMarsDetailedTraceEvents|courseTraceMarsHaltError|courseMarsOracleCompatibilityError|machineCodeNeedsDetailedMarsTrace|marsDetailedUndefinedBehaviorError|traceLevel|traceOutput|imageRef)\b/;

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
    for (const match of text.matchAll(moduleSpecifierPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) {
        continue;
      }
      const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
      const bareRoot = bare.split('/')[0];
      if (specifier.startsWith('node:') || nodeBuiltins.has(bareRoot)) {
        violations.push(`${relative}: imports forbidden module "${specifier}"`);
        continue;
      }
      if (!specifier.startsWith('.') && forbiddenBare.has(bareRoot)) {
        violations.push(`${relative}: imports forbidden module "${specifier}"`);
        continue;
      }
      if (specifier.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), specifier);
        const fromCore = path.relative(coreDir, resolved);
        if (fromCore === '..' || fromCore.startsWith('..' + path.sep) || path.isAbsolute(fromCore)) {
          violations.push(`${relative}: relative import "${specifier}" escapes src/mips/core`);
        }
      }
    }
  }
}

function walkProduction(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'test') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkProduction(file);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    const relative = path.relative(root, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    if (!legacyProcessConsumers.has(relative) && /\brunMarsFile\b/.test(text)) {
      violations.push(`${relative}: consumes runMarsFile outside the legacy provider adapter`);
    }
    if (providerNeutralOrchestration.has(relative) && legacyTraceApiPattern.test(text)) {
      violations.push(`${relative}: consumes a legacy MARS request/trace API in provider-neutral orchestration`);
    }
    if (relative.startsWith('src/courseTesting/') || relative === 'src/courseTestLogisim.ts') {
      for (const match of text.matchAll(moduleSpecifierPattern)) {
        const specifier = match[1] ?? match[2] ?? match[3];
        if (specifier && /(?:^|\/)mips\/legacy(?:\/|$)/.test(specifier.replace(/\\/g, '/'))) {
          violations.push(`${relative}: imports legacy/reference implementation "${specifier}"`);
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
  walkProduction(path.join(root, 'src'));
}

if (violations.length) {
  console.error('Module boundary check FAILED:');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log('Module boundary check OK: core purity and provider-neutral legacy boundaries hold.');
}
