import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import {
  isaGoldenPayloadSha256,
  loadIsaGolden,
  validateIsaGolden
} from '../runner/isaGoldenArtifact.mjs';

import {
  parseArgs,
  refreshIsaGolden
} from '../expected/isaGolden/manage-isa-golden.mjs';

test('independent ISA golden freezes every required profile set and counterexample', () => {
  const golden = loadIsaGolden();
  assert.equal(golden.cases.length, 33);
  assert.equal(golden.runtimeCounterexamples.length, 5);

  const missing = structuredClone(golden);
  missing.cases = missing.cases.filter((entry) => entry.mnemonic !== 'syscall');
  missing.integrity.payloadSha256 = isaGoldenPayloadSha256(missing);
  assert.throws(() => validateIsaGolden(missing), /P7 required mnemonic set is incomplete/);

  const narrowed = structuredClone(golden);
  narrowed.cases.find((entry) => entry.mnemonic === 'add').profiles = ['P7'];
  narrowed.integrity.payloadSha256 = isaGoldenPayloadSha256(narrowed);
  assert.throws(() => validateIsaGolden(narrowed), /P3 required mnemonic set is incomplete/);
});

test('legacy embedded ISA approval is always migrated to an external candidate', () => {
  const approved = structuredClone(loadIsaGolden());
  approved.review = {
    ...approved.review,
    status: 'approved',
    reviewer: 'stone926',
    reviewedAt: '2026-08-26',
    reviewRevision: 1
  };
  const unchanged = refreshIsaGolden(structuredClone(approved));
  assert.equal(unchanged.evidenceChanged, false);
  assert.equal(unchanged.golden.review.status, 'candidate');

  const changed = structuredClone(approved);
  changed.cases.find((entry) => entry.mnemonic === 'add').word = '0x014b4821';
  const refreshed = refreshIsaGolden(changed);
  assert.equal(refreshed.evidenceChanged, true);
  assert.deepEqual(refreshed.golden.review, {
    ...approved.review,
    status: 'candidate',
    reviewer: null,
    reviewedAt: null,
    reviewRevision: 0
  });
});

test('ISA golden management CLI verifies and refreshes integrity', () => {
  assert.deepEqual(parseArgs(['--verify']), { action: 'verify' });
  assert.deepEqual(parseArgs(['--refresh-integrity']), { action: 'refresh-integrity' });
  assert.throws(() => parseArgs(['--approve', '--reviewer', 'stone926', '--review-revision', '1']), /unknown argument/);
  assert.throws(() => parseArgs(['--require-approved']), /unknown argument|an action is required/);
  assert.throws(() => parseArgs(['--verify', '--refresh-integrity']), /exactly one/);
});


