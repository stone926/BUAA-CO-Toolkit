#!/usr/bin/env node
/** The sole writer/validator for independent courseVector artifacts. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  canonicalSourceText,
  courseVectorPaths,
  listCourseVectorJsonFiles,
  loadCourseVector,
  loadTutorialSourceRegistry,
  sha256Text,
  sourceSha256,
  vectorPayloadSha256
} from '../../runner/courseVectorArtifact.mjs';
import { loadCorpusManifest } from '../../runner/caseManifest.mjs';
import { assertPolicyReviewer } from '../../governance/reviewerPolicy.mjs';

const contractLedgerFile = path.join(courseVectorPaths.conformanceRoot, 'contract', 'contracts.json');

function usageError(message) {
  throw new Error(`${message}\nUsage: manage-course-vectors.mjs --verify [--require-approved] | --review | --refresh-integrity | --approve --reviewer <id> --review-revision <n>`);
}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.some((entry) => typeof entry !== 'string')) usageError('arguments must be strings');
  const options = { action: undefined, requireApproved: false, reviewer: undefined, reviewRevision: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (['--verify', '--review', '--refresh-integrity', '--approve'].includes(arg)) {
      if (options.action) usageError('select exactly one action');
      options.action = arg.slice(2);
    } else if (arg === '--require-approved') {
      options.requireApproved = true;
    } else if (arg === '--reviewer') {
      options.reviewer = argv[++index];
      if (!options.reviewer || options.reviewer.startsWith('--')) usageError('--reviewer requires a value');
    } else if (arg === '--review-revision') {
      const raw = argv[++index];
      options.reviewRevision = Number(raw);
      if (!Number.isSafeInteger(options.reviewRevision) || options.reviewRevision <= 0) usageError('--review-revision requires a positive integer');
    } else {
      usageError(`unknown argument: ${arg}`);
    }
  }
  if (!options.action) usageError('an action is required');
  if (['verify', 'review'].includes(options.action) && (options.requireApproved || options.reviewer || options.reviewRevision)) {
    if (!(options.action === 'verify' && options.requireApproved && !options.reviewer && !options.reviewRevision)) usageError('review fields are only valid with --approve');
  }
  if (options.action === 'refresh-integrity' && (options.requireApproved || options.reviewer || options.reviewRevision)) usageError('--refresh-integrity accepts no other options');
  if (options.action === 'approve' && (!options.reviewer || !options.reviewRevision || options.requireApproved)) usageError('--approve requires reviewer and review revision');
  if (options.reviewer) {
    try {
      assertPolicyReviewer(options.reviewer, '--reviewer');
    } catch (error) {
      usageError(error instanceof Error ? error.message : String(error));
    }
  }
  return options;
}

function refreshTutorialRegistry() {
  const file = courseVectorPaths.tutorialSourceFile;
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const source of registry.sources) {
    source.excerptSha256 = sha256Text(canonicalSourceText(source.excerpt));
  }
  registry.integrity = {
    algorithm: 'sha256-canonical-json-v1',
    sourcesSha256: sha256Text(canonicalJson(registry.sources))
  };
  fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  return registry.integrity.sourcesSha256;
}

function artifactCases(manifest) {
  return manifest.cases.filter((entry) => entry.lanes.includes('course-vector'));
}

/**
 * Governance-only reference check. This reads ledger IDs, never statements,
 * masks, policies, or expected values; the independent vector oracle remains
 * isolated in runner/courseVectorArtifact.mjs.
 */
export function loadKnownCourseContractIds(file = contractLedgerFile) {
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(ledger.entries) || ledger.entries.some((entry) => typeof entry?.id !== 'string')) {
    throw new Error('course contract ledger has no valid entries array');
  }
  const ids = new Set(ledger.entries.map((entry) => entry.id));
  if (ids.size !== ledger.entries.length) throw new Error('course contract ledger contains duplicate IDs');
  return ids;
}

export function assertKnownContractReferences(vector, knownContractIds = loadKnownCourseContractIds()) {
  const unknown = vector.provenance.contractIds.filter((id) => !knownContractIds.has(id));
  if (unknown.length > 0) {
    throw new Error(`${vector.caseId}: provenance references unknown course contract(s): ${unknown.join(', ')}`);
  }
  return vector;
}

function assertNoOrphans(manifest) {
  const declared = new Set(artifactCases(manifest).map((entry) => entry.courseVector));
  const actual = new Set(listCourseVectorJsonFiles());
  const missing = [...declared].filter((file) => !actual.has(file));
  const orphaned = [...actual].filter((file) => !declared.has(file));
  if (missing.length || orphaned.length) {
    throw new Error(`courseVector set mismatch; missing=[${missing.join(', ')}], orphaned=[${orphaned.join(', ')}]`);
  }
}

