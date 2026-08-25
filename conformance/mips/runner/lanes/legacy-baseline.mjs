/** legacy-course-executor baseline against reviewed corpus expectations and deterministic goldens. */
import {
  finalState,
  haltReached,
  legacyCourseExecutorRole,
  nativeCourseHaltReached,
  normalizerRevision,
  parseCoL2Trace,
  runMarsReference,
  runnerRevision
} from '../marsRunner.mjs';
import {
  corpusCaseFile,
  corpusCaseSha256,
  loadMarsGolden,
  recordMarsGolden
} from '../caseManifest.mjs';
import {
  compareExpected,
  normalizedState,
  normalizedWrites,
  sameNormalizedState
} from '../stateOracle.mjs';

const defaultMaxSteps = 4096;

function expectedProvenance(manifestCase, run, sourceSha256) {
  return {
    role: legacyCourseExecutorRole,
    referenceFileName: run.reference.fileName,
    referenceSha256: run.reference.verifiedSha256,
    sourceFile: manifestCase.file,
    sourceSha256,
    sourceHashNormalization: 'utf8-lf-v1',
    sourceTag: run.reference.sourceTag,
    sourceCommit: run.reference.sourceCommit,
    runnerRevision,
    normalizerRevision,
    profile: manifestCase.profile,
    maxSteps: run.effectiveMaxSteps,
    cliOptions: run.cliOptions,
    corpusReviewer: manifestCase.provenance.reviewer,
    corpusReviewedAt: manifestCase.provenance.reviewedAt
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function runLegacyBaselineCase(manifestCase, options = {}) {
  const maxSteps = options.maxSteps ?? defaultMaxSteps;
  const asmFile = corpusCaseFile(manifestCase);
  const sourceSha256BeforeRun = corpusCaseSha256(manifestCase);
  const run = runMarsReference({
    asmFile,
    profile: manifestCase.profile,
    maxSteps,
    role: legacyCourseExecutorRole,
    haltPc: manifestCase.expected.haltPc
  });
  if (!run.ok) {
    return {
      caseId: manifestCase.caseId,
      lane: 'legacy-baseline',
      status: 'error',
      message: `legacy course executor failed: ${run.error ?? `exit ${run.exitCode}`}`,
      stderr: run.stderr.slice(0, 500)
    };
  }
  const sourceSha256AfterRun = corpusCaseSha256(manifestCase);
  if (sourceSha256BeforeRun !== sourceSha256AfterRun) {
    return {
      caseId: manifestCase.caseId,
      lane: 'legacy-baseline',
      status: 'error',
      message: 'assembly source changed while the reference was running'
    };
  }

  let blocks;
  try {
    blocks = parseCoL2Trace(run.stdout);
  } catch (error) {
    return { caseId: manifestCase.caseId, lane: 'legacy-baseline', status: 'error', message: error.message };
  }
  const expected = manifestCase.expected;
  if (!haltReached(blocks, expected.haltPc, expected.haltWord) || !nativeCourseHaltReached(run.stdout, expected.haltPc)) {
    return {
      caseId: manifestCase.caseId,
      lane: 'legacy-baseline',
      status: 'failed',
      message: `native course halt was not proven at ${expected.haltPc} (${expected.haltWord})`
    };
  }

  // The legacy executor uses coZeroGpr; no Compact* $gp/$sp seed is injected.
  const state = finalState(blocks);
  const expectationMismatches = compareExpected(expected, state);
  if (expectationMismatches.length > 0) {
    return {
      caseId: manifestCase.caseId,
      lane: 'legacy-baseline',
      status: 'failed',
      message: `state differs from reviewed corpus expectation: ${expectationMismatches.join('; ')}`
    };
  }

  const normalized = normalizedState(state);
  const writes = normalizedWrites(state);
  const provenance = expectedProvenance(manifestCase, run, sourceSha256AfterRun);
  if (options.recordGolden) {
    const goldenFile = recordMarsGolden(manifestCase.caseId, {
      schemaRevision: 1,
      caseId: manifestCase.caseId,
      provenance,
      normalized,
      writes
    });
    return {
      caseId: manifestCase.caseId,
      lane: 'legacy-baseline',
      status: 'recorded',
      message: `deterministic marsGolden written to ${goldenFile}`,
      normalized,
      writes
    };
  }

  let recorded;
  try {
    recorded = loadMarsGolden(manifestCase.caseId);
  } catch (error) {
    return { caseId: manifestCase.caseId, lane: 'legacy-baseline', status: 'error', message: error.message };
  }
  if (!recorded) {
    return {
      caseId: manifestCase.caseId,
      lane: 'legacy-baseline',
      status: 'error',
      message: `required reviewed marsGolden is missing for ${manifestCase.caseId}`
    };
  }
  if (!sameJson(recorded.provenance, provenance)) {
    return {
      caseId: manifestCase.caseId,
      lane: 'legacy-baseline',
      status: 'failed',
      message: 'marsGolden provenance/fingerprint is stale',
      expected: provenance,
      actual: recorded.provenance
    };
  }
  const comparison = sameNormalizedState(recorded.normalized, recorded.writes, state);
  if (!comparison.matches) {
    return {
      caseId: manifestCase.caseId,
      lane: 'legacy-baseline',
      status: 'failed',
      message: 'state or write set differs from recorded marsGolden',
      expected: { normalized: recorded.normalized, writes: recorded.writes },
      actual: { normalized: comparison.normalized, writes: comparison.writes }
    };
  }

  return {
    caseId: manifestCase.caseId,
    lane: 'legacy-baseline',
    status: 'passed',
    message: 'matches reviewed corpus expectation and fingerprinted marsGolden',
    normalized,
    writes,
    referenceSha256: run.reference.verifiedSha256
  };
}
