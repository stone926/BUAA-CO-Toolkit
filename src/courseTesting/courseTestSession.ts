// @index course-testing — batch/continuous shared-session lease for collision-free artifacts

export type CourseTestSessionKind = 'batch' | 'continuous';

export interface CourseTestSessionLease {
  readonly kind: CourseTestSessionKind;
  release(): void;
}

interface ActiveCourseTestSession {
  readonly kind: CourseTestSessionKind;
  readonly token: symbol;
}

let activeSession: ActiveCourseTestSession | undefined;

/**
 * Acquire the single course-test artifact owner synchronously. JavaScript's run-to-completion
 * semantics make this an atomic boundary before either caller performs asynchronous setup.
 */
export function tryAcquireCourseTestSession(
  kind: CourseTestSessionKind
): CourseTestSessionLease | undefined {
  if (activeSession) {
    return undefined;
  }
  const token = Symbol(kind);
  activeSession = { kind, token };
  let released = false;
  return {
    kind,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      if (activeSession?.token === token) {
        activeSession = undefined;
      }
    }
  };
}

export function activeCourseTestSessionKind(): CourseTestSessionKind | undefined {
  return activeSession?.kind;
}