export function refreshVectorDerived(vector, newSourceSha256, newSourceRegistrySha256) {
  const previousSourceSha256 = vector.source.sha256;
  const previousSourceRegistrySha256 = vector.provenance.sourceRegistrySha256;
  const previousPayloadSha256 = vector.integrity?.payloadSha256;
  vector.source.sha256 = newSourceSha256;
  vector.provenance.sourceRegistrySha256 = newSourceRegistrySha256;
  const nextPayloadSha256 = vectorPayloadSha256(vector);
  const evidenceChanged = previousSourceSha256 !== newSourceSha256
    || previousSourceRegistrySha256 !== newSourceRegistrySha256
    || previousPayloadSha256 !== nextPayloadSha256;
  if (evidenceChanged && vector.review?.status === 'approved') {
    vector.review = { ...vector.review, status: 'candidate', reviewer: null, reviewedAt: null, reviewRevision: 0 };
  }
  vector.integrity = { algorithm: 'sha256-canonical-json-v1', payloadSha256: nextPayloadSha256 };
  return { vector, evidenceChanged };
}

function refreshArtifacts(manifest, sourceRegistrySha256) {
  for (const manifestCase of artifactCases(manifest)) {
    const file = path.join(courseVectorPaths.vectorRoot, manifestCase.courseVector);
    const vector = JSON.parse(fs.readFileSync(file, 'utf8'));
    refreshVectorDerived(
      vector,
      sourceSha256(path.join(courseVectorPaths.corpusRoot, vector.source.corpusFile)),
      sourceRegistrySha256
    );
    fs.writeFileSync(file, `${JSON.stringify(vector, null, 2)}\n`, 'utf8');
  }
}

function approveArtifacts(manifest, reviewer, reviewRevision) {
  const today = new Date().toISOString().slice(0, 10);
  for (const manifestCase of artifactCases(manifest)) {
    const file = path.join(courseVectorPaths.vectorRoot, manifestCase.courseVector);
    const vector = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (vector.review.author === reviewer) {
      throw new Error(`${vector.caseId}: reviewer must differ from author`);
    }
    vector.review = { ...vector.review, status: 'approved', reviewer, reviewedAt: today, reviewRevision };
    fs.writeFileSync(file, `${JSON.stringify(vector, null, 2)}\n`, 'utf8');
  }
}

export function run(argv) {
  const options = parseArgs(argv);
  let manifest = loadCorpusManifest({ skipCourseVectorValidation: true });
  assertNoOrphans(manifest);
  if (options.action === 'refresh-integrity') {
    const sourceRegistrySha256 = refreshTutorialRegistry();
    refreshArtifacts(manifest, sourceRegistrySha256);
  } else if (options.action === 'approve') {
    approveArtifacts(manifest, options.reviewer, options.reviewRevision);
  }
  const sourceRegistry = loadTutorialSourceRegistry();
  const knownContractIds = loadKnownCourseContractIds();
  manifest = loadCorpusManifest({ skipCourseVectorValidation: true });
  const loaded = [];
  for (const manifestCase of artifactCases(manifest)) {
    const artifact = loadCourseVector(manifestCase, { sourceRegistry, requireApproved: options.requireApproved || options.action === 'approve' });
    assertKnownContractReferences(artifact.vector, knownContractIds);
    loaded.push({ manifestCase, ...artifact });
  }
  if (options.action === 'review') {
    for (const item of loaded) {
      process.stdout.write(`${JSON.stringify({
        type: 'course-vector-review-item',
        caseId: item.vector.caseId,
        profile: item.vector.profile,
        rawSource: fs.readFileSync(path.join(courseVectorPaths.corpusRoot, item.vector.source.corpusFile), 'utf8').replace(/\r\n?/g, '\n'),
        normalizedExpected: item.vector.expected,
        provenance: item.vector.provenance,
        review: item.vector.review,
        sourceSha256: item.vector.source.sha256,
        payloadSha256: item.vector.integrity.payloadSha256
      })}\n`);
    }
  }
  if (options.action === 'review') {
    process.stdout.write(`${JSON.stringify({ type: 'course-vector-review-summary', artifacts: artifactCases(manifest).length })}\n`);
  } else {
    process.stdout.write(`courseVector verification OK: ${artifactCases(manifest).length} artifacts; review=${options.requireApproved || options.action === 'approve' ? 'approved' : 'candidate-allowed'}\n`);
  }
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
