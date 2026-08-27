#!/usr/bin/env node
/** Review the frozen handwritten corpus manifest as one closure. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  corpusCaseFile,
  corpusCaseSha256,
  loadCorpusManifest
} from '../runner/caseManifest.mjs';

function usage(message) {
  throw new Error(`${message}\nUsage: manage-corpus.mjs --verify | --review`);
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

export function run(argv) {
  const options = parseArgs(argv);
  const manifest = loadCorpusManifest();

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
      cases: manifest.cases.length
    })}\n`);
  } else {
    process.stdout.write(`corpus verification OK: ${manifest.cases.length} cases\n`);
  }
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invoked === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
