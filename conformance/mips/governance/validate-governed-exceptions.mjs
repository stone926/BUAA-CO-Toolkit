#!/usr/bin/env node
/** Fail-closed validation for declarative difference rules and one-case waivers. */
import * as crypto from 'node:crypto';
import * as fs from '../expected/guardedFs.mjs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  approvalEnvelopeFile,
  assertCandidateApproved,
  candidateDescriptor,
  phase0ApprovalRoot,
  validateApprovalEnvelope
} from './approvalEnvelope.mjs';
import { isGithubUsername } from './reviewerPolicy.mjs';

const governanceRoot = path.dirname(fileURLToPath(import.meta.url));
const conformanceRoot = path.resolve(governanceRoot, '..');
const ruleRoot = path.join(governanceRoot, 'contract-difference-rules');
const waiverRoot = path.join(governanceRoot, 'waivers');
const contractFile = path.join(conformanceRoot, 'contract', 'contracts.json');
const sha256Pattern = /^[0-9a-f]{64}$/;
const ruleIdPattern = /^COURSE-[A-Z0-9-]{3,120}$/;
const waiverIdPattern = /^WAIVER-[A-Z0-9-]{3,120}$/;
const scopeTokenPattern = /^[a-z][a-zA-Z0-9.[\]-]{1,127}$/;
const capabilityPattern = /^[a-z0-9][a-z0-9.-]{1,63}$/;
const profiles = new Set(['P3', 'P4', 'P5', 'P6', 'P7']);
const predicateFields = new Set(['profile', 'mnemonic', 'sourceSha256', 'imageSha256', 'imageWordCount', 'pc', 'address', 'eventKind', 'eventIndex']);
const discriminatingFields = new Set(['mnemonic', 'sourceSha256', 'imageSha256', 'imageWordCount', 'pc', 'address', 'eventIndex']);
const transformKinds = new Set(['reject-legacy-result', 'replace-exact-field', 'merge-exact-events', 'classify-format-only', 'select-course-vector']);

