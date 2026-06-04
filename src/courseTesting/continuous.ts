export type ContinuousRunStatus = 'running' | 'passed' | 'failed' | 'error' | 'stopped';

export interface ContinuousCaseLike {
  status: 'passed' | 'failed' | 'error';
}

export interface ContinuousCounts {
  total: number;
  passed: number;
  failed: number;
  errors: number;
}

export function continuousCounts(results: readonly ContinuousCaseLike[]): ContinuousCounts {
  return {
    total: results.length,
    passed: results.filter((item) => item.status === 'passed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    errors: results.filter((item) => item.status === 'error').length
  };
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
  const counts = continuousCounts(results);
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
  return stopOnFailure && results.some((item) => item.status === 'failed' || item.status === 'error');
}
