#!/usr/bin/env node
// End-to-end smoke for the compiled, process-isolated MIPS JSONL interface.
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'out', 'mips', 'cli', 'main.js');

function run(lines, expectedStatus = 0) {
  return parseRun(runRaw(`${lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')}\n`, expectedStatus));
}

function runRaw(input, expectedStatus) {
  const result = spawnSync(process.execPath, [cli], {
    cwd: root,
    encoding: 'utf8',
    input,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== expectedStatus) {
    throw new Error(`MIPS CLI exited ${result.status}; expected ${expectedStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function parseRun(result) {
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const valid = run([
  { protocolVersion: 1, requestId: 'describe', operation: 'describe' },
  {
    protocolVersion: 1,
    requestId: 'encode',
    operation: 'isa.encode',
    mnemonic: 'add',
    operands: { rd: 9, rs: 10, rt: 11 }
  },
  {
    protocolVersion: 1,
    requestId: 'decode',
    operation: 'isa.decode',
    word: '0x014b48e0',
    scope: { profile: 'P7', enabledLayers: ['required'] }
  }
]);

if (valid.length !== 3
  || !valid.every((response) => response.protocolVersion === 1 && response.ok === true)
  || valid[1].result?.word !== '0x014b4820'
  || valid[2].result?.exactMnemonic !== 'add'
  || valid[2].result?.canonicalMnemonic !== undefined) {
  throw new Error(`unexpected MIPS CLI response: ${JSON.stringify(valid)}`);
}

const invalid = run([
  '{not-json',
  { protocolVersion: 1, requestId: 'unknown', operation: 'unknown' }
], 1);
if (invalid.length !== 2
  || invalid[0].error?.code !== 'invalid-json'
  || invalid[1].error?.code !== 'unsupported-operation') {
  throw new Error(`MIPS CLI did not fail closed: ${JSON.stringify(invalid)}`);
}

const blank = runRaw('\n \r\n\t\n', 2);
if (blank.stdout !== '' || !blank.stderr.includes('expected JSONL requests')) {
  throw new Error(`blank-only CLI input did not fail as usage error: ${JSON.stringify(blank)}`);
}

const tooLarge = parseRun(runRaw(`${' '.repeat(4 * 1024 * 1024)}x\n${JSON.stringify({
  protocolVersion: 1, requestId: 'after-large', operation: 'describe'
})}\n`, 1));
if (tooLarge.length !== 2
  || tooLarge[0].error?.code !== 'request-too-large'
  || tooLarge[1].requestId !== 'after-large'
  || tooLarge[1].ok !== true) {
  throw new Error(`oversized CLI line was not bounded/recovered: ${JSON.stringify(tooLarge)}`);
}

console.log('Compiled MIPS JSONL CLI verification passed.');
