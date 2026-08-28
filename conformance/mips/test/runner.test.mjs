/** Fail-closed conformance sentinels; pinned references are mandatory. */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadCorpusManifest, validateCorpusManifest } from '../runner/caseManifest.mjs';
import { runCourseVectorCase } from '../runner/lanes/course-vector.mjs';
import { runLegacyBaselineCase } from '../runner/lanes/legacy-baseline.mjs';
import { runAssemblyDiffCase } from '../runner/lanes/assembly-diff.mjs';
import { courseUsesDelayedBranching, effectiveMarsMaxSteps, parseCoL2Trace } from '../runner/marsRunner.mjs';
import { loadCourseVector, vectorPayloadSha256 } from '../runner/courseVectorArtifact.mjs';
import { referenceRoles, resolveVerifiedReference } from '../reference/referenceAssets.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const runnerCli = path.resolve(testRoot, '..', 'runner', 'run-conformance.mjs');
const contractValidatorCli = path.resolve(testRoot, '..', 'contract', 'validate-contracts.mjs');
const manifest = loadCorpusManifest();

function caseById(caseId) {
  const manifestCase = manifest.cases.find((entry) => entry.caseId === caseId);
  assert.ok(manifestCase, `corpus case ${caseId} missing`);
  return manifestCase;
}

test('all three pinned reference roles are present and hash-verified', () => {
  for (const role of Object.values(referenceRoles)) {
    const reference = resolveVerifiedReference(role);
    assert.equal(reference.role, role);
    assert.equal(reference.verifiedSha256, reference.sha256);
  }
});

test('contract validator rejects unknown CLI arguments', () => {
  const cli = spawnSync(process.execPath, [contractValidatorCli, '--typo'], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /unknown arguments: --typo/);
});

test('stable MARS step limits below 32 cannot be mistaken for register selectors', () => {
  assert.equal(effectiveMarsMaxSteps(1), 32);
  assert.equal(effectiveMarsMaxSteps(31), 32);
  assert.equal(effectiveMarsMaxSteps(32), 32);
  assert.equal(effectiveMarsMaxSteps(4096), 4096);
  assert.throws(() => effectiveMarsMaxSteps(0), /positive safe integer/);
});

test('course reference enables delayed branching only for P5 through P7', () => {
  assert.equal(courseUsesDelayedBranching('P3'), false);
  assert.equal(courseUsesDelayedBranching('P4'), false);
  assert.equal(courseUsesDelayedBranching('P5'), true);
  assert.equal(courseUsesDelayedBranching('P6'), true);
  assert.equal(courseUsesDelayedBranching('P7'), true);
});

test('coL2 parser fails closed on commit-looking lines with malformed indentation', () => {
  assert.throws(
    () => parseCoL2Trace('@PC00003000 -> add $1,$0,$0 (00000820)\n  $ 1 <= 00000000\n'),
    /malformed coL2 commit indentation/
  );
});

test('course vectors pass through their declared independent verification mode', () => {
  for (const manifestCase of manifest.cases.filter((entry) => entry.lanes.includes('course-vector'))) {
    const result = runCourseVectorCase(manifestCase);
    if (manifestCase.profile !== 'P7' || manifestCase.caseId.includes('TIMER')) {
      assert.equal(result.status, 'passed', `${manifestCase.caseId}: ${result.message}`);
      assert.match(result.evidenceKind, /^ts-cli-/, `${manifestCase.caseId} did not execute the TS CLI`);
    } else {
      assert.equal(result.status, 'validated', `${manifestCase.caseId}: ${result.message}`);
      assert.equal(result.evidenceKind, 'directed-artifact-only');
    }
  }
});

test('wrong expected value and undeclared write are both caught', () => {
  const manifestCase = caseById('COURSE-VEC-P3-ARITH-001');
  const wrongValue = structuredClone(loadCourseVector(manifestCase).vector);
  wrongValue.expected.gpr['11'] = '0x12341235';
  wrongValue.integrity.payloadSha256 = vectorPayloadSha256(wrongValue);
  assert.equal(runCourseVectorCase(manifestCase, { vectorOverride: wrongValue }).status, 'failed');

  const missingWriteDeclaration = structuredClone(loadCourseVector(manifestCase).vector);
  missingWriteDeclaration.expected.writes.gpr = missingWriteDeclaration.expected.writes.gpr.filter((entry) => entry !== '14');
  missingWriteDeclaration.integrity.payloadSha256 = vectorPayloadSha256(missingWriteDeclaration);
  const result = runCourseVectorCase(manifestCase, { vectorOverride: missingWriteDeclaration });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /writes/);
});

