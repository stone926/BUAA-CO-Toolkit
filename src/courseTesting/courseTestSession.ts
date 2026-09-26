// @index course-testing — 持续测试的原子会话租约，避免并发覆写产物

export interface CourseTestSessionLease {
  release(): void;
}

let activeSession: symbol | undefined;

/**
 * Acquire the single course-test artifact owner synchronously. JavaScript's run-to-completion
 * semantics make this an atomic boundary before either caller performs asynchronous setup.
 */
export function tryAcquireCourseTestSession(): CourseTestSessionLease | undefined {
  if (activeSession) {
    return undefined;
  }
  const token = Symbol('continuous');
  activeSession = token;
  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;
      if (activeSession === token) {
        activeSession = undefined;
      }
    }
  };
}
