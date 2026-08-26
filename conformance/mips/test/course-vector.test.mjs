import * as fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadCorpusManifest } from '../runner/caseManifest.mjs';
import {
  assertCourseVectorApproved,
  loadCourseVector,
  loadTutorialSourceRegistry,
  validateCourseVector,
  vectorPayloadSha256
} from '../runner/courseVectorArtifact.mjs';
import {
  assertKnownContractReferences,
  loadKnownCourseContractIds,
  parseArgs as parseManageArgs,
  refreshVectorDerived
} from '../expected/courseVector/manage-course-vectors.mjs';

const manifest = loadCorpusManifest();

function manifestCase(caseId) {
  const found = manifest.cases.find((entry) => entry.caseId === caseId);
  assert.ok(found);
  return found;
}

test('every course-vector case resolves to a physically separate artifact', () => {
  const paths = new Set();
  for (const entry of manifest.cases.filter((candidate) => candidate.lanes.includes('course-vector'))) {
    const loaded = loadCourseVector(entry);
    assert.equal(loaded.vector.source.corpusFile, entry.file);
    assert.equal(loaded.vector.caseId, entry.caseId);
    assert.ok(!paths.has(loaded.file));
    paths.add(loaded.file);
  }
  assert.equal(paths.size, 10);
});

test('course-vector provenance only references frozen contract IDs', () => {
  const knownContractIds = loadKnownCourseContractIds();
  for (const entry of manifest.cases.filter((candidate) => candidate.lanes.includes('course-vector'))) {
    assert.equal(assertKnownContractReferences(loadCourseVector(entry).vector, knownContractIds).caseId, entry.caseId);
  }
  const planted = structuredClone(loadCourseVector(manifestCase('COURSE-VEC-P7-TIMER-001')).vector);
  planted.provenance.contractIds.push('COURSE-P7-NOT-A-CONTRACT-999');
  assert.throws(() => assertKnownContractReferences(planted, knownContractIds), /unknown course contract/);
});

test('course vectors fail closed on payload, source, and independent-oracle mutation', () => {
  const sourceRegistry = loadTutorialSourceRegistry();
  const cp0Case = manifestCase('COURSE-VEC-P7-CP0-EXCEPTION-001');
  const original = loadCourseVector(cp0Case).vector;

  const arithmeticCase = manifestCase('COURSE-VEC-P3-ARITH-001');
  const stalePayload = structuredClone(loadCourseVector(arithmeticCase).vector);
  stalePayload.expected.gpr['11'] = '0x12341235';
  assert.throws(() => validateCourseVector(stalePayload, arithmeticCase, sourceRegistry), /payloadSha256 is stale/);

  const oracleMismatch = structuredClone(original);
  oracleMismatch.expected.snapshots[5].epc = '0x0000300c';
  oracleMismatch.integrity.payloadSha256 = vectorPayloadSha256(oracleMismatch);
  assert.throws(() => validateCourseVector(oracleMismatch, cp0Case, sourceRegistry), /independent CP0 oracle/);

  const staleSource = structuredClone(original);
  staleSource.source.sha256 = 'a'.repeat(64);
  staleSource.integrity.payloadSha256 = vectorPayloadSha256(staleSource);
  assert.throws(() => validateCourseVector(staleSource, cp0Case, sourceRegistry), /source.sha256 is stale/);

  const staleRegistry = structuredClone(original);
  staleRegistry.provenance.sourceRegistrySha256 = 'a'.repeat(64);
  staleRegistry.integrity.payloadSha256 = vectorPayloadSha256(staleRegistry);
  assert.throws(() => validateCourseVector(staleRegistry, cp0Case, sourceRegistry), /sourceRegistrySha256 is stale/);
});

test('candidate expected data cannot satisfy the approved phase gate', () => {
  const candidate = structuredClone(loadCourseVector(manifestCase('COURSE-VEC-P7-TIMER-001')).vector);
  candidate.review = { ...candidate.review, status: 'candidate', reviewer: null, reviewedAt: null, reviewRevision: 0 };
  assert.throws(
    () => assertCourseVectorApproved(candidate),
    /not independently approved/
  );
});

