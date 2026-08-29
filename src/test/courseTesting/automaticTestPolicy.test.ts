import { describe, expect, it } from 'vitest';
import {
  automaticExternalToolTimeoutMs,
  automaticTestEngineMode,
  automaticTestPolicy,
  continuousAutomaticTestPolicy,
  courseHardwareMaximumPayloadInstructions
} from '../../courseTesting/automaticTestPolicy';
import {
  p7CourseInstructionCountMaximum,
  p7ProbeMaxScenarioCount
} from '../../courseTesting/p7Hardware';

describe('automatic test policy', () => {
  it('owns the builtin engine and fills the course hardware image for every P3-P6 run', () => {
    expect(automaticTestEngineMode).toBe('builtin');
    expect(automaticExternalToolTimeoutMs).toBe(300_000);
    expect(courseHardwareMaximumPayloadInstructions).toBe(4094);
    for (const profile of ['P3', 'P4', 'P5', 'P6'] as const) {
      expect(automaticTestPolicy(profile).instructionCount).toBe(4094);
    }
  });

  it('always enables the strongest bounded P7 plan', () => {
    const policy = automaticTestPolicy('P7');
    expect(policy).toMatchObject({
      instructionCount: p7CourseInstructionCountMaximum,
      interrupt: true,
      p7StressMode: 'hybrid',
      timerInterrupt: true,
      probeScenarioCount: p7ProbeMaxScenarioCount,
      exceptionTypes: ['AdEL', 'AdES', 'Syscall', 'RI', 'Ov']
    });
  });

  it('keeps continuous testing unbounded, failure-stopping, and storage-bounded', () => {
    expect(continuousAutomaticTestPolicy).toEqual({
      intervalMs: 0,
      maxIterations: 0,
      stopOnFailure: true,
      retainedPassingCases: 20,
      reportRetainedIterations: 200
    });
  });
});