test('stock MARS reset divergence cannot pass as the course-correct challenge expectation', () => {
  const forced = structuredClone(caseById('MARS-BASELINE-GPSP-001'));
  forced.lanes = ['course-vector'];
  forced.courseVector = 'MARS-BASELINE-GPSP-001.json';
  delete forced.legacyExpected;
  assert.throws(() => runCourseVectorCase(forced), /vector file/);
});

test('legacy course executor matches every candidate expectation and deterministic golden', () => {
  for (const manifestCase of manifest.cases.filter((entry) => entry.lanes.includes('legacy-baseline'))) {
    const result = runLegacyBaselineCase(manifestCase);
    assert.equal(result.status, 'passed', `${manifestCase.caseId}: ${result.status} - ${result.message}`);
  }
});

test('challenge expectation is checked independently of its golden', () => {
  const mutated = structuredClone(caseById('MARS-BASELINE-GPSP-001'));
  mutated.legacyExpected.dm['0x00000000'] = '0xdeadbeef';
  const result = runLegacyBaselineCase(mutated);
  assert.equal(result.status, 'failed');
  assert.match(result.message, /candidate corpus expectation/);
});

test('golden provenance changes invalidate the baseline', () => {
  const stale = structuredClone(caseById('MARS-BASELINE-GPSP-001'));
  const result = runLegacyBaselineCase(stale, {
    corpusCandidate: { ...manifest.candidate, revision: manifest.candidate.revision + 1 }
  });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /fingerprint is stale/);
});

test('missing legacy golden is an error, never a reachability pass', () => {
  const withoutGolden = structuredClone(caseById('MARS-BASELINE-GPSP-001'));
  withoutGolden.caseId = 'MISSING-GOLDEN-SENTINEL';
  const result = runLegacyBaselineCase(withoutGolden);
  assert.equal(result.status, 'error');
  assert.match(result.message, /marsGolden candidate is missing/);
});

test('corpus manifest rejects traversal before any case is run', () => {
  const invalid = structuredClone(manifest);
  invalid.cases[0].file = '../production.asm';
  assert.throws(() => validateCorpusManifest(invalid), /corpus-relative/);
});

test('corpus manifest rejects unknown fields instead of silently accepting typos', () => {
  const invalid = structuredClone(manifest);
  invalid.cases[0].legacyExpected.hatlPc = invalid.cases[0].legacyExpected.haltPc;
  assert.throws(() => validateCorpusManifest(invalid), /unknown fields: hatlPc/);
});

test('assembly-diff lane is fail-closed when a prerequisite is missing and passes with both prerequisites', () => {
  const direct = runAssemblyDiffCase(caseById('COURSE-VEC-P3-ARITH-001'));
  assert.ok(['passed', 'skipped', 'failed'].includes(direct.status));

  const cli = spawnSync(process.execPath, [runnerCli, '--lane', 'assembly-diff'], { encoding: 'utf8' });
  if (direct.status === 'passed') {
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /"passed":10/);
  } else {
    assert.equal(cli.status, 1);
    assert.match(cli.stdout, /"(?:skipped|failed)":10/);
  }
});

test('a selected candidate lane with a zero-case filter exits non-zero', () => {
  const cli = spawnSync(process.execPath, [runnerCli, '--lane', 'course-vector', '--filter', 'DOES-NOT-EXIST'], {
    encoding: 'utf8'
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /selected zero cases/);
});

test('a single lane runs its cases and reports the plain runner gate', () => {
  const cli = spawnSync(process.execPath, [
    runnerCli,
    '--lane', 'course-vector',
    '--filter', 'COURSE-VEC-P7-TIMER-001'
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /"gate":"runner"/);
  assert.match(cli.stdout, /"required":false/);
  assert.match(cli.stdout, /"failed":0/);
});

test('the runner no longer carries a formal approval gate and rejects the flag', () => {
  const partial = spawnSync(process.execPath, [runnerCli, '--formal'], { encoding: 'utf8' });
  assert.equal(partial.status, 2);
  assert.match(partial.stderr, /unknown argument: --formal/);

  const full = spawnSync(process.execPath, [runnerCli], { encoding: 'utf8' });
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /"gate":"runner"/);
  assert.match(full.stdout, /"passed":12/);
  assert.match(full.stdout, /"validated":2/);
  assert.match(full.stdout, /"failed":0/);
});
