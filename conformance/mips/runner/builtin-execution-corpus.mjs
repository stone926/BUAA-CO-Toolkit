#!/usr/bin/env node
/** Execute the frozen 255-case corpus through the builtin assembler/executor JSONL CLI. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExecutionCorpusManifest } from '../corpus/generate-execution-corpus.mjs';
import { renderExecutionProgram } from '../corpus/execution-program-renderer.mjs';
import { canonicalJson } from './canonicalJson.mjs';
import { invokeTsCli } from './tsCliProcess.mjs';

const runnerRoot = path.dirname(fileURLToPath(import.meta.url));
const conformanceRoot = path.resolve(runnerRoot, '..');
const corpusRoot = path.join(conformanceRoot, 'corpus');
const manifestFile = path.join(corpusRoot, 'execution-corpus.json');
const profiles = Object.freeze(['P3', 'P4', 'P5', 'P6', 'P7']);
const sha256Pattern = /^[0-9a-f]{64}$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(`builtin execution corpus: ${message}`);
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function fixedWord(value) {
  if (typeof value === 'string' && /^0x[0-9a-f]{8}$/iu.test(value)) return value.toLowerCase();
  invariant(Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff, `invalid word ${value}`);
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

function wordImageSha256(words) {
  return sha256Text(`${words.map((word) => fixedWord(word).slice(2)).join('\n')}\n`);
}

function caseSourcePath(entry) {
  invariant(typeof entry.file === 'string' && entry.file.length > 0, `${entry.id} has no source path`);
  const sourceFile = path.resolve(corpusRoot, ...entry.file.split('/'));
  const relative = path.relative(path.join(corpusRoot, 'execution-handwritten'), sourceFile);
  invariant(relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative),
    `${entry.id} source escapes the handwritten corpus`);
  const stat = fs.lstatSync(sourceFile);
  invariant(stat.isFile() && !stat.isSymbolicLink(), `${entry.id} source is not a regular file`);
  return sourceFile;
}

export function validateExecutedCase(entry, result, expectedHaltPc) {
  invariant(result && result.status === 'halted', `${entry.id} did not halt: ${result?.status ?? 'missing result'}`);
  invariant(result.haltReason === 'course-halt-loop', `${entry.id} stopped for ${result.haltReason ?? 'an unknown reason'}`);
  invariant(typeof expectedHaltPc === 'string' && result.haltPc?.toLowerCase() === expectedHaltPc,
    `${entry.id} reached ${result.haltPc ?? 'no halt PC'}, expected ${expectedHaltPc ?? 'a frozen halt PC'}`);
  invariant(Number.isSafeInteger(result.instructions) && result.instructions > 0 && result.instructions <= entry.maxSteps,
    `${entry.id} instruction count is outside the budget (${result.instructions}/${entry.maxSteps})`);
  invariant(result.finalState?.pc?.toLowerCase() === expectedHaltPc,
    `${entry.id} final PC does not equal its course halt PC`);
  invariant(sha256Pattern.test(result.finalStateDigest ?? ''), `${entry.id} omitted a valid final-state digest`);
  invariant(sha256Pattern.test(result.imageFingerprint ?? ''), `${entry.id} omitted a valid execution image fingerprint`);
}

function loadCases() {
  const committed = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const rebuilt = buildExecutionCorpusManifest();
  invariant(canonicalJson(committed) === canonicalJson(rebuilt), 'execution-corpus.json differs from its independent frozen renderer');
  const cases = [];
  for (const entry of committed.generated) {
    const program = renderExecutionProgram(entry);
    invariant(program.sourceSha256 === entry.sourceSha256, `${entry.id} frozen source hash differs`);
    invariant(program.imageSha256 === entry.imageSha256, `${entry.id} independent frozen image hash differs`);
    invariant(program.words.length === entry.imageWordCount, `${entry.id} frozen image word count differs`);
    invariant(program.haltPc === entry.haltPc && program.haltWord === entry.haltWord, `${entry.id} frozen halt metadata differs`);
    cases.push({ ...entry, kind: 'generated', source: program.source, independentWords: program.words });
  }
  for (const entry of committed.handwritten) {
    const source = fs.readFileSync(caseSourcePath(entry), 'utf8').replace(/\r\n?/gu, '\n');
    invariant(sha256Text(source) === entry.sourceSha256, `${entry.id} frozen handwritten source hash differs`);
    cases.push({ ...entry, kind: 'handwritten', source });
  }
  invariant(cases.length === 255, `expected 255 frozen cases, got ${cases.length}`);
  for (const profile of profiles) {
    invariant(cases.filter((entry) => entry.profile === profile).length === 51, `${profile} frozen case count is not 51`);
  }
  return cases;
}

function validateAssembledImage(entry, image) {
  invariant(image && Array.isArray(image.segments), `${entry.id} assembler omitted ProgramImage segments`);
  invariant(sha256Pattern.test(image.fingerprint ?? ''), `${entry.id} assembler omitted a valid ProgramImage fingerprint`);
  const nonEmpty = image.segments.filter((segment) => Array.isArray(segment.words) && segment.words.length > 0);
  invariant(nonEmpty.length === 1 && nonEmpty[0].name === 'text' && Number(nonEmpty[0].baseAddress) === 0x3000,
    `${entry.id} image is not one contiguous text segment at 0x3000`);
  invariant(Number(image.entryPc) === 0x3000, `${entry.id} entry PC is not 0x3000`);
  const words = nonEmpty[0].words.map(fixedWord);
  invariant(words.length >= 2 && words.at(-2) === '0x1000ffff' && words.at(-1) === '0x00000000',
    `${entry.id} image does not end with the course beq-self+nop halt pair`);
  const haltPc = fixedWord(0x3000 + (words.length - 2) * 4);
  if (entry.kind === 'generated') {
    invariant(canonicalJson(words) === canonicalJson(entry.independentWords), `${entry.id} assembled machine words differ from the independent frozen renderer`);
    invariant(wordImageSha256(words) === entry.imageSha256, `${entry.id} assembled image SHA-256 differs from the frozen independent image`);
    invariant(words.length === entry.imageWordCount, `${entry.id} assembled image word count differs from the frozen manifest`);
    invariant(haltPc === entry.haltPc, `${entry.id} assembled halt PC differs from the frozen manifest`);
  }
  invariant(entry.expectedDifferenceContractId === null,
    `${entry.id} carries a historical difference label; builtin execution does not treat legacy MARS differences as expected`);
  return { haltPc, words };
}

export function runBuiltinExecutionCorpus(options = {}) {
  const cases = loadCases();
  const requests = cases.map((entry) => ({
    protocolVersion: 1,
    requestId: `assemble:${entry.id}`,
    operation: 'assembler.assemble',
    profile: entry.profile,
    sources: [{ id: 'source-0000', text: entry.source }]
  }));
  const cliOptions = { ...options, maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024 };
  const assembled = invokeTsCli(requests, cliOptions);
  const ready = [];
  const failures = [];
  for (const entry of cases) {
    const response = assembled.get(`assemble:${entry.id}`);
    if (response?.ok !== true || response.result?.ok !== true || !response.result?.image) {
      failures.push(`${entry.id}: assembler rejected frozen source (${response?.error?.message ?? response?.result?.diagnostics?.[0]?.message ?? 'missing response'})`);
      continue;
    }
    try {
      const { haltPc } = validateAssembledImage(entry, response.result.image);
      ready.push({ entry, image: response.result.image, haltPc });
    } catch (error) {
      failures.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));

  const executions = invokeTsCli(ready.map(({ entry, image, haltPc }) => ({
    protocolVersion: 1,
    requestId: `execute:${entry.id}`,
    operation: 'machine.execute',
    profile: entry.profile,
    enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
    segments: image.segments.map((segment) => ({
      name: segment.name,
      baseAddress: fixedWord(segment.baseAddress),
      words: segment.words.map(fixedWord)
    })),
    entryPc: fixedWord(image.entryPc),
    haltPc,
    maxSteps: entry.maxSteps,
    collectTrace: true
  })), cliOptions);

  const profileCounts = Object.fromEntries(profiles.map((profile) => [profile, { generated: 0, handwritten: 0, executed: 0 }]));
  const failuresDuringExecution = [];
  for (const item of ready) {
    const response = executions.get(`execute:${item.entry.id}`);
    try {
      invariant(response?.ok === true && response.result, `${item.entry.id} executor request failed: ${response?.error?.message ?? 'missing response'}`);
      invariant(!response.result.diagnostic, `${item.entry.id} returned an out-of-domain diagnostic: ${response.result.diagnostic?.code ?? 'unknown'}`);
      validateExecutedCase(item.entry, response.result, item.haltPc);
      const counts = profileCounts[item.entry.profile];
      counts[item.entry.kind] += 1;
      counts.executed += 1;
    } catch (error) {
      failuresDuringExecution.push(`${item.entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failuresDuringExecution.length) throw new Error(failuresDuringExecution.join('\n'));
  invariant(Object.values(profileCounts).every((counts) => counts.executed === 51
    && counts.generated === 50 && counts.handwritten === 1), 'per-profile execution counts differ from the frozen manifest');
  return { cases: cases.length, profileCounts };
}

function main(argv) {
  let cli;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--cli') cli = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  const summary = runBuiltinExecutionCorpus({ cli });
  process.stdout.write(`Builtin frozen execution corpus passed: ${summary.cases} cases through JSONL assembler/executor.\n`);
  for (const [profile, counts] of Object.entries(summary.profileCounts)) {
    process.stdout.write(`  ${profile}: ${counts.executed} executed (${counts.generated} generated, ${counts.handwritten} handwritten)\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
