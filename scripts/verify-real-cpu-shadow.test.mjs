// @index scripts-test — phase-4 real-CPU shadow 的 fail-closed 路径与分类回归

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  classifyBuiltinExecution,
  discoverCaseManifests,
  manifestExecutionExpectations,
  parseStrictArchivedHexText,
  realCpuShadowExitCode,
  resolveArchivedCaseFile,
  resolveLegacyTraceFile
} from './verify-real-cpu-shadow-core.mjs';

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discovers a repository, direct case directory, and direct case.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-real-shadow-discovery-'));
  temporaryRoots.push(root);
  const caseDir = path.join(root, '.co', 'cases', 'case with space');
  const manifest = path.join(caseDir, 'case.json');
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(manifest, '{}');

  assert.deepEqual(discoverCaseManifests(root), [manifest]);
  assert.deepEqual(discoverCaseManifests(path.join(root, '.co', 'cases')), [manifest]);
  assert.deepEqual(discoverCaseManifests(caseDir), [manifest]);
  assert.deepEqual(discoverCaseManifests(manifest), [manifest]);
  assert.deepEqual(discoverCaseManifests(path.join(root, 'missing')), []);
});

test('accepts only allowlisted, explicit out-of-domain diagnostics as not comparable', () => {
  assert.equal(classifyBuiltinExecution({
    status: 'out-of-domain',
    diagnostic: { code: 'mips-core.exec.divide-by-zero', reason: 'divide-by-zero' }
  }).status, 'notComparable');
  assert.equal(classifyBuiltinExecution({
    status: 'out-of-domain',
    diagnostic: { code: 'mips-core.exec.future', reason: 'future-reason' }
  }).status, 'inconclusive');
  assert.equal(classifyBuiltinExecution({ status: 'out-of-domain' }).status, 'inconclusive');
});

test('treats step limits, engine failures, and missing diagnostics as inconclusive', () => {
  assert.equal(classifyBuiltinExecution({ status: 'step-limit' }).status, 'inconclusive');
  assert.equal(classifyBuiltinExecution({
    status: 'error',
    diagnostic: { code: 'mips-core.exec.engine-error' }
  }).status, 'inconclusive');
  assert.equal(classifyBuiltinExecution(undefined).status, 'inconclusive');
});

test('requires the archived halt PC and architectural step count to match', () => {
  const result = { status: 'halted', haltPc: '0x00003008', instructions: 7 };
  assert.equal(classifyBuiltinExecution(result, { haltPc: 0x3008, steps: 7 }).status, 'comparable');
  assert.equal(classifyBuiltinExecution(result, { haltPc: 0x300c, steps: 7 }).status, 'inconclusive');
  assert.equal(classifyBuiltinExecution(result, { haltPc: 0x3008, steps: 8 }).status, 'inconclusive');

  assert.deepEqual(manifestExecutionExpectations({
    version: 2,
    program: { machineCode: { haltPc: '0x00003008' } },
    oracle: { steps: 7, runConfiguration: { traceLevel: 2 } }
  }), { haltPc: 0x3008, steps: 7, issues: [] });
  assert.match(manifestExecutionExpectations({
    version: 2,
    program: { machineCode: { haltPc: 'not-a-pc' } },
    oracle: { steps: -1, runConfiguration: { traceLevel: 2 } }
  }).issues.join('\n'), /haltPc[\s\S]*oracle\.steps/);
  assert.match(manifestExecutionExpectations({
    version: 2,
    program: { machineCode: { haltPc: 0x3008 } },
    oracle: { runConfiguration: { traceLevel: 1 } }
  }).issues.join('\n'), /steps is missing[\s\S]*traceLevel 2/);
});

test('fails the evidence command when no cases were selected', () => {
  assert.equal(realCpuShadowExitCode({ cases: 0, matched: 0, inconclusive: 0, corrupt: 0 }), 1);
  assert.equal(realCpuShadowExitCode({ cases: 1, matched: 0, inconclusive: 1, corrupt: 0 }), 1);
  assert.equal(realCpuShadowExitCode({ cases: 1, matched: 0, inconclusive: 0, corrupt: 1 }), 1);
  assert.equal(realCpuShadowExitCode({ cases: 1, matched: 0, inconclusive: 0, corrupt: 0 }), 1);
  assert.equal(realCpuShadowExitCode({ cases: 1, matched: 1, inconclusive: 0, corrupt: 0 }), 0);
});

