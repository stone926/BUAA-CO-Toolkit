import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

import {
  analyzeConformanceDependencies,
  analyzeExpectedTrustSource
} from '../check-dependency-whitelist.mjs';
import {
  expectedFilesystemRoot,
  readFileSync as guardedReadFileSync
} from '../expected/guardedFs.mjs';

test('current conformance graph satisfies the static whitelist and expected trust closure', () => {
  assert.deepEqual(analyzeConformanceDependencies(), []);
});

test('expected filesystem membrane rejects dynamically assembled production paths', () => {
  const productionCatalog = path.resolve(expectedFilesystemRoot, '..', '..', 'resources', 'mips', 'isa.json');
  const productionContracts = path.resolve(expectedFilesystemRoot, '..', '..', 'src', 'mips', 'providers', 'contracts.ts');
  assert.throws(() => guardedReadFileSync(productionCatalog, 'utf8'), /escapes conformance\/mips/);
  assert.throws(() => guardedReadFileSync(productionContracts, 'utf8'), /escapes conformance\/mips/);
  assert.match(guardedReadFileSync(path.join(expectedFilesystemRoot, 'contract', 'contracts.json'), 'utf8'), /COURSE-P3-ISA-001/);
});

test('expected trust scanner rejects fs bypasses and runtime module loading', () => {
  const directFs = "import * as fs from 'node:fs'; const pieces=['..','..','resources','mips','isa.json']; fs.readFileSync(pieces.join('/'));";
  assert.match(analyzeExpectedTrustSource(directFs, { file: 'malicious.mjs' }).join('\n'), /imports node:fs/);

  const dynamicImport = "const name = ['node:', 'fs'].join(''); const fs = await import(name);";
  assert.match(analyzeExpectedTrustSource(dynamicImport, { file: 'malicious.mjs' }).join('\n'), /dynamic import/);

  const childProcess = "import { execFileSync } from 'node:child_process';";
  assert.match(analyzeExpectedTrustSource(childProcess, { file: 'malicious.mjs' }).join('\n'), /escape hatch/);
});
