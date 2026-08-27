#!/usr/bin/env node
/** Review deterministic MARS golden recordings without rewriting them. */
import * as fs from '../guardedFs.mjs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  corpusCaseFile,
  loadCorpusManifest,
  loadMarsGolden,
  marsGoldenFile
} from '../../runner/caseManifest.mjs';

function usage(message) {
  throw new Error(`${message}\nUsage: manage-mars-goldens.mjs --verify | --review`);
}

export function parseArgs(argv) {
  const options = { action: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (['--verify', '--review'].includes(arg)) {
      if (options.action) usage('select exactly one action');
      options.action = arg.slice(2);
    } else {
      usage(`unknown argument: ${arg}`);
    }
  }
  if (!options.action) usage('an action is required');
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
    if (options.action === 'review') {
      process.stdout.write(`${JSON.stringify({
        type: 'mars-golden-review-item',
        caseId: manifestCase.caseId,
        rawSource: fs.readFileSync(corpusCaseFile(manifestCase), 'utf8').replace(/\r\n?/g, '\n'),
        candidate: golden
      })}\n`);
    }
  }
  if (options.action === 'review') {
    process.stdout.write(`${JSON.stringify({ type: 'mars-golden-review-summary', artifacts: cases.length })}\n`);
  } else {
    process.stdout.write(`marsGolden verification OK: ${cases.length} artifacts\n`);
  }
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invoked === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
