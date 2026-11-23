import type { P7ProbeScope } from './builtinAsm/types';

export type ContinuousRunStatus = 'running' | 'passed' | 'failed' | 'error' | 'stopped';

export interface ContinuousCaseLike {
  status: 'passed' | 'failed' | 'error';
  probeScope?: P7ProbeScope;
  cancelled?: boolean;
}

export function isCourseTestProblem(result: ContinuousCaseLike): boolean {
  return !result.cancelled && result.probeScope !== 'special-timer-exl' && result.status !== 'passed';
}

export interface ContinuousCounts {
  total: number;
  passed: number;
  failed: number;
  errors: number;
}

export function createContinuousCounts(): ContinuousCounts {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    errors: 0
  };
}

export function addContinuousResult(counts: ContinuousCounts, result: ContinuousCaseLike): ContinuousCounts {
  // Advisory experiments retain their own case history and separate results table.
  if (result.cancelled || result.probeScope === 'special-timer-exl') return counts;
  counts.total++;
  switch (result.status) {
    case 'passed':
      counts.passed++;
      break;
    case 'failed':
      counts.failed++;
      break;
    case 'error':
      counts.errors++;
      break;
  }
  return counts;
}

export function continuousCounts(results: readonly ContinuousCaseLike[]): ContinuousCounts {
  const counts = createContinuousCounts();
  for (const result of results) {
    addContinuousResult(counts, result);
  }
  return counts;
}

export function continuousStatus(
  results: readonly ContinuousCaseLike[],
  running: boolean,
  stopRequested: boolean
): ContinuousRunStatus {
  if (stopRequested && !running) {
    return 'stopped';
  }
  if (running) {
    return 'running';
  }
  return continuousStatusFromCounts(continuousCounts(results), false, false);
}

export function continuousStatusFromCounts(
  counts: ContinuousCounts,
  running: boolean,
  stopRequested: boolean
): ContinuousRunStatus {
  if (stopRequested && !running) {
    return 'stopped';
  }
  if (running) {
    return 'running';
  }
  if (counts.errors) {
    return 'error';
  }
  if (counts.failed) {
    return 'failed';
  }
  return 'passed';
}

export function shouldStopAfterIteration(
  results: readonly ContinuousCaseLike[],
  stopOnFailure: boolean
): boolean {
  return shouldStopAfterIterationCounts(continuousCounts(results), stopOnFailure);
}

export function shouldStopAfterIterationCounts(
  counts: ContinuousCounts,
  stopOnFailure: boolean
): boolean {
  return stopOnFailure && (counts.failed > 0 || counts.errors > 0);
}

export function pruneContinuousIterations<T extends { status: ContinuousRunStatus }>(
  iterations: readonly T[],
  retainedIterations: number
): T[] {
  const limit = Math.floor(retainedIterations);
  if (!Number.isFinite(limit) || limit <= 0 || iterations.length <= limit) {
    return [...iterations];
  }
  const latest = iterations.slice(0, limit);
  const olderProblems = iterations.slice(limit).filter((iteration) => iteration.status !== 'passed');
  return [...latest, ...olderProblems];
}
