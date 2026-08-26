#!/usr/bin/env node
/** Fail-closed gate for the two independently approved hosted-runner baselines. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFixedBenchmark } from './validate-fixed-benchmark.mjs';
import { assertPolicyReviewer } from '../governance/reviewerPolicy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultBaselineRoot = path.join(here, 'baselines');

export const requiredBaselinePairs = Object.freeze([
  Object.freeze({ runnerId: 'github-hosted:ubuntu-24.04', candidate: 'mars-ubuntu-24.04-candidate.json', approval: 'mars-ubuntu-24.04-approval.json' }),
  Object.freeze({ runnerId: 'github-hosted:windows-2025', candidate: 'mars-windows-2025-candidate.json', approval: 'mars-windows-2025-approval.json' })
]);

function invariant(condition, message) {
  if (!condition) throw new Error(`approved benchmark gate: ${message}`);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function assertApprovedBaselineFileSet(fileNames) {
  const actual = new Set(fileNames.filter((name) => name.endsWith('.json')));
  const expected = new Set(requiredBaselinePairs.flatMap((pair) => [pair.candidate, pair.approval]));
  const missing = [...expected].filter((name) => !actual.has(name));
  const orphaned = [...actual].filter((name) => !expected.has(name));
  invariant(missing.length === 0 && orphaned.length === 0, `file set mismatch; missing=[${missing.join(', ')}], orphaned=[${orphaned.join(', ')}]`);
}

export function validateApprovalEnvelope(envelope, candidateBytes, candidate, pair) {
  invariant(isObject(envelope), `${pair.approval} must be an object`);
  const fields = ['schemaRevision', 'kind', 'candidateFile', 'candidateSha256', 'candidatePayloadSha256', 'runnerFingerprint', 'referenceSha256', 'matrixRevision', 'reviewer', 'reviewedAt', 'reviewRevision', 'adr'];
  invariant(Object.keys(envelope).every((key) => fields.includes(key)) && fields.every((key) => Object.hasOwn(envelope, key)), `${pair.approval} fields are incomplete/unknown`);
  invariant(envelope.schemaRevision === 1 && envelope.kind === 'approved-mars-performance-baseline', `${pair.approval} type/revision is invalid`);
  invariant(envelope.candidateFile === pair.candidate, `${pair.approval} names the wrong candidate`);
  invariant(envelope.candidateSha256 === sha256(candidateBytes), `${pair.approval} candidate SHA is stale`);
  invariant(envelope.candidatePayloadSha256 === candidate.integrity.payloadSha256, `${pair.approval} payload SHA is stale`);
  invariant(envelope.runnerFingerprint === candidate.runnerFingerprint && envelope.referenceSha256 === candidate.reference.sha256 && envelope.matrixRevision === candidate.matrixRevision, `${pair.approval} candidate fingerprints are stale`);
  try {
    assertPolicyReviewer(envelope.reviewer, `${pair.approval} reviewer`);
  } catch (error) {
    invariant(false, error instanceof Error ? error.message : String(error));
  }
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(envelope.reviewedAt) && Number.isSafeInteger(envelope.reviewRevision) && envelope.reviewRevision > 0, `${pair.approval} review provenance is invalid`);
  invariant(envelope.adr === 'docs/adr/0001-mips-performance-baseline-policy.md', `${pair.approval} ADR reference is invalid`);
  return envelope;
}

export function verifyApprovedBaselines(root = defaultBaselineRoot) {
  assertApprovedBaselineFileSet(fs.readdirSync(root));
  for (const pair of requiredBaselinePairs) {
    const candidateBytes = fs.readFileSync(path.join(root, pair.candidate));
    const candidate = validateFixedBenchmark(JSON.parse(candidateBytes.toString('utf8')), { requireEligible: true });
    invariant(candidate.runner.id === pair.runnerId, `${pair.candidate} has runner ${candidate.runner.id}, expected ${pair.runnerId}`);
    const envelope = JSON.parse(fs.readFileSync(path.join(root, pair.approval), 'utf8'));
    validateApprovalEnvelope(envelope, candidateBytes, candidate, pair);
  }
  return requiredBaselinePairs.length;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    invariant(process.argv.length === 2, 'this command accepts no arguments');
    const count = verifyApprovedBaselines();
    process.stdout.write(`approved benchmark verification OK: ${count} hosted runners\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