test('falls back to the case-local machine code when a v1 absolute path moved', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-real-shadow-v1-path-'));
  temporaryRoots.push(root);
  const caseDir = path.join(root, 'case');
  fs.mkdirSync(caseDir);
  const local = path.join(caseDir, 'code.txt');
  fs.writeFileSync(local, '00000000\n');

  assert.equal(
    resolveArchivedCaseFile(caseDir, path.join(root, 'deleted-workspace', 'code.txt'), 'code.txt'),
    local
  );
});

test('resolves a moved v1 manifest trace with its archived basename', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-real-shadow-v1-trace-'));
  temporaryRoots.push(root);
  const marsDir = path.join(root, 'mars');
  fs.mkdirSync(marsDir);
  const local = path.join(marsDir, 'custom-name.mars.out');
  fs.writeFileSync(local, '@00003000: $8 <= 0000002A\n');
  assert.equal(resolveLegacyTraceFile(root, {
    version: 1,
    artifacts: { mars: { traceOut: path.join(root, 'deleted', 'custom-name.mars.out') } }
  }), local);
});

test('rejects partial, short, and over-wide HexText words', () => {
  assert.deepEqual(parseStrictArchivedHexText('3408002a\n0x1000ffff\n'), [0x3408002a, 0x1000ffff]);
  for (const text of ['1000ffffJUNK\n', '1234\n', '000000000\n']) {
    assert.throws(() => parseStrictArchivedHexText(text), /malformed HexText/);
  }
});

test('runs a v1 case through its custom trace and rejects a changed machine snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-real-shadow-v1-e2e-'));
  temporaryRoots.push(root);
  const caseDir = path.join(root, 'case');
  const marsDir = path.join(caseDir, 'mars');
  fs.mkdirSync(marsDir, { recursive: true });
  const code = Buffer.from('3408002a\n1000ffff\n00000000\n');
  const codeFile = path.join(caseDir, 'code.txt');
  fs.writeFileSync(codeFile, code);
  const traceName = 'actual-program-name.mars.out';
  fs.writeFileSync(path.join(marsDir, traceName), '@00003000: $8 <= 0000002A\n');
  const manifest = {
    version: 1,
    caseId: 'v1-custom-trace',
    createdAt: '2026-08-28T00:00:00.000Z',
    profile: 'P3',
    originalAsmPath: path.join(root, 'moved', 'main.asm'),
    asmSnapshot: { path: 'program.asm', sha256: 'a'.repeat(64), bytes: 1 },
    source: { kind: 'selected' },
    machineCode: {
      path: path.join(root, 'moved', 'code.txt'),
      sha256: crypto.createHash('sha256').update(code).digest('hex'),
      bytes: code.byteLength,
      wordCount: 3,
      haltPc: 0x3004
    },
    artifacts: {
      mars: { traceOut: path.join(root, 'moved', traceName) }
    }
  };
  const manifestFile = path.join(caseDir, 'case.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest)}\n`);
  const script = path.resolve('scripts/verify-real-cpu-shadow.mjs');
  const matched = spawnSync(process.execPath, [script, caseDir], { encoding: 'utf8' });
  assert.equal(matched.status, 0, `${matched.stdout}\n${matched.stderr}`);
  assert.match(matched.stdout, /matched[\s\S]*"matched":1/);

  manifest.machineCode.sha256 = '0'.repeat(64);
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest)}\n`);
  const corrupt = spawnSync(process.execPath, [script, caseDir], { encoding: 'utf8' });
  assert.equal(corrupt.status, 1, `${corrupt.stdout}\n${corrupt.stderr}`);
  assert.match(corrupt.stdout, /corrupt[\s\S]*bytes\/hash differ/);
});
