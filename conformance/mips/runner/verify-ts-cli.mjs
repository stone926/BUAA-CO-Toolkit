#!/usr/bin/env node
/** Independent process-level verification of the production MIPS JSONL CLI. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIsaGolden } from './isaGoldenArtifact.mjs';

const runnerRoot = path.dirname(fileURLToPath(import.meta.url));
const conformanceRoot = path.resolve(runnerRoot, '..');
const extensionRoot = path.resolve(conformanceRoot, '..', '..');
const defaultCli = path.join(extensionRoot, 'out', 'mips', 'cli', 'main.js');

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function invariant(condition, message) {
  if (!condition) fail(message);
}

export function parseTsCliVerificationArgs(argv) {
  const options = {
    cli: process.env.BUAA_CO_MIPS_ENGINE_CLI || defaultCli
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--cli') {
      options.cli = argv[++index];
      if (!options.cli || options.cli.startsWith('--')) fail('--cli requires a path', 2);
    } else {
      fail(`unknown argument: ${arg}`, 2);
    }
  }
  return { ...options, cli: path.resolve(options.cli) };
}

export function verifyTsCli(options) {
  const golden = loadIsaGolden();
  invariant(fs.existsSync(options.cli) && fs.statSync(options.cli).isFile(), `compiled CLI is missing: ${options.cli}`);

  const requests = [{ protocolVersion: 1, requestId: 'describe', operation: 'describe' }];
  for (const item of golden.cases) {
    requests.push({
      protocolVersion: 1,
      requestId: `encode:${item.id}`,
      operation: 'isa.encode',
      mnemonic: item.mnemonic,
      operands: item.operands
    });
    for (const profile of item.profiles) {
      requests.push({
        protocolVersion: 1,
        requestId: `decode:${item.id}:${profile}`,
        operation: 'isa.decode',
        word: item.word,
        scope: { profile, enabledLayers: ['required'] }
      });
    }
  }
  for (const item of golden.runtimeCounterexamples) {
    requests.push({
      protocolVersion: 1,
      requestId: `runtime:${item.id}`,
      operation: 'isa.decode',
      word: item.word,
      scope: { profile: item.profile, enabledLayers: item.enabledLayers }
    });
  }
  requests.push({
    protocolVersion: 1,
    requestId: 'assemble:course-smoke',
    operation: 'assembler.assemble',
    profile: 'P3',
    sources: [{
      id: 'source-0000',
      text: '.text\nmain:\n    ori $t0, $0, 42\n    beq $0, $0, main\n    nop\n'
    }]
  });
  requests.push({
    protocolVersion: 1,
    requestId: 'execute:course-p3',
    operation: 'machine.execute',
    profile: 'P3',
    segments: [{
      name: 'text',
      baseAddress: '0x00003000',
      words: [
        '0x34010005', // ori $1, $0, 5
        '0x34020003', // ori $2, $0, 3
        '0x00221820', // add $3, $1, $2
        '0xac030000', // sw $3, 0($0)
        '0x1000ffff', // course halt loop
        '0x00000000'
      ]
    }],
    haltPc: '0x00003010',
    maxSteps: 64,
    collectTrace: true
  });

  const run = spawnSync(process.execPath, [options.cli], {
    cwd: extensionRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`
  });
  if (run.error) throw run.error;
  invariant(run.status === 0, `CLI exited ${run.status}: ${run.stderr}`);
  const responses = run.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  invariant(responses.length === requests.length, `expected ${requests.length} responses, got ${responses.length}`);
  const byId = new Map(responses.map((response) => [response.requestId, response]));
  invariant(byId.size === responses.length, 'CLI returned duplicate requestId responses');

  const describe = byId.get('describe');
  invariant(describe?.ok === true, 'describe failed');
  invariant(describe.result?.catalog?.sha256 === golden.catalogSha256, 'production catalog fingerprint differs from reviewed golden');
  for (const item of golden.cases) {
    const encoded = byId.get(`encode:${item.id}`);
    invariant(encoded?.ok === true && encoded.result?.word === item.word, `${item.id} encode mismatch`);
    for (const profile of item.profiles) {
      const decoded = byId.get(`decode:${item.id}:${profile}`);
      invariant(decoded?.ok === true
        && decoded.result?.exactMnemonic === item.mnemonic
        && decoded.result?.canonicalMnemonic === item.mnemonic,
      `${item.id}/${profile} decode mismatch`);
    }
  }
  for (const item of golden.runtimeCounterexamples) {
    const decoded = byId.get(`runtime:${item.id}`);
    invariant(decoded?.ok === true, `${item.id} runtime decode failed`);
    invariant((decoded.result?.exactMnemonic ?? null) === item.exactMnemonic, `${item.id} exact runtime mismatch`);
    invariant((decoded.result?.canonicalMnemonic ?? null) === item.canonicalMnemonic, `${item.id} canonical mismatch`);
  }
  const assembled = byId.get('assemble:course-smoke');
  invariant(assembled?.ok === true && assembled.result?.ok === true, 'course assembler smoke failed');
  invariant(assembled.result?.image?.segments?.length === 1, 'course assembler smoke image shape mismatch');
  invariant(assembled.result?.image?.segments?.[0]?.words?.[0] === 0x3408002a, 'course assembler smoke word mismatch');
  const executed = byId.get('execute:course-p3');
  invariant(executed?.ok === true, 'course executor request failed');
  invariant(JSON.stringify({
    status: executed.result?.status,
    haltReason: executed.result?.haltReason,
    instructions: executed.result?.instructions,
    eventCount: executed.result?.eventCount,
    haltPc: executed.result?.haltPc,
    finalStateDigest: executed.result?.finalStateDigest
  }) === JSON.stringify({
    status: 'halted',
    haltReason: 'course-halt-loop',
    instructions: 5,
    eventCount: 5,
    haltPc: '0x00003010',
    finalStateDigest: 'dbe59168faa6522d91de39de127406d183a5216f5cdea28a7a4398efabfe43ce'
  }), 'course executor stop evidence mismatch');
  invariant(JSON.stringify(executed.result?.finalState) === JSON.stringify({
    pc: '0x00003010',
    gpr: [
      '0x00000000', '0x00000005', '0x00000003', '0x00000008',
      ...Array(28).fill('0x00000000')
    ],
    hi: '0x00000000',
    lo: '0x00000000',
    hiDefined: false,
    loDefined: false,
    dataWords: [{ address: '0x00000000', value: '0x00000008' }]
  }), 'course executor final state mismatch');
  invariant(JSON.stringify(executed.result?.trace) === JSON.stringify([
    '@00003000: $1 <= 00000005',
    '@00003004: $2 <= 00000003',
    '@00003008: $3 <= 00000008',
    '@0000300C: *00000000 <= 00000008'
  ]), 'course executor trace mismatch');
  return {
    instructions: golden.cases.length,
    runtimeCounterexamples: golden.runtimeCounterexamples.length,
    courseAssembler: 'ok',
    courseExecutor: 'ok',
    reviewStatus: golden.review.status
  };
}

function main() {
  const summary = verifyTsCli(parseTsCliVerificationArgs(process.argv.slice(2)));
  process.stdout.write(`TS CLI conformance passed: ${summary.instructions} course instructions, ${summary.runtimeCounterexamples} runtime counterexamples, review=${summary.reviewStatus}.\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`verify-ts-cli: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = Number.isSafeInteger(error?.exitCode) ? error.exitCode : 1;
}
