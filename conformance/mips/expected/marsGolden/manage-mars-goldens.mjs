#!/usr/bin/env node
/** Review/approve deterministic MARS golden candidates without rewriting them. */
import * as fs from '../guardedFs.mjs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  corpusCaseFile,
  loadCorpusManifest,
  loadMarsGolden,
  marsGoldenCandidateDescriptor,
  marsGoldenFile
} from '../../runner/caseManifest.mjs';
import {
  approvalEnvelopeFile,
  assertCandidateApproved,
  createApprovalEnvelope
} from '../../governance/approvalEnvelope.mjs';
import { assertPolicyReviewer } from '../../governance/reviewerPolicy.mjs';

function usage(message) {
  throw new Error(`${message}\nUsage: manage-mars-goldens.mjs --verify [--require-approved] | --review | --approve --reviewer <github-user> --review-revision <n>`);
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

function goldenCases() {
  const manifest = loadCorpusManifest({ skipCourseVectorValidation: true });
  const expected = manifest.cases.filter((item) => item.lanes.includes('legacy-baseline'));
  const expectedNames = new Set(expected.map((item) => `${item.caseId}.json`));
  const root = path.dirname(marsGoldenFile('PLACEHOLDER'));
  const actualNames = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name);
  const orphaned = actualNames.filter((name) => !expectedNames.has(name));
  const missing = [...expectedNames].filter((name) => !actualNames.includes(name));
  if (missing.length || orphaned.length) throw new Error(`marsGolden set mismatch; missing=[${missing.join(', ')}], orphaned=[${orphaned.join(', ')}]`);
  return expected;
}

export function run(argv) {
  const options = parseArgs(argv);
  const cases = goldenCases();
  for (const manifestCase of cases) {
    const golden = loadMarsGolden(manifestCase.caseId);
    if (!golden) throw new Error(`missing marsGolden ${manifestCase.caseId}`);
    const subject = marsGoldenCandidateDescriptor(golden);
    if (options.action === 'approve') {
      const approvalFile = approvalEnvelopeFile(subject);
      if (fs.existsSync(approvalFile)) assertCandidateApproved(subject);
      else createApprovalEnvelope(subject, { reviewer: options.reviewer, reviewRevision: options.reviewRevision });
    }
    if (options.requireApproved || options.action === 'approve') assertCandidateApproved(subject);
    if (options.action === 'review') {
      process.stdout.write(`${JSON.stringify({
        type: 'mars-golden-review-item',
        caseId: manifestCase.caseId,
        rawSource: fs.readFileSync(corpusCaseFile(manifestCase), 'utf8').replace(/\r\n?/g, '\n'),
        candidate: golden,
        subject
      })}\n`);
    }
  }
  if (options.action === 'review') {
    process.stdout.write(`${JSON.stringify({ type: 'mars-golden-review-summary', artifacts: cases.length })}\n`);
  } else {
    process.stdout.write(`marsGolden verification OK: ${cases.length} artifacts; approval=${options.requireApproved || options.action === 'approve' ? 'required' : 'candidate-allowed'}\n`);
  }
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invoked === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
