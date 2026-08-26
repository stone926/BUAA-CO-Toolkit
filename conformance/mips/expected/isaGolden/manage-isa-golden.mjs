#!/usr/bin/env node
/** Sole review/integrity writer for the independent course ISA golden. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isaGoldenFile,
  isaGoldenPayloadSha256,
  loadIsaGolden,
  validateIsaGolden
} from '../../runner/isaGoldenArtifact.mjs';
import { assertPolicyReviewer } from '../../governance/reviewerPolicy.mjs';

function usage(message) {
  throw new Error(`${message}\nUsage: manage-isa-golden.mjs --verify [--require-approved] | --refresh-integrity | --approve --reviewer <github-user> --review-revision <n>`);
}

export function parseArgs(argv) {
  const result = { action: undefined, requireApproved: false, reviewer: undefined, reviewRevision: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (['--verify', '--refresh-integrity', '--approve'].includes(arg)) {
      if (result.action) usage('select exactly one action');
      result.action = arg.slice(2);
    } else if (arg === '--require-approved') {
      result.requireApproved = true;
    } else if (arg === '--reviewer') {
      result.reviewer = argv[++index];
      try {
        assertPolicyReviewer(result.reviewer, '--reviewer');
      } catch (error) {
        usage(error instanceof Error ? error.message : String(error));
      }
    } else if (arg === '--review-revision') {
      result.reviewRevision = Number(argv[++index]);
      if (!Number.isSafeInteger(result.reviewRevision) || result.reviewRevision <= 0) usage('--review-revision must be a positive integer');
    } else {
      usage(`unknown argument: ${arg}`);
    }
  }
  if (!result.action) usage('an action is required');
  if (result.action === 'verify' && (result.reviewer || result.reviewRevision)) usage('review fields are only valid with --approve');
  if (result.action === 'refresh-integrity' && (result.requireApproved || result.reviewer || result.reviewRevision)) usage('--refresh-integrity accepts no other options');
  if (result.action === 'approve' && (!result.reviewer || !result.reviewRevision || result.requireApproved)) usage('--approve requires reviewer and review revision');
  return result;
}

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function refreshIsaGolden(golden) {
  validateIsaGolden(golden, { skipIntegrity: true });
  const nextDigest = isaGoldenPayloadSha256(golden);
  const evidenceChanged = golden.integrity?.payloadSha256 !== nextDigest;
  const result = structuredClone(golden);
  if (evidenceChanged && result.review.status === 'approved') {
    result.review = {
      ...result.review,
      status: 'candidate',
      reviewer: null,
      reviewedAt: null,
      reviewRevision: 0
    };
  }
  result.integrity = { algorithm: 'sha256-canonical-json-v1', payloadSha256: nextDigest };
  validateIsaGolden(result);
  return { golden: result, evidenceChanged };
}

export function run(argv) {
  const options = parseArgs(argv);
  if (options.action === 'verify') {
    loadIsaGolden({ requireApproved: options.requireApproved });
  } else if (options.action === 'refresh-integrity') {
    const current = JSON.parse(fs.readFileSync(isaGoldenFile, 'utf8'));
    const refreshed = refreshIsaGolden(current);
    writeAtomic(isaGoldenFile, refreshed.golden);
  } else {
    const current = loadIsaGolden();
    if (current.review.author === options.reviewer) throw new Error('reviewer must differ from author');
    const approved = structuredClone(current);
    approved.review = {
      ...approved.review,
      status: 'approved',
      reviewer: options.reviewer,
      reviewedAt: new Date().toISOString().slice(0, 10),
      reviewRevision: options.reviewRevision
    };
    validateIsaGolden(approved, { requireApproved: true });
    writeAtomic(isaGoldenFile, approved);
  }
  const checked = loadIsaGolden({ requireApproved: options.requireApproved || options.action === 'approve' });
  process.stdout.write(`ISA golden verification OK: ${checked.cases.length} instructions, review=${checked.review.status}\n`);
  return 0;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedFile === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
