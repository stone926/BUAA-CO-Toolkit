import { describe, expect, it } from 'vitest';
import {
  activeCourseTestSessionKind,
  tryAcquireCourseTestSession
} from '../../courseTesting/courseTestSession';

describe('shared course-test session lease', () => {
  it('atomically excludes batch and continuous owners in both directions', () => {
    const batch = tryAcquireCourseTestSession('batch');
    expect(batch).toBeDefined();
    expect(activeCourseTestSessionKind()).toBe('batch');
    expect(tryAcquireCourseTestSession('continuous')).toBeUndefined();
    batch!.release();
    batch!.release();

    const continuous = tryAcquireCourseTestSession('continuous');
    expect(continuous).toBeDefined();
    expect(activeCourseTestSessionKind()).toBe('continuous');
    expect(tryAcquireCourseTestSession('batch')).toBeUndefined();
    continuous!.release();
    expect(activeCourseTestSessionKind()).toBeUndefined();
  });
});
