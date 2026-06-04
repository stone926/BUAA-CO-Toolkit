import { describe, expect, it } from 'vitest';
import {
  continuousCounts,
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
