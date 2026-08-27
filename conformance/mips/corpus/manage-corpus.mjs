#!/usr/bin/env node
/** Review and approve the frozen handwritten corpus manifest as one closure. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  corpusCandidateDescriptor,
  corpusCaseFile,
  corpusCaseSha256,
  loadCorpusManifest
} from '../runner/caseManifest.mjs';
import {
  approvalEnvelopeFile,
  assertCandidateApproved,
  createApprovalEnvelope
} from '../governance/approvalEnvelope.mjs';
import { assertPolicyReviewer } from '../governance/reviewerPolicy.mjs';

function usage(message) {
  throw new Error(`${message}\nUsage: manage-corpus.mjs --verify [--require-approved] | --review | --approve --reviewer <github-user> --review-revision <n>`);
}

export function parseArgs(argv) {
  const options = { action: undefined, requireApproved: false, reviewer: undefined, reviewRevision: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (['--verify', '--review', '--approve'].includes(arg)) {
      if (options.action) usage('select exactly one action');
      options.action = arg.slice(2);
    } else if (arg === '--require-approved') {
      options.requireApproved = true;
    } else if (arg === '--reviewer') {
      options.reviewer = argv[++index];
      try { assertPolicyReviewer(options.reviewer, '--reviewer'); }
      catch (error) { usage(error instanceof Error ? error.message : String(error)); }
    } else if (arg === '--review-revision') {
      options.reviewRevision = Number(argv[++index]);
      if (!Number.isSafeInteger(options.reviewRevision) || options.reviewRevision <= 0) usage('--review-revision must be a positive integer');
    } else {
      usage(`unknown argument: ${arg}`);
    }
  }
  if (!options.action) usage('an action is required');
  if (options.action !== 'verify' && options.requireApproved) usage('--require-approved is only valid with --verify');
  if (options.action !== 'approve' && (options.reviewer || options.reviewRevision)) usage('review fields are only valid with --approve');
  if (options.action === 'approve' && (!options.reviewer || !options.reviewRevision)) usage('--approve requires reviewer and review revision');
  return options;
}

export function run(argv) {
  const options = parseArgs(argv);
  const manifest = loadCorpusManifest();
  const subject = corpusCandidateDescriptor(manifest);
  if (options.action === 'approve') {
    const approvalFile = approvalEnvelopeFile(subject);
    if (fs.existsSync(approvalFile)) assertCandidateApproved(subject);
    else createApprovalEnvelope(subject, { reviewer: options.reviewer, reviewRevision: options.reviewRevision });
  }
  if (options.requireApproved || options.action === 'approve') assertCandidateApproved(subject);

  if (options.action === 'review') {
    for (const item of manifest.cases) {
      process.stdout.write(`${JSON.stringify({
        type: 'corpus-review-item',
        caseId: item.caseId,
        profile: item.profile,
        lanes: item.lanes,
        features: item.features,
        provenance: item.provenance,
        sourceSha256: corpusCaseSha256(item),
        rawSource: fs.readFileSync(corpusCaseFile(item), 'utf8').replace(/\r\n?/g, '\n'),
        legacyExpected: item.legacyExpected ?? null,
        courseVector: item.courseVector ?? null
      })}\n`);
    }
    process.stdout.write(`${JSON.stringify({
      type: 'corpus-review-summary',
      cases: manifest.cases.length,
      subject
    })}\n`);
  } else {
    process.stdout.write(`corpus verification OK: ${manifest.cases.length} cases; approval=${options.requireApproved || options.action === 'approve' ? 'required' : 'candidate-allowed'}\n`);
  }
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invoked === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
