#!/usr/bin/env node
/** Wrap a reviewed controlled-runner candidate in an immutable approval envelope. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFixedBenchmark } from './validate-fixed-benchmark.mjs';
import { assertPolicyReviewer } from '../governance/reviewerPolicy.mjs';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (['--input', '--output', '--reviewer', '--review-revision'].includes(flag)) options[flag.slice(2)] = argv[++index];
    else throw new Error(`unknown argument: ${flag}`);
  }
  for (const field of ['input', 'output', 'reviewer', 'review-revision']) if (!options[field]) throw new Error(`--${field} is required`);
  const reviewRevision = Number(options['review-revision']);
  if (!Number.isSafeInteger(reviewRevision) || reviewRevision <= 0) throw new Error('--review-revision must be a positive integer');
  assertPolicyReviewer(options.reviewer, '--reviewer');
  return { input: options.input, output: options.output, reviewer: options.reviewer, reviewRevision };
}

export function approve(argv) {
  const options = parseArgs(argv);
  const inputBytes = fs.readFileSync(options.input);
  const candidate = validateFixedBenchmark(JSON.parse(inputBytes.toString('utf8')), { requireEligible: true });
  const envelope = {
    schemaRevision: 1,
    kind: 'approved-mars-performance-baseline',
    candidateFile: path.basename(options.input),
    candidateSha256: sha256(inputBytes),
    candidatePayloadSha256: candidate.integrity.payloadSha256,
    runnerFingerprint: candidate.runnerFingerprint,
    referenceSha256: candidate.reference.sha256,
    matrixRevision: candidate.matrixRevision,
    reviewer: options.reviewer,
    reviewedAt: new Date().toISOString().slice(0, 10),
    reviewRevision: options.reviewRevision,
    adr: 'docs/adr/0001-mips-performance-baseline-policy.md'
  };
  const output = path.resolve(options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`approved envelope written: ${output}\n`);
  return 0;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedFile === fileURLToPath(import.meta.url)) {
  try { process.exitCode = approve(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
