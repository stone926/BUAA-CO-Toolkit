import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import {
  isaGoldenCandidateDescriptor,
  isaGoldenPayloadSha256,
  loadIsaGolden,
  validateIsaGolden
} from '../runner/isaGoldenArtifact.mjs';
import {
  approvalEnvelopeSha256,
  conformanceRoot,
  validateApprovalEnvelope
} from '../governance/approvalEnvelope.mjs';
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

test('ISA golden management arguments require GitHub reviewer identity', () => {
  assert.deepEqual(parseArgs(['--verify', '--require-approved']), {
    action: 'verify', requireApproved: true, reviewer: undefined, reviewRevision: undefined
  });
  assert.deepEqual(parseArgs(['--approve', '--reviewer', 'stone926', '--review-revision', '1']), {
    action: 'approve', requireApproved: false, reviewer: 'stone926', reviewRevision: 1
  });
  assert.throws(() => parseArgs(['--approve', '--reviewer', 'not a user', '--review-revision', '1']), /GitHub username/);
  assert.throws(() => parseArgs(['--approve', '--reviewer', 'attacker-user', '--review-revision', '1']), /policy reviewer stone926/);
  assert.throws(() => parseArgs(['--refresh-integrity', '--require-approved']), /accepts no other options/);
});

test('embedded ISA approval is inert and the unified envelope rejects an unauthorized reviewer', () => {
  const forged = structuredClone(loadIsaGolden());
  forged.review = {
    ...forged.review,
    status: 'approved',
    reviewer: 'attacker-user',
    reviewedAt: '2026-08-26',
    reviewRevision: 1
  };
  assert.throws(() => validateIsaGolden(forged), /must remain candidate/);

  const current = loadIsaGolden();
  const subject = isaGoldenCandidateDescriptor(current);
  const envelope = {
    schemaRevision: 1,
    kind: 'phase0-artifact-approval',
    subject,
    review: { status: 'approved', reviewer: 'attacker-user', reviewedAt: '2026-08-26', reviewRevision: 1 },
    integrity: { algorithm: 'sha256-canonical-json-v1', envelopeSha256: '' }
  };
  envelope.integrity.envelopeSha256 = approvalEnvelopeSha256(envelope);
  assert.throws(() => validateApprovalEnvelope(envelope, subject), /policy reviewer stone926/);
});

test('the approved gate fails closed when no approval envelope exists', () => {
  // Same reasoning as the courseVector sentinel: the shipped golden is legitimately
  // approved, so prove the fail-closed path against an empty approval root rather
  // than by assuming the repository stays un-approved.
  const golden = loadIsaGolden();
  assert.equal(golden.review.status, 'candidate');
  const emptyRoot = fs.mkdtempSync(path.join(conformanceRoot, '.approval-sentinel-'));
  try {
    assert.throws(
      () => loadIsaGolden({ requireApproved: true, approvalRoot: emptyRoot }),
      /is not approved/
    );
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
  assert.doesNotThrow(() => loadIsaGolden({ requireApproved: true }));
});
