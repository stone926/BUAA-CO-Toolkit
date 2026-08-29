#!/usr/bin/env node
/** Deterministically freeze the safe phase-6 execution differential corpus. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  executionCasesPerProfile,
  executionProfiles,
  executionRendererRevision,
  renderExecutionProgram
} from './execution-program-renderer.mjs';

const corpusRoot = path.dirname(fileURLToPath(import.meta.url));
const outputFile = path.join(corpusRoot, 'execution-corpus.json');
const handwrittenDirectory = path.join(corpusRoot, 'execution-handwritten');
const generatorRevision = 1;

const handwrittenCases = Object.freeze(executionProfiles.map((profile) => ({
  id: `EXEC-HAND-${profile}-BOUNDARY`,
  profile,
  file: `execution-handwritten/${profile.toLowerCase()}-boundary.asm`,
  maxSteps: 128,
  features: ['control-flow', 'memory', 'delay-slot-contract'],
  expectedDifferenceContractId: null
})));

function invariant(condition, message) {
  if (!condition) throw new Error(`execution corpus: ${message}`);
}

function fnv1aUtf8U32(text) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function buildExecutionCorpusManifest() {
  const generated = [];
  for (const profile of executionProfiles) {
    for (let ordinal = 1; ordinal <= executionCasesPerProfile; ordinal++) {
      const padded = String(ordinal).padStart(4, '0');
      const seed = `phase6-execution-${profile.toLowerCase()}-v1-${padded}`;
      const seedCase = {
        id: `EXEC-${profile}-${padded}`,
        profile,
        seed,
        seedHashU32: `0x${fnv1aUtf8U32(seed).toString(16).padStart(8, '0')}`
      };
      const program = renderExecutionProgram(seedCase);
      generated.push({
        ...seedCase,
        rendererRevision: program.rendererRevision,
        sourceSha256: program.sourceSha256,
        imageSha256: program.imageSha256,
        imageWordCount: program.words.length,
        haltPc: program.haltPc,
        haltWord: program.haltWord,
        maxSteps: program.maxSteps,
        features: program.features,
        expectedDifferenceContractId: program.expectedDifferenceContractId
      });
    }
  }
  const handwritten = handwrittenCases.map((entry) => {
    const absolute = path.resolve(corpusRoot, ...entry.file.split('/'));
    invariant(absolute.startsWith(`${path.resolve(handwrittenDirectory)}${path.sep}`), `${entry.id} escapes handwritten directory`);
    const source = fs.readFileSync(absolute, 'utf8').replace(/\r\n?/g, '\n');
    invariant(source.endsWith('\n'), `${entry.file} must end with LF`);
    return { ...entry, sourceSha256: sha256Text(source) };
  });
  invariant(generated.length === 250, `expected 250 generated cases, got ${generated.length}`);
  for (const profile of executionProfiles) {
    invariant(generated.filter((entry) => entry.profile === profile).length === 50, `${profile} generated count is not 50`);
    invariant(handwritten.filter((entry) => entry.profile === profile).length >= 1, `${profile} handwritten boundary case is missing`);
  }
  const payload = {
    schemaRevision: 1,
    description: 'Safe deterministic phase-6 execution differential corpus. Generated cases use bounded forward branches and a final self-halt only; handwritten cases cover profile control-flow, memory and delay-slot boundaries.',
    batch: {
      id: 'PHASE6-EXECUTION-DIFFERENTIAL-V1',
      profiles: executionProfiles,
      generatedCasesPerProfile: executionCasesPerProfile,
      generatedCases: generated.length,
      handwrittenCases: handwritten.length,
      generatorRevision,
      rendererRevision: executionRendererRevision
    },
    generated,
    handwritten
  };
  return {
    ...payload,
    integrity: {
      algorithm: 'sha256-canonical-json-v1',
      payloadSha256: sha256Text(JSON.stringify(canonical(payload)))
    }
  };
}

export function serializedExecutionCorpusManifest() {
  return `${JSON.stringify(buildExecutionCorpusManifest(), null, 2)}\n`;
}

export function run(argv) {
  if (argv.length !== 1 || !['--write', '--check'].includes(argv[0])) {
    throw new Error('Usage: generate-execution-corpus.mjs --write | --check');
  }
  const expected = serializedExecutionCorpusManifest();
  if (argv[0] === '--write') {
    fs.writeFileSync(outputFile, expected, 'utf8');
    process.stdout.write(`wrote ${outputFile}\n`);
    return 0;
  }
  const actual = fs.readFileSync(outputFile, 'utf8').replace(/\r\n?/g, '\n');
  invariant(actual === expected, 'execution-corpus.json is stale; run generate-execution-corpus.mjs --write');
  process.stdout.write('execution corpus OK: 250 generated + 5 handwritten cases\n');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
