/** Independent ISA golden schema, completeness and review-integrity checks. */
import * as crypto from 'node:crypto';
import * as fs from '../expected/guardedFs.mjs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGithubUsername } from '../governance/reviewerPolicy.mjs';
import {
  assertCandidateApproved,
  candidateDescriptor,
  sha256CanonicalJson
} from '../governance/approvalEnvelope.mjs';

const runnerRoot = path.dirname(fileURLToPath(import.meta.url));
export const isaGoldenFile = path.resolve(runnerRoot, '..', 'expected', 'isaGolden', 'course-basic-v1.json');

const hexWord = /^0x[0-9a-f]{8}$/;
const sha256 = /^[0-9a-f]{64}$/;
const identifier = /^ISA-[A-Z0-9-]+$/;
const profiles = ['P3', 'P4', 'P5', 'P6', 'P7'];
const profileSet = new Set(profiles);
const layerSet = new Set(['required', 'commonExtensions', 'marsCompatibility']);
const operandFields = ['rs', 'rt', 'rd', 'shamt', 'immediate', 'index'];

// Frozen independently from resources/mips/isa.json. Deleting a golden case or
// quietly narrowing one profile therefore fails before the production CLI runs.
const requiredByProfile = Object.freeze({
  P3: ['add', 'beq', 'lui', 'lw', 'nop', 'ori', 'sub', 'sw'],
  P4: ['add', 'beq', 'jal', 'jr', 'lui', 'lw', 'nop', 'ori', 'sub', 'sw'],
  P5: ['add', 'beq', 'jal', 'jr', 'lui', 'lw', 'nop', 'ori', 'sub', 'sw'],
  P6: [
    'add', 'addi', 'and', 'andi', 'beq', 'bne', 'div', 'divu', 'jal', 'jr',
    'lb', 'lh', 'lui', 'lw', 'mfhi', 'mflo', 'mthi', 'mtlo', 'mult', 'multu',
    'nop', 'or', 'ori', 'sb', 'sh', 'slt', 'sltu', 'sub', 'sw'
  ],
  P7: [
    'add', 'addi', 'and', 'andi', 'beq', 'bne', 'div', 'divu', 'eret', 'jal',
    'jr', 'lb', 'lh', 'lui', 'lw', 'mfc0', 'mfhi', 'mflo', 'mtc0', 'mthi',
    'mtlo', 'mult', 'multu', 'nop', 'or', 'ori', 'sb', 'sh', 'slt', 'sltu',
    'sub', 'sw', 'syscall'
  ]
});

const requiredCounterexamples = new Map([
  ['ISA-RUNTIME-NONCANONICAL-ADD', { exactMnemonic: 'add', canonicalMnemonic: null }],
  ['ISA-RUNTIME-NONCANONICAL-JR', { exactMnemonic: 'jr', canonicalMnemonic: null }],
  ['ISA-RUNTIME-NONCANONICAL-LUI', { exactMnemonic: 'lui', canonicalMnemonic: null }],
  ['ISA-RUNTIME-NONCANONICAL-CP0', { exactMnemonic: 'mfc0', canonicalMnemonic: null }],
  ['ISA-RUNTIME-RI', { exactMnemonic: null, canonicalMnemonic: null }]
]);

function invariant(condition, message) {
  if (!condition) throw new Error(`ISA golden: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value, allowed, context) {
  invariant(isObject(value), `${context} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  invariant(unknown.length === 0, `${context} has unknown fields: ${unknown.join(', ')}`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function isaGoldenPayload(golden) {
  return {
    schemaRevision: golden.schemaRevision,
    description: golden.description,
    cliProtocolVersion: golden.cliProtocolVersion,
    catalogSha256: golden.catalogSha256,
    cases: golden.cases,
    runtimeCounterexamples: golden.runtimeCounterexamples
  };
}

export function isaGoldenPayloadSha256(golden) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(isaGoldenPayload(golden))), 'utf8')
    .digest('hex');
}

