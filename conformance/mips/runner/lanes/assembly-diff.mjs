/**
 * assembly-diff lane: same SourceUnit graph -> MARS image vs TS image, segment
 * by segment. Requires the builtin TS assembler, which lands in phase 5.
 *
 * The phase-0 skeleton keeps the lane discoverable and fail-closed: without a
 * TS assembler CLI the lane reports `skipped` with a stable reason instead of
 * pretending to compare anything.
 */
export function runAssemblyDiffCase(manifestCase) {
  return {
    caseId: manifestCase.caseId,
    lane: 'assembly-diff',
    status: 'skipped',
    message: 'builtin TS assembler is not available yet (phase 5); lane skeleton only'
  };
}
