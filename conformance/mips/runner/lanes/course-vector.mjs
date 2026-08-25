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
import { finalState, haltReached, parseCoL2Trace, runMarsReference } from '../marsRunner.mjs';
import { corpusCaseFile } from '../caseManifest.mjs';

const defaultMaxSteps = 4096;

export function runCourseVectorCase(manifestCase, options = {}) {
  const run = runMarsReference({
    asmFile: corpusCaseFile(manifestCase),
    profile: manifestCase.profile,
    maxSteps: options.maxSteps ?? defaultMaxSteps
  });
  if (!run.ok) {
    return {
      caseId: manifestCase.caseId,
      lane: 'course-vector',
      status: 'error',
      message: `MARS exited ${run.exitCode}`,
      stderr: run.stderr.slice(0, 500)
    };
  }

  const blocks = parseCoL2Trace(run.stdout);
  const expected = manifestCase.expected;
  if (!haltReached(blocks, expected.haltPc, expected.haltWord)) {
    return {
      caseId: manifestCase.caseId,
      lane: 'course-vector',
      status: 'failed',
      message: `halt loop not reached at ${expected.haltPc} (${expected.haltWord})`
    };
  }

  const state = finalState(blocks);
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
    normalized: { gpr: Object.fromEntries([...state.gpr.entries()].sort()), dm: Object.fromEntries([...state.dm.entries()].sort()) }
  };
}

function compareExpected(expected, state) {
  const mismatches = [];
  const expectedGpr = expected.gpr ?? {};
  for (const [register, value] of Object.entries(expectedGpr)) {
    // An unwritten GPR keeps its reset value 0 (COURSE-P3-RESET-001). $gp/$sp
    // (28/29) are always present in the trace reconstruction because stable
    // MARS seeds them from the Compact* map, so a course expectation of 0 for
    // them still mismatches correctly (MARS-DIV-GPSP-001).
    const actual = state.gpr.get(register) ?? '00000000';
    if (actual !== normalize(value)) {
      mismatches.push(`$gpr[${register}]: expected ${normalize(value)}, got ${actual}`);
    }
  }
  const expectedDm = expected.dm ?? {};
  for (const [address, value] of Object.entries(expectedDm)) {
    // DM expectations are exact: an expected value with no observed write is
    // a mismatch, so a dropped store cannot pass silently.
    const normalizedAddress = normalize(address);
    const actual = state.dm.get(normalizedAddress);
    if (actual !== normalize(value)) {
      mismatches.push(`$dm[${normalizedAddress}]: expected ${normalize(value)}, got ${actual ?? 'unwritten'}`);
    }
  }
  return mismatches;
}

function normalize(token) {
  return token.toUpperCase().replace(/^0x/i, '').padStart(8, '0').slice(-8);
}