function invariant(condition, message) {
  if (!condition) throw new Error(`governed exceptions: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value, allowed, context) {
  invariant(isObject(value), `${context} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  invariant(unknown.length === 0, `${context} has unknown fields: ${unknown.join(', ')}`);
}

function nonEmptyString(value, context) {
  invariant(typeof value === 'string' && value.trim().length > 0, `${context} must be a non-empty string`);
}

function exactStrings(value, context, pattern = scopeTokenPattern, { minimum = 1, maximum = 32 } = {}) {
  invariant(Array.isArray(value) && value.length >= minimum && value.length <= maximum, `${context} must contain ${minimum}..${maximum} entries`);
  invariant(new Set(value).size === value.length, `${context} contains duplicates`);
  for (const entry of value) {
    invariant(typeof entry === 'string' && pattern.test(entry), `${context} contains invalid entry ${JSON.stringify(entry)}`);
    invariant(!entry.includes('*') && !entry.includes('?'), `${context} cannot contain wildcards`);
  }
}

function validateCandidate(value, context) {
  onlyKeys(value, ['author', 'revision'], context);
  invariant(isGithubUsername(value.author), `${context}.author must be a GitHub username`);
  invariant(Number.isSafeInteger(value.revision) && value.revision > 0, `${context}.revision must be a positive integer`);
}

function validateScope(value, context) {
  onlyKeys(value, ['events', 'fields'], context);
  exactStrings(value.events, `${context}.events`, /^[a-z][a-z0-9.-]{1,63}$/, { maximum: 16 });
  exactStrings(value.fields, `${context}.fields`, scopeTokenPattern, { maximum: 32 });
}

function contractIds() {
  const ledger = JSON.parse(fs.readFileSync(contractFile, 'utf8'));
  invariant(Array.isArray(ledger.entries), 'contract ledger entries are missing');
  return new Set(ledger.entries.map((entry) => entry.id));
}

function validateReferences(value, context, knownContractIds) {
  invariant(Array.isArray(value) && value.length > 0, `${context} must be non-empty`);
  for (const [index, reference] of value.entries()) {
    const at = `${context}[${index}]`;
    onlyKeys(reference, ['contractId', 'source', 'lines', 'quote'], at);
    invariant(knownContractIds.has(reference.contractId), `${at}.contractId is unknown: ${reference.contractId}`);
    nonEmptyString(reference.source, `${at}.source`);
    nonEmptyString(reference.quote, `${at}.quote`);
    if (reference.lines !== undefined) {
      invariant(Array.isArray(reference.lines) && [1, 2].includes(reference.lines.length), `${at}.lines must contain one or two lines`);
      invariant(reference.lines.every((line) => Number.isSafeInteger(line) && line > 0), `${at}.lines must be positive integers`);
      invariant(reference.lines.length === 1 || reference.lines[0] <= reference.lines[1], `${at}.lines is reversed`);
    }
  }
}

function assertScalar(value, context) {
  invariant(['string', 'number', 'boolean'].includes(typeof value), `${context} must be a scalar`);
  if (typeof value === 'number') invariant(Number.isSafeInteger(value), `${context} number must be a safe integer`);
  if (typeof value === 'string') invariant(value.length > 0 && !value.includes('*') && !value.includes('?'), `${context} string cannot be empty or wildcarded`);
}

function validatePredicate(value, context) {
  onlyKeys(value, ['all'], context);
  invariant(Array.isArray(value.all) && value.all.length >= 1 && value.all.length <= 16, `${context}.all must contain 1..16 clauses`);
  invariant(value.all.some((clause) => discriminatingFields.has(clause?.field)), `${context} needs a narrow discriminating field, not only profile/event class`);
  for (const [index, clause] of value.all.entries()) {
    const at = `${context}.all[${index}]`;
    onlyKeys(clause, ['field', 'operator', 'value'], at);
    invariant(predicateFields.has(clause.field), `${at}.field is not allowlisted`);
    invariant(['equals', 'oneOf', 'betweenInclusive'].includes(clause.operator), `${at}.operator is invalid`);
    if (clause.operator === 'equals') {
      assertScalar(clause.value, `${at}.value`);
    } else {
      invariant(Array.isArray(clause.value), `${at}.value must be an array for ${clause.operator}`);
      const expectedLength = clause.operator === 'betweenInclusive' ? 2 : undefined;
      invariant(clause.value.length >= 1 && clause.value.length <= 32 && (expectedLength === undefined || clause.value.length === expectedLength), `${at}.value has invalid cardinality`);
      invariant(new Set(clause.value.map((entry) => JSON.stringify(entry))).size === clause.value.length, `${at}.value contains duplicates`);
      clause.value.forEach((entry, valueIndex) => assertScalar(entry, `${at}.value[${valueIndex}]`));
      if (clause.operator === 'betweenInclusive') {
        invariant(clause.value.every(Number.isSafeInteger) && clause.value[0] <= clause.value[1], `${at}.betweenInclusive must be an ordered integer pair`);
      }
    }
    const values = Array.isArray(clause.value) ? clause.value : [clause.value];
    if (clause.field === 'profile') invariant(values.every((entry) => profiles.has(entry)), `${at}.value contains an invalid profile`);
    if (['sourceSha256', 'imageSha256'].includes(clause.field)) invariant(values.every((entry) => typeof entry === 'string' && sha256Pattern.test(entry)), `${at}.value must contain SHA-256 values`);
  }
}

function jsonCandidateFiles(root, pattern) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

export function validateContractDifferenceRule(rule, file, options = {}) {
  const context = path.basename(file);
  onlyKeys(rule, [
    'schemaRevision', 'kind', 'id', 'candidate', 'domain', 'capabilityScope',
    'inputPredicate', 'eventAndFieldScope', 'marsBehavior', 'courseBehavior',
    'expectedRelationOrTransform', 'normativeReference', 'directedTests',
    'criticalMutants', 'revision'
  ], context);
  invariant(rule.schemaRevision === 1 && rule.kind === 'contractDifferenceRule', `${context} schemaRevision/kind is invalid`);
  invariant(ruleIdPattern.test(rule.id) && path.basename(file) === `${rule.id}.json`, `${context}.id/file name is invalid`);
  validateCandidate(rule.candidate, `${context}.candidate`);
  invariant(['assembler', 'execution', 'device'].includes(rule.domain), `${context}.domain is invalid`);
  onlyKeys(rule.capabilityScope, ['profiles', 'capabilities'], `${context}.capabilityScope`);
  invariant(Array.isArray(rule.capabilityScope.profiles) && rule.capabilityScope.profiles.length > 0 && new Set(rule.capabilityScope.profiles).size === rule.capabilityScope.profiles.length, `${context}.capabilityScope.profiles is invalid`);
  invariant(rule.capabilityScope.profiles.every((profile) => profiles.has(profile)), `${context}.capabilityScope.profiles contains an invalid profile`);
  exactStrings(rule.capabilityScope.capabilities, `${context}.capabilityScope.capabilities`, capabilityPattern);
  validatePredicate(rule.inputPredicate, `${context}.inputPredicate`);
  validateScope(rule.eventAndFieldScope, `${context}.eventAndFieldScope`);
  nonEmptyString(rule.marsBehavior, `${context}.marsBehavior`);
  nonEmptyString(rule.courseBehavior, `${context}.courseBehavior`);
  onlyKeys(rule.expectedRelationOrTransform, ['kind', 'description', 'fromValue', 'toValue'], `${context}.expectedRelationOrTransform`);
  invariant(transformKinds.has(rule.expectedRelationOrTransform.kind), `${context}.expectedRelationOrTransform.kind is invalid`);
  nonEmptyString(rule.expectedRelationOrTransform.description, `${context}.expectedRelationOrTransform.description`);
  for (const field of ['fromValue', 'toValue']) {
    if (Object.hasOwn(rule.expectedRelationOrTransform, field) && rule.expectedRelationOrTransform[field] !== null) assertScalar(rule.expectedRelationOrTransform[field], `${context}.expectedRelationOrTransform.${field}`);
  }
  const knownContractIds = options.knownContractIds ?? contractIds();
  validateReferences(rule.normativeReference, `${context}.normativeReference`, knownContractIds);
  exactStrings(rule.directedTests, `${context}.directedTests`, /^[A-Z0-9][A-Z0-9._:-]{2,127}$/);
  exactStrings(rule.criticalMutants, `${context}.criticalMutants`, /^[A-Z0-9][A-Z0-9._:-]{2,127}$/);
  invariant(Number.isSafeInteger(rule.revision) && rule.revision > 0, `${context}.revision is invalid`);
  invariant(rule.candidate.revision === rule.revision, `${context}.candidate.revision must equal rule revision`);
  const subject = candidateDescriptor({ artifactKind: 'contractDifferenceRule', artifactId: rule.id, file, candidateAuthor: rule.candidate.author, candidateRevision: rule.candidate.revision });
  if (options.requireApproved) assertCandidateApproved(subject, options);
  return { rule, subject };
}

function validDate(value, context) {
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(value), `${context} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  invariant(!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value, `${context} is not a real date`);
  return value;
}

function canonicalTextSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
}

export function validateWaiver(waiver, file, options = {}) {
  const context = path.basename(file);
  onlyKeys(waiver, [
    'schemaRevision', 'kind', 'id', 'candidate', 'category', 'caseFingerprint',
    'engineFingerprint', 'contractRevision', 'normalizerRevision', 'rawOracleHash',
    'expectedCanonicalHash', 'actualCanonicalHash', 'mismatchSha256',
    'eventAndFieldScope', 'minimalRepro', 'marsBehavior', 'expectedTsBehavior',
    'normativeReference', 'owner', 'created', 'expiresAt', 'lastMatchedEvidence'
  ], context);
  invariant(waiver.schemaRevision === 1 && waiver.kind === 'waiver', `${context} schemaRevision/kind is invalid`);
  invariant(waiverIdPattern.test(waiver.id) && path.basename(file) === `${waiver.id}.json`, `${context}.id/file name is invalid`);
  validateCandidate(waiver.candidate, `${context}.candidate`);
  invariant(['mars-bug', 'course-correct', 'format-only'].includes(waiver.category), `${context}.category is invalid`);
  for (const field of ['caseFingerprint', 'engineFingerprint', 'rawOracleHash', 'expectedCanonicalHash', 'actualCanonicalHash', 'mismatchSha256']) {
    invariant(typeof waiver[field] === 'string' && sha256Pattern.test(waiver[field]), `${context}.${field} must be SHA-256`);
  }
  invariant(waiver.expectedCanonicalHash !== waiver.actualCanonicalHash, `${context} does not describe a mismatch`);
  invariant(Number.isSafeInteger(waiver.contractRevision) && waiver.contractRevision > 0, `${context}.contractRevision is invalid`);
  invariant(Number.isSafeInteger(waiver.normalizerRevision) && waiver.normalizerRevision > 0, `${context}.normalizerRevision is invalid`);
  validateScope(waiver.eventAndFieldScope, `${context}.eventAndFieldScope`);
  onlyKeys(waiver.minimalRepro, ['file', 'sha256'], `${context}.minimalRepro`);
  invariant(typeof waiver.minimalRepro.file === 'string' && /^(?:corpus|governance)\/[A-Za-z0-9._/-]+$/.test(waiver.minimalRepro.file) && !waiver.minimalRepro.file.includes('..'), `${context}.minimalRepro.file is invalid`);
  invariant(sha256Pattern.test(waiver.minimalRepro.sha256), `${context}.minimalRepro.sha256 is invalid`);
  const reproFile = path.resolve(conformanceRoot, ...waiver.minimalRepro.file.split('/'));
  invariant(fs.existsSync(reproFile) && fs.statSync(reproFile).isFile(), `${context}.minimalRepro.file is missing or not a file`);
  invariant(canonicalTextSha256(reproFile) === waiver.minimalRepro.sha256, `${context}.minimalRepro.sha256 is stale`);
  nonEmptyString(waiver.marsBehavior, `${context}.marsBehavior`);
  nonEmptyString(waiver.expectedTsBehavior, `${context}.expectedTsBehavior`);
  validateReferences(waiver.normativeReference, `${context}.normativeReference`, options.knownContractIds ?? contractIds());
  invariant(isGithubUsername(waiver.owner), `${context}.owner must be a GitHub username`);
  validDate(waiver.created, `${context}.created`);
  validDate(waiver.expiresAt, `${context}.expiresAt`);
  const today = new Date().toISOString().slice(0, 10);
  invariant(waiver.created <= today, `${context}.created cannot be in the future`);
  invariant(waiver.expiresAt > today, `${context} is expired or expires today`);
  invariant(waiver.created < waiver.expiresAt, `${context}.expiresAt must be after created`);
  onlyKeys(waiver.lastMatchedEvidence, ['caseFingerprint', 'mismatchSha256', 'matchedAt'], `${context}.lastMatchedEvidence`);
  invariant(waiver.lastMatchedEvidence.caseFingerprint === waiver.caseFingerprint, `${context}.lastMatchedEvidence.caseFingerprint is stale`);
  invariant(waiver.lastMatchedEvidence.mismatchSha256 === waiver.mismatchSha256, `${context}.lastMatchedEvidence.mismatchSha256 is stale`);
  validDate(waiver.lastMatchedEvidence.matchedAt, `${context}.lastMatchedEvidence.matchedAt`);
  invariant(waiver.lastMatchedEvidence.matchedAt >= waiver.created && waiver.lastMatchedEvidence.matchedAt <= today, `${context}.lastMatchedEvidence.matchedAt is outside the valid evidence window`);
  const subject = candidateDescriptor({ artifactKind: 'waiver', artifactId: waiver.id, file, candidateAuthor: waiver.candidate.author, candidateRevision: waiver.candidate.revision });
  if (options.requireApproved) assertCandidateApproved(subject, options);
  return { waiver, subject };
}

function verifyApprovalTree() {
  if (!fs.existsSync(phase0ApprovalRoot)) return 0;
  let count = 0;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.approval.json')) {
        const envelope = validateApprovalEnvelope(JSON.parse(fs.readFileSync(file, 'utf8')));
        invariant(path.resolve(file) === path.resolve(approvalEnvelopeFile(envelope.subject)), `approval file path does not match its subject: ${file}`);
        count += 1;
      }
    }
  };
  visit(phase0ApprovalRoot);
  return count;
}

export function validateGovernedExceptions(options = {}) {
  const knownContractIds = contractIds();
  const rules = jsonCandidateFiles(ruleRoot, /^COURSE-[A-Z0-9-]+\.json$/)
    .map((file) => validateContractDifferenceRule(JSON.parse(fs.readFileSync(file, 'utf8')), file, { ...options, knownContractIds }));
  const waivers = jsonCandidateFiles(waiverRoot, /^WAIVER-[A-Z0-9-]+\.json$/)
    .map((file) => validateWaiver(JSON.parse(fs.readFileSync(file, 'utf8')), file, { ...options, knownContractIds }));
  return { rules, waivers, approvalEnvelopes: verifyApprovalTree() };
}

function main() {
  const argv = process.argv.slice(2);
  invariant(argv.every((arg) => arg === '--require-approved') && new Set(argv).size === argv.length, `unknown arguments: ${argv.filter((arg) => arg !== '--require-approved').join(', ')}`);
  const result = validateGovernedExceptions({ requireApproved: argv.includes('--require-approved') });
  process.stdout.write(`governed exceptions OK: ${result.rules.length} contractDifferenceRule candidates, ${result.waivers.length} waiver candidates, ${result.approvalEnvelopes} immutable approval envelopes; approval=${argv.includes('--require-approved') ? 'required' : 'candidate-allowed'}\n`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invoked === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
