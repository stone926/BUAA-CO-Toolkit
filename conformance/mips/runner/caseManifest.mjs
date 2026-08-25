/** Strict corpus/golden manifest access for the independent conformance runner. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const runnerRoot = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.resolve(runnerRoot, '..', 'corpus');
const marsGoldenRoot = path.resolve(runnerRoot, '..', 'expected', 'marsGolden');
const caseIdPattern = /^[A-Z0-9][A-Z0-9-]{2,127}$/;
const hex32Pattern = /^0x[0-9a-fA-F]{8}$/;
const normalizedHex32Pattern = /^[0-9A-F]{8}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const profiles = new Set(['P3', 'P4', 'P5', 'P6', 'P7']);
const lanes = new Set(['legacy-baseline', 'course-vector', 'assembly-diff']);
const provenanceKinds = new Set(['spec-microprogram', 'tutorial', 'regression', 'challenge', 'fixed-seed']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`corpus manifest: ${message}`);
  }
}

function assertOnlyKeys(value, allowed, context) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  assert(unexpected.length === 0, `${context} has unknown fields: ${unexpected.join(', ')}`);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateRegisterMap(value, context, valuePattern = hex32Pattern) {
  assert(isPlainObject(value), `${context} must be an object`);
  for (const [register, word] of Object.entries(value)) {
    assert(/^(?:0|[1-9]|[12][0-9]|3[01])$/.test(register), `${context} has invalid GPR ${register}`);
    assert(typeof word === 'string' && valuePattern.test(word), `${context}.${register} must be a 32-bit hex word`);
  }
}

function validateMemoryMap(value, context, valuePattern = hex32Pattern, addressPattern = hex32Pattern) {
  assert(isPlainObject(value), `${context} must be an object`);
  for (const [address, word] of Object.entries(value)) {
    assert(addressPattern.test(address), `${context} has invalid 32-bit address ${address}`);
    const digits = address.replace(/^0x/i, '');
    assert((Number.parseInt(digits, 16) & 3) === 0, `${context} address ${address} must be word aligned`);
    assert(typeof word === 'string' && valuePattern.test(word), `${context}.${address} must be a 32-bit hex word`);
  }
}

function validateWriteSet(writes, expected, context) {
  assert(isPlainObject(writes), `${context}.writes must be an object`);
  assertOnlyKeys(writes, ['gpr', 'dm'], `${context}.writes`);
  assert(Array.isArray(writes.gpr) && Array.isArray(writes.dm), `${context}.writes must contain gpr/dm arrays`);
  assert(new Set(writes.gpr).size === writes.gpr.length, `${context}.writes.gpr contains duplicates`);
  assert(new Set(writes.dm.map((entry) => entry.toUpperCase())).size === writes.dm.length, `${context}.writes.dm contains duplicates`);
  for (const register of writes.gpr) {
    assert(typeof register === 'string' && /^(?:0|[1-9]|[12][0-9]|3[01])$/.test(register), `${context}.writes.gpr has invalid register ${register}`);
    assert(Object.hasOwn(expected.gpr, register), `${context}.writes.gpr ${register} has no final expected value`);
  }
  for (const address of writes.dm) {
    assert(typeof address === 'string' && hex32Pattern.test(address), `${context}.writes.dm has invalid address ${address}`);
    const matchingKey = Object.keys(expected.dm).find((key) => key.toUpperCase() === address.toUpperCase());
    assert(matchingKey !== undefined, `${context}.writes.dm ${address} has no final expected value`);
  }
}

export function validateCorpusManifest(manifest) {
  assert(isPlainObject(manifest) && manifest.schemaRevision === 1, 'schemaRevision must be 1');
  assertOnlyKeys(manifest, ['schemaRevision', 'description', 'cases'], 'root');
  assert(typeof manifest.description === 'string' && manifest.description.length > 0, 'description must be non-empty');
  assert(Array.isArray(manifest.cases) && manifest.cases.length > 0, 'cases must be a non-empty array');
  const seenCaseIds = new Set();
  const seenFiles = new Set();
  for (const [index, manifestCase] of manifest.cases.entries()) {
    const context = `cases[${index}]`;
    assert(isPlainObject(manifestCase), `${context} must be an object`);
    assertOnlyKeys(manifestCase, ['caseId', 'file', 'profile', 'lanes', 'provenance', 'expected'], context);
    assert(typeof manifestCase.caseId === 'string' && caseIdPattern.test(manifestCase.caseId), `${context}.caseId is invalid`);
    assert(!seenCaseIds.has(manifestCase.caseId), `${context}.caseId is duplicated`);
    seenCaseIds.add(manifestCase.caseId);
    assert(
      typeof manifestCase.file === 'string' &&
        manifestCase.file.length > 0 &&
        !manifestCase.file.includes('\\') &&
        manifestCase.file.endsWith('.asm') &&
        !path.posix.isAbsolute(manifestCase.file) &&
        path.posix.normalize(manifestCase.file) === manifestCase.file &&
        !manifestCase.file.split('/').includes('..'),
      `${context}.file must be a normalized corpus-relative POSIX path`
    );
    assert(!seenFiles.has(manifestCase.file), `${context}.file is duplicated`);
    seenFiles.add(manifestCase.file);
    assert(profiles.has(manifestCase.profile), `${context}.profile is invalid`);
    assert(Array.isArray(manifestCase.lanes) && manifestCase.lanes.length > 0, `${context}.lanes must be non-empty`);
    assert(new Set(manifestCase.lanes).size === manifestCase.lanes.length, `${context}.lanes contains duplicates`);
    for (const lane of manifestCase.lanes) {
      assert(lanes.has(lane), `${context}.lanes contains unknown lane ${lane}`);
    }
    assert(isPlainObject(manifestCase.provenance), `${context}.provenance must be an object`);
    assertOnlyKeys(manifestCase.provenance, ['kind', 'reviewer', 'reviewedAt', 'note'], `${context}.provenance`);
    for (const field of ['kind', 'reviewer', 'reviewedAt', 'note']) {
      assert(typeof manifestCase.provenance[field] === 'string' && manifestCase.provenance[field].length > 0, `${context}.provenance.${field} is required`);
    }
    assert(provenanceKinds.has(manifestCase.provenance.kind), `${context}.provenance.kind is invalid`);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(manifestCase.provenance.reviewedAt), `${context}.provenance.reviewedAt must be YYYY-MM-DD`);
    const reviewedDate = new Date(`${manifestCase.provenance.reviewedAt}T00:00:00Z`);
    assert(
      !Number.isNaN(reviewedDate.valueOf())
        && reviewedDate.toISOString().slice(0, 10) === manifestCase.provenance.reviewedAt,
      `${context}.provenance.reviewedAt is not a real calendar date`
    );
    assert(isPlainObject(manifestCase.expected), `${context}.expected must be an object`);
    assertOnlyKeys(manifestCase.expected, ['haltPc', 'haltWord', 'gpr', 'dm', 'writes'], `${context}.expected`);
    assert(hex32Pattern.test(manifestCase.expected.haltPc), `${context}.expected.haltPc must be a 32-bit hex address`);
    assert(hex32Pattern.test(manifestCase.expected.haltWord), `${context}.expected.haltWord must be a 32-bit hex word`);
    validateRegisterMap(manifestCase.expected.gpr, `${context}.expected.gpr`);
    validateMemoryMap(manifestCase.expected.dm, `${context}.expected.dm`);
    validateWriteSet(manifestCase.expected.writes, manifestCase.expected, `${context}.expected`);
  }
  return manifest;
}

export function loadCorpusManifest() {
  const manifest = validateCorpusManifest(JSON.parse(fs.readFileSync(path.join(corpusRoot, 'manifest.json'), 'utf8')));
  // Validate every declared source up front, even when a lane/filter would not
  // select it in this invocation. A broken corpus can never be partially green.
  for (const manifestCase of manifest.cases) {
    corpusCaseFile(manifestCase);
  }
  return manifest;
}

export function corpusCaseFile(manifestCase) {
  const candidate = path.resolve(corpusRoot, manifestCase.file);
  assert(isWithin(corpusRoot, candidate), `case ${manifestCase.caseId} escapes corpus root`);
  const rootReal = fs.realpathSync(corpusRoot);
  const fileReal = fs.realpathSync(candidate);
  assert(isWithin(rootReal, fileReal), `case ${manifestCase.caseId} resolves outside corpus root`);
  assert(fs.statSync(fileReal).isFile(), `case ${manifestCase.caseId} is not a regular file`);
  return fileReal;
}

export function corpusCaseSha256(manifestCase) {
  // Git may materialize LF or CRLF depending on checkout platform. Assembly
  // semantics are line-ending invariant, so provenance hashes canonical UTF-8
  // text with LF while preserving every other byte-level character.
  const canonicalText = fs.readFileSync(corpusCaseFile(manifestCase), 'utf8').replace(/\r\n?/g, '\n');
  return crypto.createHash('sha256').update(canonicalText, 'utf8').digest('hex');
}

export function marsGoldenFile(caseId) {
  if (!caseIdPattern.test(caseId)) {
    throw new Error(`invalid golden case id: ${caseId}`);
  }
  return path.join(marsGoldenRoot, `${caseId}.json`);
}

function validateGolden(golden, expectedCaseId) {
  assert(isPlainObject(golden) && golden.schemaRevision === 1, `golden ${expectedCaseId} schemaRevision must be 1`);
  assertOnlyKeys(golden, ['schemaRevision', 'caseId', 'provenance', 'normalized', 'writes'], `golden ${expectedCaseId}`);
  assert(golden.caseId === expectedCaseId, `golden ${expectedCaseId} has mismatched caseId`);
  assert(isPlainObject(golden.provenance), `golden ${expectedCaseId} provenance is required`);
  const provenance = golden.provenance;
  assertOnlyKeys(provenance, [
    'role', 'referenceFileName', 'referenceSha256', 'sourceFile', 'sourceSha256',
    'sourceHashNormalization', 'sourceTag', 'sourceCommit', 'runnerRevision',
    'normalizerRevision', 'profile', 'maxSteps', 'cliOptions', 'corpusReviewer',
    'corpusReviewedAt'
  ], `golden ${expectedCaseId}.provenance`);
  for (const field of ['role', 'referenceFileName', 'sourceFile', 'sourceHashNormalization', 'sourceTag', 'sourceCommit', 'profile', 'corpusReviewer', 'corpusReviewedAt']) {
    assert(typeof provenance[field] === 'string' && provenance[field].length > 0, `golden ${expectedCaseId} provenance.${field} is required`);
  }
  assert(sha256Pattern.test(provenance.referenceSha256), `golden ${expectedCaseId} referenceSha256 is invalid`);
  assert(sha256Pattern.test(provenance.sourceSha256), `golden ${expectedCaseId} sourceSha256 is invalid`);
  assert(Number.isSafeInteger(provenance.runnerRevision) && provenance.runnerRevision > 0, `golden ${expectedCaseId} runnerRevision is invalid`);
  assert(Number.isSafeInteger(provenance.normalizerRevision) && provenance.normalizerRevision > 0, `golden ${expectedCaseId} normalizerRevision is invalid`);
  assert(Number.isSafeInteger(provenance.maxSteps) && provenance.maxSteps > 0, `golden ${expectedCaseId} maxSteps is invalid`);
  assert(Array.isArray(provenance.cliOptions) && provenance.cliOptions.every((entry) => typeof entry === 'string'), `golden ${expectedCaseId} cliOptions is invalid`);
  assert(isPlainObject(golden.normalized), `golden ${expectedCaseId} normalized state is required`);
  assertOnlyKeys(golden.normalized, ['gpr', 'dm'], `golden ${expectedCaseId}.normalized`);
  validateRegisterMap(golden.normalized.gpr, `golden ${expectedCaseId}.normalized.gpr`, normalizedHex32Pattern);
  validateMemoryMap(
    golden.normalized.dm,
    `golden ${expectedCaseId}.normalized.dm`,
    normalizedHex32Pattern,
    normalizedHex32Pattern
  );
  assert(isPlainObject(golden.writes), `golden ${expectedCaseId}.writes is required`);
  assertOnlyKeys(golden.writes, ['gpr', 'dm'], `golden ${expectedCaseId}.writes`);
  assert(Array.isArray(golden.writes.gpr) && golden.writes.gpr.every((entry) => /^(?:0|[1-9]|[12][0-9]|3[01])$/.test(entry)), `golden ${expectedCaseId}.writes.gpr is invalid`);
  assert(Array.isArray(golden.writes.dm) && golden.writes.dm.every((entry) => normalizedHex32Pattern.test(entry)), `golden ${expectedCaseId}.writes.dm is invalid`);
  assert(new Set(golden.writes.gpr).size === golden.writes.gpr.length, `golden ${expectedCaseId}.writes.gpr contains duplicates`);
  assert(new Set(golden.writes.dm).size === golden.writes.dm.length, `golden ${expectedCaseId}.writes.dm contains duplicates`);
  return golden;
}

export function loadMarsGolden(caseId) {
  const file = marsGoldenFile(caseId);
  if (!fs.existsSync(file)) {
    return undefined;
  }
  return validateGolden(JSON.parse(fs.readFileSync(file, 'utf8')), caseId);
}

export function recordMarsGolden(caseId, golden) {
  const file = marsGoldenFile(caseId);
  validateGolden(golden, caseId);
  fs.writeFileSync(file, `${JSON.stringify(golden, null, 2)}\n`, 'utf8');
  return file;
}
