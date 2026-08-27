#!/usr/bin/env node
/** Deterministically materialize the frozen L1 PR seed manifest. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSeedProgram, seedRendererRevision } from './seed-program-renderer.mjs';

const profiles = Object.freeze(['P3', 'P4', 'P5', 'P6', 'P7']);
const countPerProfile = 50;
const runnerRevision = 1;
const outputFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seeds.json');

function fnv1aUtf8U32(text) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function limits(profile) {
  return profile === 'P7'
    ? { meaningfulTransitionLimit: 16384, stepPolicy: 'max(512,16N+256)', jobWallClockMs: 300000 }
    : profile === 'P5' || profile === 'P6'
      ? { meaningfulTransitionLimit: 8192, stepPolicy: 'max(256,4N+64)', jobWallClockMs: 120000 }
      : { meaningfulTransitionLimit: 4096, stepPolicy: 'max(256,2N+64)', jobWallClockMs: 120000 };
}

export function buildSeedCases() {
  const cases = [];
  for (const profile of profiles) {
    const profileLimits = limits(profile);
    for (let ordinal = 1; ordinal <= countPerProfile; ordinal++) {
      const padded = String(ordinal).padStart(4, '0');
      const seed = `conformance-${profile.toLowerCase()}-pr-v1-${padded}`;
      const seedCase = {
        id: `SEED-${profile}-${padded}`,
        profile,
        seed,
        seedHashU32: `0x${fnv1aUtf8U32(seed).toString(16).padStart(8, '0')}`,
        sourceWordLimit: 4096,
        meaningfulTransitionLimit: profileLimits.meaningfulTransitionLimit,
        stepPolicy: profileLimits.stepPolicy,
        haltPolicy: 'standard-beq-self-plus-nop',
        jobWallClockMs: profileLimits.jobWallClockMs,
        shard: (ordinal - 1) % 10,
        runnerRevision
      };
      const rendered = renderSeedProgram(seedCase);
      cases.push({
        ...seedCase,
        rendererRevision: seedRendererRevision,
        sourceSha256: rendered.sourceSha256,
        imageSha256: rendered.imageSha256,
        imageWordCount: rendered.words.length,
        evidenceCapabilityId: rendered.evidenceCapabilityId
      });
    }
  }
  return cases;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function buildSeedManifest() {
  const cases = buildSeedCases();
  const casesSha256 = crypto.createHash('sha256').update(JSON.stringify(canonical(cases)), 'utf8').digest('hex');
  return {
    schemaRevision: 3,
    description: 'Frozen L1 PR seeds: exactly 50 deterministic source/image cases per P3-P7 profile. Source and image hashes are rendered without importing production generator/catalog/contract code and are verified through the JSONL ISA process boundary.',
    seedHashFunction: 'fnv1a-utf8-bytes-u32',
    batch: { id: 'L1-PR-FIXED-V1', countPerProfile, profiles, runnerRevision, rendererRevision: seedRendererRevision },
    cases,
    integrity: { algorithm: 'sha256-canonical-json-v1', casesSha256 }
  };
}

export function serializedSeedManifest() {
  return `${JSON.stringify(buildSeedManifest(), null, 2)}\n`;
}

export function run(argv) {
  if (argv.length !== 1 || !['--write', '--check'].includes(argv[0])) {
    throw new Error('Usage: generate-seeds.mjs --write | --check');
  }
  const expected = serializedSeedManifest();
  if (argv[0] === '--write') {
    fs.writeFileSync(outputFile, expected, 'utf8');
    process.stdout.write(`wrote ${outputFile}\n`);
    return 0;
  }
  const actual = fs.readFileSync(outputFile, 'utf8').replace(/\r\n?/g, '\n');
  if (actual !== expected) {
    throw new Error('seeds.json is stale; run generate-seeds.mjs --write and review the diff');
  }
  process.stdout.write(`seed manifest OK: ${profiles.length * countPerProfile} explicit fixed cases\n`);
  return 0;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