test('an approved claim must name the centralized policy reviewer', () => {
  const entry = manifestCase('COURSE-VEC-P7-TIMER-001');
  const forged = structuredClone(loadCourseVector(entry).vector);
  forged.review = {
    ...forged.review,
    status: 'approved',
    reviewer: 'attacker-user',
    reviewedAt: '2026-08-26',
    reviewRevision: 1
  };
  assert.throws(
    () => validateCourseVector(forged, entry, loadTutorialSourceRegistry()),
    /policy reviewer stone926/
  );
});

test('course-vector management CLI separates verify, refresh, and independent approval', () => {
  assert.deepEqual(parseManageArgs(['--verify']), {
    action: 'verify', requireApproved: false, reviewer: undefined, reviewRevision: undefined
  });
  assert.deepEqual(parseManageArgs(['--verify', '--require-approved']), {
    action: 'verify', requireApproved: true, reviewer: undefined, reviewRevision: undefined
  });
  assert.deepEqual(parseManageArgs(['--review']), {
    action: 'review', requireApproved: false, reviewer: undefined, reviewRevision: undefined
  });
  assert.deepEqual(parseManageArgs(['--approve', '--reviewer', 'stone926', '--review-revision', '1']), {
    action: 'approve', requireApproved: false, reviewer: 'stone926', reviewRevision: 1
  });
  assert.throws(() => parseManageArgs(['--approve']), /requires reviewer/);
  assert.throws(() => parseManageArgs(['--approve', '--reviewer', 'not a user', '--review-revision', '1']), /GitHub username/);
  assert.throws(() => parseManageArgs(['--approve', '--reviewer', 'attacker-user', '--review-revision', '1']), /policy reviewer stone926/);
  assert.throws(() => parseManageArgs(['--verify', '--approve']), /exactly one/);
  assert.throws(() => parseManageArgs(['--refresh-integrity', '--require-approved']), /accepts no other/);
});

test('refreshing changed expected/source evidence always revokes prior approval', () => {
  const manifestEntry = manifestCase('COURSE-VEC-P3-ARITH-001');
  const approved = structuredClone(loadCourseVector(manifestEntry).vector);
  approved.review = { status: 'approved', author: 'codex-phase0-corpus', reviewer: 'stone926', reviewedAt: '2026-08-26', reviewRevision: 1 };
  approved.integrity.payloadSha256 = vectorPayloadSha256(approved);

  const unchanged = refreshVectorDerived(structuredClone(approved), approved.source.sha256, approved.provenance.sourceRegistrySha256);
  assert.equal(unchanged.evidenceChanged, false);
  assert.equal(unchanged.vector.review.status, 'approved');

  const mutatedExpected = structuredClone(approved);
  mutatedExpected.expected.gpr['11'] = '0x12341235';
  const refreshedExpected = refreshVectorDerived(mutatedExpected, approved.source.sha256, approved.provenance.sourceRegistrySha256);
  assert.equal(refreshedExpected.evidenceChanged, true);
  assert.deepEqual(refreshedExpected.vector.review, {
    status: 'candidate', author: 'codex-phase0-corpus', reviewer: null, reviewedAt: null, reviewRevision: 0
  });

  const refreshedRegistry = refreshVectorDerived(structuredClone(approved), approved.source.sha256, 'a'.repeat(64));
  assert.equal(refreshedRegistry.vector.review.status, 'candidate');
});

test('MARS golden files contain no path or reference into courseVector', () => {
  const goldenRoot = new URL('../expected/marsGolden/', import.meta.url);
  for (const name of fs.readdirSync(goldenRoot)) {
    if (!name.endsWith('.json')) continue;
    const text = fs.readFileSync(new URL(name, goldenRoot), 'utf8');
    assert.doesNotMatch(text, /courseVector/i);
  }
});
