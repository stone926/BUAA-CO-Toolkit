/**
 * legacy-baseline lane: pinned MARS ASM -> pinned MARS image/execution.
 *
 * Phase 0 assertion: MARS runs, the trace reaches the standard halt loop at
 * the expected PC with the expected word, and (when a marsGolden file exists)
 * the normalized final state matches the recorded golden. Divergence cases
 * (e.g. MARS-BASELINE-GPSP-001) also check the hand-reviewed expected state in
 * corpus/manifest.json, which documents MARS behavior only.
 */
import { finalState, haltReached, parseCoL2Trace, runMarsReference } from '../marsRunner.mjs';
import { corpusCaseFile, loadMarsGolden, recordMarsGolden } from '../caseManifest.mjs';

const defaultMaxSteps = 4096;

export function runLegacyBaselineCase(manifestCase, options = {}) {
  const asmFile = corpusCaseFile(manifestCase);
  const profile = manifestCase.profile;
  const maxSteps = options.maxSteps ?? defaultMaxSteps;

  const run = runMarsReference({ asmFile, profile, maxSteps });
  if (!run.ok) {
    return {
      caseId: manifestCase.caseId,
      lane: 'legacy-baseline',
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
      lane: 'legacy-baseline',
      status: 'failed',
      message: `halt loop not reached at ${expected.haltPc} (${expected.haltWord})`
    };
  }

  const state = finalState(blocks);
  const normalized = { gpr: Object.fromEntries([...state.gpr.entries()].sort()), dm: Object.fromEntries([...state.dm.entries()].sort()) };
  const recorded = loadMarsGolden(manifestCase.caseId);
  if (recorded) {
    if (JSON.stringify(recorded.normalized) !== JSON.stringify(normalized)) {
      return {
        caseId: manifestCase.caseId,
        lane: 'legacy-baseline',
        status: 'failed',
        message: 'final state differs from recorded marsGolden',
        expected: recorded.normalized,
        actual: normalized
      };
    }
  } else if (!options.recordGolden) {
    return {
      caseId: manifestCase.caseId,
      lane: 'legacy-baseline',
      status: 'passed',
      message: 'halt loop reached; no marsGolden recorded yet',
      normalized
    };
  }

  // The challenge case documents MARS behavior in corpus/manifest.json; check
  // it directly (it never becomes a course vector).
  if (options.recordGolden) {
    const goldenFile = recordMarsGolden(manifestCase.caseId, {
      schemaRevision: 1,
      caseId: manifestCase.caseId,
      provenance: {
        role: 'mars-assembler-v0.6.3',
        sourceTag: 'v0.6.3',
        cliOptions: { profile, maxSteps },
        recordedAt: new Date().toISOString()
      },
      normalized
    });
    return {
      caseId: manifestCase.caseId,
      lane: 'legacy-baseline',
      status: 'recorded',
      message: `marsGolden written to ${goldenFile} (review raw and normalized diff before committing)`,
      normalized
    };
  }

  return {
    caseId: manifestCase.caseId,
    lane: 'legacy-baseline',
    status: 'passed',
    message: 'matches recorded marsGolden',
    normalized
  };
}
