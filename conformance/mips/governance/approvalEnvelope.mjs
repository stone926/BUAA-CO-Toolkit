/**
 * Unified phase-0 approval envelope.
 *
 * Candidate payloads and approvals intentionally live in different roots.
 * An approval is append-only and names the candidate's canonical JSON digest;
 * changing one semantic JSON value therefore makes the previous approval
 * undiscoverable without ever mutating the old evidence.
 */
import * as crypto from 'node:crypto';
import * as fs from '../expected/guardedFs.mjs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertIndependentPolicyReviewer,
  isGithubUsername
} from './reviewerPolicy.mjs';

const governanceRoot = path.dirname(fileURLToPath(import.meta.url));
export const conformanceRoot = path.resolve(governanceRoot, '..');
export const phase0ApprovalRoot = path.join(governanceRoot, 'approvals');

const sha256Pattern = /^[0-9a-f]{64}$/;
const artifactIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const allowedArtifactKinds = new Set([
  'corpus',
  'courseVector',
  'marsGolden',
  'isaGolden',
  'contractDifferenceRule',
  'waiver'
]);

function invariant(condition, message) {
  if (!condition) throw new Error(`phase-0 approval: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value, allowed, context) {
  invariant(isPlainObject(value), `${context} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  invariant(unknown.length === 0, `${context} has unknown fields: ${unknown.join(', ')}`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256CanonicalJson(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalCandidatePath(file, root = conformanceRoot) {
  const absoluteRoot = path.resolve(root);
  const absoluteFile = path.resolve(file);
  const relative = path.relative(absoluteRoot, absoluteFile);
  invariant(relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'candidate path escapes conformance root');
  invariant(!relative.includes(path.sep + '..' + path.sep), 'candidate path is not normalized');
  const portable = relative.split(path.sep).join('/');
  invariant(portable.endsWith('.json'), 'candidate path must name a JSON file');
  return portable;
}

function assertKindPath(kind, candidatePath) {
  const patterns = {
    corpus: /^corpus\/manifest\.json$/,
    courseVector: /^expected\/courseVector\/[A-Z0-9][A-Z0-9-]{2,127}\.json$/,
    marsGolden: /^expected\/marsGolden\/[A-Z0-9][A-Z0-9-]{2,127}\.json$/,
    isaGolden: /^expected\/isaGolden\/[a-z0-9][a-z0-9-]{2,127}\.json$/,
    contractDifferenceRule: /^governance\/contract-difference-rules\/[A-Z0-9][A-Z0-9-]{2,127}\.json$/,
    waiver: /^governance\/waivers\/[A-Z0-9][A-Z0-9-]{2,127}\.json$/
  };
  invariant(patterns[kind]?.test(candidatePath), `${kind} candidate path is outside its isolated candidate root: ${candidatePath}`);
}

export function candidateDescriptor({ artifactKind, artifactId, file, candidateAuthor, candidateRevision, root = conformanceRoot }) {
  invariant(allowedArtifactKinds.has(artifactKind), `unsupported artifactKind ${artifactKind}`);
  invariant(typeof artifactId === 'string' && artifactIdPattern.test(artifactId), 'artifactId is invalid');
  invariant(isGithubUsername(candidateAuthor), 'candidateAuthor must be a GitHub username');
  invariant(Number.isSafeInteger(candidateRevision) && candidateRevision > 0, 'candidateRevision must be a positive integer');
  const candidatePath = canonicalCandidatePath(file, root);
  assertKindPath(artifactKind, candidatePath);
  const absoluteFile = path.resolve(root, ...candidatePath.split('/'));
  invariant(fs.existsSync(absoluteFile), `candidate is missing: ${candidatePath}`);
  const stat = fs.statSync(absoluteFile);
  invariant(stat.isFile(), `candidate is not a regular file: ${candidatePath}`);
  invariant(stat.size > 0 && stat.size <= 16 * 1024 * 1024, `candidate size is outside 1..16777216 bytes: ${candidatePath}`);
  const parsed = JSON.parse(fs.readFileSync(absoluteFile, 'utf8'));
  return Object.freeze({
    artifactKind,
    artifactId,
    candidatePath,
    candidateSha256: sha256CanonicalJson(parsed),
    candidateAuthor,
    candidateRevision
  });
}

export function approvalEnvelopePayload(envelope) {
  return {
    schemaRevision: envelope.schemaRevision,
    kind: envelope.kind,
    subject: envelope.subject,
    review: envelope.review
  };
}

export function approvalEnvelopeSha256(envelope) {
  return sha256CanonicalJson(approvalEnvelopePayload(envelope));
}

function assertIsoDate(value, context) {
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(value), `${context} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  invariant(!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value, `${context} is not a real calendar date`);
  invariant(value <= new Date().toISOString().slice(0, 10), `${context} cannot be in the future`);
}

export function validateApprovalEnvelope(envelope, expectedSubject) {
  onlyKeys(envelope, ['schemaRevision', 'kind', 'subject', 'review', 'integrity'], 'envelope');
  invariant(envelope.schemaRevision === 1, 'schemaRevision must be 1');
  invariant(envelope.kind === 'phase0-artifact-approval', 'kind is invalid');
  onlyKeys(envelope.subject, [
    'artifactKind', 'artifactId', 'candidatePath', 'candidateSha256',
    'candidateAuthor', 'candidateRevision'
  ], 'subject');
  invariant(allowedArtifactKinds.has(envelope.subject.artifactKind), 'subject.artifactKind is invalid');
  invariant(artifactIdPattern.test(envelope.subject.artifactId), 'subject.artifactId is invalid');
  assertKindPath(envelope.subject.artifactKind, envelope.subject.candidatePath);
  invariant(sha256Pattern.test(envelope.subject.candidateSha256), 'subject.candidateSha256 is invalid');
  invariant(isGithubUsername(envelope.subject.candidateAuthor), 'subject.candidateAuthor must be a GitHub username');
  invariant(Number.isSafeInteger(envelope.subject.candidateRevision) && envelope.subject.candidateRevision > 0, 'subject.candidateRevision is invalid');
  if (expectedSubject) {
    invariant(canonicalJson(envelope.subject) === canonicalJson(expectedSubject), 'approval does not bind the current candidate descriptor');
  }

  onlyKeys(envelope.review, ['status', 'reviewer', 'reviewedAt', 'reviewRevision'], 'review');
  invariant(envelope.review.status === 'approved', 'review.status must be approved');
  try {
    assertIndependentPolicyReviewer(envelope.review.reviewer, envelope.subject.candidateAuthor, 'review.reviewer');
  } catch (error) {
    invariant(false, error instanceof Error ? error.message : String(error));
  }
  assertIsoDate(envelope.review.reviewedAt, 'review.reviewedAt');
  invariant(Number.isSafeInteger(envelope.review.reviewRevision) && envelope.review.reviewRevision > 0, 'review.reviewRevision is invalid');

  onlyKeys(envelope.integrity, ['algorithm', 'envelopeSha256'], 'integrity');
  invariant(envelope.integrity.algorithm === 'sha256-canonical-json-v1', 'integrity.algorithm is invalid');
  invariant(sha256Pattern.test(envelope.integrity.envelopeSha256), 'integrity.envelopeSha256 is invalid');
  invariant(envelope.integrity.envelopeSha256 === approvalEnvelopeSha256(envelope), 'integrity.envelopeSha256 is stale');
  return envelope;
}

export function approvalEnvelopeFile(subject, approvalRoot = phase0ApprovalRoot) {
  return path.join(
    approvalRoot,
    subject.artifactKind,
    subject.artifactId,
    `${subject.candidateSha256}.approval.json`
  );
}

function writeJsonExclusiveAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function createApprovalEnvelope(subject, { reviewer, reviewRevision, reviewedAt = new Date().toISOString().slice(0, 10), approvalRoot = phase0ApprovalRoot }) {
  try {
    assertIndependentPolicyReviewer(reviewer, subject.candidateAuthor, 'reviewer');
  } catch (error) {
    invariant(false, error instanceof Error ? error.message : String(error));
  }
  const envelope = {
    schemaRevision: 1,
    kind: 'phase0-artifact-approval',
    subject: { ...subject },
    review: { status: 'approved', reviewer, reviewedAt, reviewRevision },
    integrity: { algorithm: 'sha256-canonical-json-v1', envelopeSha256: '' }
  };
  envelope.integrity.envelopeSha256 = approvalEnvelopeSha256(envelope);
  validateApprovalEnvelope(envelope, subject);
  const file = approvalEnvelopeFile(subject, approvalRoot);
  invariant(!fs.existsSync(file), `approval already exists and is immutable: ${file}`);
  writeJsonExclusiveAtomic(file, envelope);
  return { envelope, file };
}

export function assertCandidateApproved(subject, options = {}) {
  const file = approvalEnvelopeFile(subject, options.approvalRoot);
  invariant(fs.existsSync(file), `${subject.artifactKind}/${subject.artifactId} candidate ${subject.candidateSha256} is not approved`);
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateApprovalEnvelope(envelope, subject);
  return { envelope, file };
}

export const phase0ArtifactKinds = Object.freeze([...allowedArtifactKinds]);
