import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import test from 'node:test';

import {
  buildExecutionCorpusManifest,
  serializedExecutionCorpusManifest
} from '../corpus/generate-execution-corpus.mjs';
import {
  executionCasesPerProfile,
  executionProfiles,
  renderExecutionProgram
} from '../corpus/execution-program-renderer.mjs';
import {
  compareExecutionEvidence,
  executableImageFingerprint,
  observableFinalSummary
} from '../runner/executionDifferential.mjs';

const forbiddenExecutionOperation = /\b(?:j|jal|jr|jalr|syscall|break|eret|mfc0|mtc0)\b/i;
const sha256Pattern = /^[0-9a-f]{64}$/;

test('execution corpus is frozen at 250 safe deterministic generated cases', () => {
  const manifest = buildExecutionCorpusManifest();
  const committed = fs.readFileSync(new URL('../corpus/execution-corpus.json', import.meta.url), 'utf8')
    .replace(/\r\n?/g, '\n');

  assert.equal(committed, serializedExecutionCorpusManifest());
  assert.equal(manifest.generated.length, 250);
  assert.equal(manifest.handwritten.length, executionProfiles.length);
  assert.match(manifest.integrity.payloadSha256, sha256Pattern);
  assert.equal(new Set(manifest.generated.map((entry) => entry.id)).size, 250);

  const sourceHashes = new Set();
  for (const profile of executionProfiles) {
    const selected = manifest.generated.filter((entry) => entry.profile === profile);
    assert.equal(selected.length, executionCasesPerProfile);
    assert.equal(manifest.handwritten.filter((entry) => entry.profile === profile).length, 1);
    for (const entry of selected) {
      const first = renderExecutionProgram(entry);
      const second = renderExecutionProgram(entry);
      assert.deepEqual(first, second);
      assert.equal(first.sourceSha256, entry.sourceSha256);
      assert.equal(first.imageSha256, entry.imageSha256);
      assert.equal(first.words.length, entry.imageWordCount);
      assert.equal(first.haltPc, entry.haltPc);
      assert.deepEqual(first.words.slice(-2), ['0x1000ffff', '0x00000000']);
      assert.doesNotMatch(first.source, forbiddenExecutionOperation);
      assert.ok(first.words.length <= 64);
      sourceHashes.add(first.sourceSha256);
    }
  }
  assert.equal(sourceHashes.size, 250);
});

test('each handwritten profile case covers control flow, memory, and the delay-slot contract', () => {
  const manifest = buildExecutionCorpusManifest();
  for (const entry of manifest.handwritten) {
    const source = fs.readFileSync(new URL(`../corpus/${entry.file}`, import.meta.url), 'utf8');
    assert.deepEqual(entry.features, ['control-flow', 'memory', 'delay-slot-contract']);
    assert.match(source, /\bbeq\b/);
    assert.match(source, /\b(?:lb|lh|lw|sb|sh|sw)\b/);
    assert.match(source, /\bbeq\s+\$0,\s*\$0,[^\n]+\n\s+nop\b/);
    assert.doesNotMatch(source, forbiddenExecutionOperation);
    if (entry.profile === 'P7') {
      const executableLines = source.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#')).join('\n');
      assert.doesNotMatch(executableLines, /\b(?:ktext|exception|interrupt|mmio|cp0)\b/i,
        'P7 executable source must remain in the non-exception MARS-comparable domain');
    }
  }
});

test('execution comparison requires image identity and classifies only frozen contract IDs', () => {
  const words = ['0x34010001', '0x1000ffff', '0x00000000'];
  const fingerprint = executableImageFingerprint(words);
  assert.match(fingerprint, sha256Pattern);
  assert.equal(fingerprint, executableImageFingerprint([...words]));
  assert.notEqual(fingerprint, executableImageFingerprint(['0x34010002', ...words.slice(1)]));

  const writes = [{ pc: '0x00003000', kind: 'grf', target: '1', value: '0x00000001' }];
  const stop = {
    kind: 'course-halt-loop',
    haltPc: '0x00003004',
    haltWord: '0x1000ffff',
    instructions: 2
  };
  const evidence = { writes, stop, finalSummary: observableFinalSummary(writes) };
  assert.deepEqual(compareExecutionEvidence(
    { expectedDifferenceContractId: null }, evidence, structuredClone(evidence), new Set()
  ), {
    status: 'passed',
    classification: 'matched',
    mismatches: [],
    message: 'canonical writes, stop and final summary match'
  });

  const changed = structuredClone(evidence);
  changed.writes[0].value = '0x00000002';
  changed.finalSummary = observableFinalSummary(changed.writes);
  const unknown = compareExecutionEvidence(
    { expectedDifferenceContractId: 'EXECUTION-UNKNOWN' }, evidence, changed, new Set()
  );
  assert.equal(unknown.status, 'failed');
  assert.equal(unknown.classification, 'unexplained');

  const known = compareExecutionEvidence(
    { expectedDifferenceContractId: 'EXECUTION-FROZEN' }, evidence, changed, new Set(['EXECUTION-FROZEN'])
  );
  assert.equal(known.status, 'passed');
  assert.equal(known.classification, 'contract-difference');
  assert.equal(known.contractId, 'EXECUTION-FROZEN');
});
