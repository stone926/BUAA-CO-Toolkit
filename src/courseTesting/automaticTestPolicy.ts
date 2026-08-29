// @index automatic-test-policy — 自动测试的内部最强策略；用户只选择 payload 指令集

import type { ProjectProfile } from '../projectProfile';
import { courseImagePolicy } from './pipeline/courseImagePolicy';
import {
  p7CourseInstructionCountMaximum,
  p7ProbeMaxScenarioCount
} from './p7Hardware';

export interface AutomaticTestPolicy {
  readonly instructionCount: number;
  readonly interrupt: boolean;
  readonly p7StressMode: 'hybrid' | 'off';
  readonly timerInterrupt: boolean;
  readonly externalInterruptIntensity: number;
  readonly timerIntensity: number;
  readonly probeScenarioCount: number;
  readonly exceptionRate: number;
  readonly exceptionTypes: readonly string[];
}

export interface ContinuousAutomaticTestPolicy {
  /** A zero-delay timer yields to the extension host without weakening coverage. */
  readonly intervalMs: number;
  /** Zero means continue until a failure or an explicit stop request. */
  readonly maxIterations: number;
  readonly stopOnFailure: boolean;
  readonly retainedPassingCases: number;
  readonly reportRetainedIterations: number;
}

export const courseHardwareMaximumPayloadInstructions =
  courseImagePolicy.maximumWords - 2;

/** Automatic tests own their reference stack and never inherit a workspace rollback mode. */
export const automaticTestEngineMode = 'builtin' as const;

/** Private wall-clock ceiling for one automatic external-tool stage. */
export const automaticExternalToolTimeoutMs = 300_000;

const p7ExceptionTypes = ['AdEL', 'AdES', 'Syscall', 'RI', 'Ov'] as const;

/**
 * The automatic path intentionally has no strength knobs. It always fills the usable course
 * image, exercises both exact-trace and property-probe P7 lanes, and covers every registered
 * exception class. The one public customization (payload instruction set) is read separately.
 */
export function automaticTestPolicy(
  profile: ProjectProfile
): AutomaticTestPolicy {
  const p7 = profile === 'P7';
  return Object.freeze({
    instructionCount: p7
      ? p7CourseInstructionCountMaximum
      : courseHardwareMaximumPayloadInstructions,
    interrupt: p7,
    p7StressMode: p7 ? 'hybrid' : 'off',
    timerInterrupt: p7,
    // These weights only distribute filler after deterministic scenario coverage. Setting them
    // to one would reduce normal-instruction diversity rather than make the suite stronger.
    externalInterruptIntensity: p7 ? 0.25 : 0,
    timerIntensity: p7 ? 0.2 : 0,
    probeScenarioCount: p7 ? p7ProbeMaxScenarioCount : 0,
    exceptionRate: p7 ? 0.08 : 0,
    exceptionTypes: p7 ? p7ExceptionTypes : []
  });
}

export const continuousAutomaticTestPolicy: ContinuousAutomaticTestPolicy = Object.freeze({
  intervalMs: 0,
  maxIterations: 0,
  stopOnFailure: true,
  retainedPassingCases: 20,
  reportRetainedIterations: 200
});
