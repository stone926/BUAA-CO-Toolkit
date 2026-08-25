/**
 * course-vector lane: hand-reviewed expected values from the course contract.
 *
 * Phase 0 executes the vector on the pinned MARS reference and compares the
 * final state against the hand-computed `expected` in corpus/manifest.json.
 * For the phase-0 P3 vectors MARS and the course contract agree (the
 * divergences that exist are documented in the contract ledger and kept out
 * of the course-vector corpus); from phase 2 onward this lane switches to
 * executing the TS engine through its versioned CLI/JSONL interface, so the
 * expected data does not depend on MARS.
 */
import { finalState, haltReached, parseCoL2Trace, runMarsReference, stockAssemblerRole } from '../marsRunner.mjs';
import { corpusCaseFile } from '../caseManifest.mjs';
import { compareExpected, normalizedState, normalizedWrites } from '../stateOracle.mjs';

const defaultMaxSteps = 4096;

export function runCourseVectorCase(manifestCase, options = {}) {
  const run = runMarsReference({
    asmFile: corpusCaseFile(manifestCase),
    profile: manifestCase.profile,
    maxSteps: options.maxSteps ?? defaultMaxSteps,
    role: stockAssemblerRole
  });
  if (!run.ok) {
    return {
      caseId: manifestCase.caseId,
      lane: 'course-vector',
      status: 'error',
      message: `stock MARS reference failed: ${run.error ?? `exit ${run.exitCode}`}`,
      stderr: run.stderr.slice(0, 500)
    };
  }

  let blocks;
  try {
    blocks = parseCoL2Trace(run.stdout);
  } catch (error) {
    return { caseId: manifestCase.caseId, lane: 'course-vector', status: 'error', message: error.message };
  }
  const expected = manifestCase.expected;
  if (!haltReached(blocks, expected.haltPc, expected.haltWord, 2)) {
    return {
      caseId: manifestCase.caseId,
      lane: 'course-vector',
      status: 'failed',
      message: `halt loop not reached at ${expected.haltPc} (${expected.haltWord})`
    };
  }

  const state = finalState(blocks, { seedCompactGpr: true });
  const mismatches = compareExpected(expected, state);
  if (mismatches.length) {
    return {
      caseId: manifestCase.caseId,
      lane: 'course-vector',
      status: 'failed',
      message: `final state differs from course vector: ${mismatches.join('; ')}`
    };
  }
  return {
    caseId: manifestCase.caseId,
    lane: 'course-vector',
    status: 'passed',
    message: 'final state matches the hand-reviewed course vector',
    normalized: normalizedState(state),
    writes: normalizedWrites(state),
    referenceSha256: run.reference.verifiedSha256
  };
}
