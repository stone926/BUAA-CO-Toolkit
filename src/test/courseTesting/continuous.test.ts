import { describe, expect, it } from 'vitest';
import {
  addContinuousResult,
  continuousCounts,
  continuousStatusFromCounts,
  createContinuousCounts,
  shouldStopAfterIterationCounts,
  continuousStatus,
  shouldStopAfterIteration
} from '../../courseTesting/continuous';

describe('continuous course test helpers', () => {
  it('counts passed, failed, and errored cases', () => {
    expect(continuousCounts([
      { status: 'passed' },
      { status: 'failed' },
      { status: 'error' },
      { status: 'passed' }
    ])).toEqual({
      total: 4,
      passed: 2,
      failed: 1,
      errors: 1
    });
  });

  it('updates counts incrementally for continuous case streams', () => {
    const counts = createContinuousCounts();
    expect(addContinuousResult(counts, { status: 'passed' })).toBe(counts);
    addContinuousResult(counts, { status: 'failed' });
    addContinuousResult(counts, { status: 'error' });
    expect(counts).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      errors: 1
    });
    expect(continuousStatusFromCounts(counts, false, false)).toBe('error');
    expect(shouldStopAfterIterationCounts(counts, true)).toBe(true);
  });

  it('derives monitor status from results and running state', () => {
    expect(continuousStatus([], true, false)).toBe('running');
    expect(continuousStatus([{ status: 'passed' }], false, false)).toBe('passed');
    expect(continuousStatus([{ status: 'failed' }], false, false)).toBe('failed');
    expect(continuousStatus([{ status: 'error' }], false, false)).toBe('error');
    expect(continuousStatus([{ status: 'passed' }], false, true)).toBe('stopped');
  });

  it('honors the stop-on-failure policy', () => {
    expect(shouldStopAfterIteration([{ status: 'passed' }], true)).toBe(false);
    expect(shouldStopAfterIteration([{ status: 'failed' }], true)).toBe(true);
    expect(shouldStopAfterIteration([{ status: 'error' }], true)).toBe(true);
    expect(shouldStopAfterIteration([{ status: 'failed' }], false)).toBe(false);
  });
});