export function validateIsaGolden(golden, options = {}) {
  onlyKeys(golden, [
    'schemaRevision', 'description', 'cliProtocolVersion', 'catalogSha256',
    'review', 'cases', 'runtimeCounterexamples', 'integrity'
  ], 'root');
  invariant(golden.schemaRevision === 1, 'schemaRevision must be 1');
  invariant(golden.cliProtocolVersion === 1, 'cliProtocolVersion must be 1');
  invariant(typeof golden.description === 'string' && golden.description.length > 0, 'description is required');
  invariant(typeof golden.catalogSha256 === 'string' && sha256.test(golden.catalogSha256), 'catalogSha256 is invalid');

  onlyKeys(golden.review, ['status', 'author', 'reviewer', 'reviewedAt', 'reviewRevision'], 'review');
  invariant(golden.review.status === 'candidate', 'review.status must remain candidate; approvals live in governance/approvals');
  invariant(isGithubUsername(golden.review.author), 'review.author must be a GitHub username');
  invariant(golden.review.reviewer === null
    && golden.review.reviewedAt === null
    && golden.review.reviewRevision === 0,
  'candidate review fields must be null/null/0');

  invariant(Array.isArray(golden.cases) && golden.cases.length > 0, 'cases must be non-empty');
  invariant(Array.isArray(golden.runtimeCounterexamples) && golden.runtimeCounterexamples.length > 0, 'runtimeCounterexamples must be non-empty');
  const ids = new Set();
  const mnemonics = new Set();
  for (const [index, item] of golden.cases.entries()) {
    const context = `cases[${index}]`;
    onlyKeys(item, ['id', 'mnemonic', 'operands', 'word', 'profiles'], context);
    invariant(typeof item.id === 'string' && identifier.test(item.id) && !ids.has(item.id), `${context}.id is invalid/duplicated`);
    ids.add(item.id);
    invariant(typeof item.mnemonic === 'string' && item.mnemonic.length > 0 && !mnemonics.has(item.mnemonic), `${context}.mnemonic is invalid/duplicated`);
    mnemonics.add(item.mnemonic);
    onlyKeys(item.operands, operandFields, `${context}.operands`);
    invariant(Object.values(item.operands).every(Number.isSafeInteger), `${context}.operands must be safe integers`);
    invariant(typeof item.word === 'string' && hexWord.test(item.word), `${context}.word is invalid`);
    invariant(Array.isArray(item.profiles)
      && item.profiles.length > 0
      && new Set(item.profiles).size === item.profiles.length
      && item.profiles.every((profile) => profileSet.has(profile)),
    `${context}.profiles is invalid`);
  }

  for (const profile of profiles) {
    const actual = golden.cases.filter((item) => item.profiles.includes(profile)).map((item) => item.mnemonic).sort();
    invariant(JSON.stringify(actual) === JSON.stringify([...requiredByProfile[profile]].sort()),
      `${profile} required mnemonic set is incomplete or contains extras`);
  }

  const counterexampleIds = new Set();
  for (const [index, item] of golden.runtimeCounterexamples.entries()) {
    const context = `runtimeCounterexamples[${index}]`;
    onlyKeys(item, ['id', 'word', 'profile', 'enabledLayers', 'exactMnemonic', 'canonicalMnemonic'], context);
    invariant(typeof item.id === 'string' && identifier.test(item.id) && !ids.has(item.id) && !counterexampleIds.has(item.id), `${context}.id is invalid/duplicated`);
    counterexampleIds.add(item.id);
    invariant(typeof item.word === 'string' && hexWord.test(item.word) && profileSet.has(item.profile), `${context} word/profile is invalid`);
    invariant(Array.isArray(item.enabledLayers)
      && item.enabledLayers.length > 0
      && new Set(item.enabledLayers).size === item.enabledLayers.length
      && item.enabledLayers.every((layer) => layerSet.has(layer)),
    `${context}.enabledLayers is invalid`);
    invariant(item.exactMnemonic === null || typeof item.exactMnemonic === 'string', `${context}.exactMnemonic is invalid`);
    invariant(item.canonicalMnemonic === null || typeof item.canonicalMnemonic === 'string', `${context}.canonicalMnemonic is invalid`);
    const expected = requiredCounterexamples.get(item.id);
    invariant(expected !== undefined
      && item.exactMnemonic === expected.exactMnemonic
      && item.canonicalMnemonic === expected.canonicalMnemonic,
    `${context} is not a frozen required counterexample`);
  }
  invariant(counterexampleIds.size === requiredCounterexamples.size, 'required runtime counterexample set is incomplete');

  if (!options.skipIntegrity) {
    onlyKeys(golden.integrity, ['algorithm', 'payloadSha256'], 'integrity');
    invariant(golden.integrity.algorithm === 'sha256-canonical-json-v1', 'integrity.algorithm is invalid');
    invariant(typeof golden.integrity.payloadSha256 === 'string' && sha256.test(golden.integrity.payloadSha256), 'integrity.payloadSha256 is invalid');
    invariant(golden.integrity.payloadSha256 === isaGoldenPayloadSha256(golden), 'integrity.payloadSha256 is stale');
  }
  if (options.requireApproved) {
    assertCandidateApproved(isaGoldenCandidateDescriptor(golden, options.file ?? isaGoldenFile), options);
  }
  return golden;
}

export function isaGoldenCandidateDescriptor(golden, file = isaGoldenFile) {
  const descriptor = candidateDescriptor({
    artifactKind: 'isaGolden',
    artifactId: path.basename(file, '.json'),
    file,
    candidateAuthor: golden.review.author,
    candidateRevision: golden.schemaRevision
  });
  invariant(descriptor.candidateSha256 === sha256CanonicalJson(golden), 'in-memory ISA golden differs from the candidate file');
  return descriptor;
}

export function loadIsaGolden(options = {}) {
  const golden = JSON.parse(fs.readFileSync(options.file ?? isaGoldenFile, 'utf8'));
  return validateIsaGolden(golden, options);
}
