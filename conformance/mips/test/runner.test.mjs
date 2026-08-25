/**
 * Conformance smoke sentinels.
 *
 * Prove the harness is not "always green":
 *  1. every phase-0 course vector passes on the pinned MARS reference;
 *  2. a planted mutant (wrong expected value) must FAIL;
 *  3. the MARS-vs-course divergence case must FAIL as a course vector,
 *     i.e. MARS-only behavior can never leak into course vectors silently.
 *
 * Requires the pinned reference JAR (run `node reference/download-references.mjs`
 * first); tests are skipped with a clear message when it is absent.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadCorpusManifest } from '../runner/caseManifest.mjs';
import { runCourseVectorCase } from '../runner/lanes/course-vector.mjs';
import { runLegacyBaselineCase } from '../runner/lanes/legacy-baseline.mjs';
import { runAssemblyDiffCase } from '../runner/lanes/assembly-diff.mjs';
import { referenceJarPath } from '../runner/marsRunner.mjs';

const manifest = loadCorpusManifest();
const jarAvailable = fs.existsSync(referenceJarPath());

function caseById(caseId) {
  const manifestCase = manifest.cases.find((entry) => entry.caseId === caseId);
  assert.ok(manifestCase, `corpus case ${caseId} missing`);
  return manifestCase;
}

test('course vectors pass on the pinned MARS reference', (t) => {
  if (!jarAvailable) {
    t.skip('reference JAR missing; run node reference/download-references.mjs first');
    return;
  }
  for (const manifestCase of manifest.cases.filter((entry) => entry.lanes.includes('course-vector'))) {
    const result = runCourseVectorCase(manifestCase);
    assert.equal(result.status, 'passed', `${manifestCase.caseId}: ${result.message}`);
  }
});

test('planted mutant in a course vector is caught', (t) => {
  if (!jarAvailable) {
    t.skip('reference JAR missing; run node reference/download-references.mjs first');
    return;
  }
  const mutated = structuredClone(caseById('COURSE-VEC-P3-ARITH-001'));
  // Flip one expected GPR value; the harness must report the mismatch.
  mutated.expected = { ...mutated.expected, gpr: { ...mutated.expected.gpr, 11: '0x12341235' } };
  const result = runCourseVectorCase(mutated);
  assert.equal(result.status, 'failed', 'mutated expected value must fail the lane');
  assert.match(result.message, /course vector/);
});

test('MARS-vs-course divergence must fail as a course vector', (t) => {
  if (!jarAvailable) {
    t.skip('reference JAR missing; run node reference/download-references.mjs first');
    return;
  }
  // Force the gp/sp divergence case through the course-vector lane with the
  // hand-computed COURSE expectation (all-zero reset). MARS writes 0x1800/0x2ffc,
  // so this must fail rather than silently pass as a course vector.
  const forced = structuredClone(caseById('MARS-BASELINE-GPSP-001'));
  forced.lanes = ['course-vector'];
  forced.expected = {
    ...forced.expected,
    gpr: {},
    dm: { '0x00000000': '0x00000000', '0x00000004': '0x00000000' }
  };
  const result = runCourseVectorCase(forced);
  assert.equal(result.status, 'failed', 'MARS-only initial state must not pass as a course vector');
});

test('legacy baseline reaches the documented halt loop', (t) => {
  if (!jarAvailable) {
    t.skip('reference JAR missing; run node reference/download-references.mjs first');
    return;
  }
  for (const manifestCase of manifest.cases.filter((entry) => entry.lanes.includes('legacy-baseline'))) {
    const result = runLegacyBaselineCase(manifestCase);
    assert.ok(
      result.status === 'passed' || result.status === 'recorded',
      `${manifestCase.caseId}: ${result.status} - ${result.message}`
    );
  }
});

test('assembly-diff lane reports skipped until phase 5', () => {
  const result = runAssemblyDiffCase(caseById('COURSE-VEC-P3-ARITH-001'));
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /phase 5/);
});
