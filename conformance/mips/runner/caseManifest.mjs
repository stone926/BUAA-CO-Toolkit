/**
 * Corpus manifest access for the conformance runner.
 *
 * Phase 0 expected values live in corpus/manifest.json under the hand-reviewed
 * `expected` field. `--record-golden` writes marsGolden files (one per case,
 * content-addressed layout: golden/<caseId>.json) and must be run explicitly;
 * regular runs never update expected data.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const corpusRoot = path.resolve(import.meta.dirname, '..', 'corpus');
const marsGoldenRoot = path.resolve(import.meta.dirname, '..', 'expected', 'marsGolden');

export function loadCorpusManifest() {
  return JSON.parse(fs.readFileSync(path.join(corpusRoot, 'manifest.json'), 'utf8'));
}

export function corpusCaseFile(manifestCase) {
  return path.join(corpusRoot, manifestCase.file);
}

export function marsGoldenFile(caseId) {
  return path.join(marsGoldenRoot, `${caseId}.json`);
}

export function loadMarsGolden(caseId) {
  const file = marsGoldenFile(caseId);
  if (!fs.existsSync(file)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function recordMarsGolden(caseId, golden) {
  const file = marsGoldenFile(caseId);
  fs.writeFileSync(file, `${JSON.stringify(golden, null, 2)}\n`);
  return file;
}
