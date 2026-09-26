import { describe, expect, it } from 'vitest';
import {
  tryAcquireCourseTestSession
} from '../../courseTesting/courseTestSession';

describe('course-test session lease', () => {
  it('excludes concurrent owners and ignores releases from an older session', () => {
    const first = tryAcquireCourseTestSession();
    expect(first).toBeDefined();
    expect(tryAcquireCourseTestSession()).toBeUndefined();
    first!.release();
    first!.release();

    const second = tryAcquireCourseTestSession();
    expect(second).toBeDefined();
    first!.release();
    expect(tryAcquireCourseTestSession()).toBeUndefined();
    second!.release();

    const third = tryAcquireCourseTestSession();
    expect(third).toBeDefined();
    third!.release();
  });
});
