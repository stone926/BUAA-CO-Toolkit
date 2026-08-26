// @index mars-args — MARS CLI参数构建：buildMarsArgs + 内存配置/中断schedule/P7特殊模式
import * as path from 'path';
import {
  getMemoryConfiguration,
  getMipsExtraArgs,
  getProfile,
  useDelayedBranching
} from '../../config';
import { isFile, readTextFile } from '../../fsUtil';
import { p7InternalUnknownInstructionMnemonic } from '../../courseTesting/builtinAsmGenerator';
export {
  isLargeTextMemoryConfiguration,
  LARGE_TEXT_MEMORY_CONFIGS,
  LEGACY_MARS_SUPPORTED_PROFILES,
  legacyMarsConfigurationPolicyIssues,
  P7_COURSE_MEMORY_CONFIG
} from './legacyMarsPolicy';

// Stable MARS resolves bare tokens 1..31 as GPR display selectors before it considers the
// maximum-step option. 32 is the smallest positive integer which unambiguously reaches maxSteps.
const STABLE_MARS_MINIMUM_UNAMBIGUOUS_MAX_STEPS = 32;

// ────────────────────────────────────────────────────────────────────────────────
// buildMarsArgs
// ────────────────────────────────────────────────────────────────────────────────

export type MarsRunMode = 'run' | 'dumpText' | 'dumpKernel';

export interface MarsRunOptions {
  showMessages?: boolean;
  revealOutput?: boolean;
  stdin?: string;
  stdinSource?: { fsPath: string };
  courseTrace?: boolean;
  traceOutput?: boolean;
  traceLevel?: 1 | 2;
  dumpOutputFile?: { fsPath: string };
  runOutputFile?: { fsPath: string };
  interruptSchedule?: number[];
  p7RiInstruction?: boolean;
  /** Immutable directory containing the exact RI instruction class selected for this run. */
  p7InstructionClassDir?: string;
  /** Requested native MARS instruction limit; stable CLI values 1..31 are conservatively raised to 32. */
  maxSteps?: number;
  /** PC of the validated final `beq $0,$0,-1`; checked against captured coL2 output by the caller. */
  haltPc?: number;
}

export interface MarsResolvedArgumentSettings {
  profile: string;
  delayedBranching: boolean;
  extraArgs: readonly string[];
}

export function buildMarsArgs(
  asmUri: { fsPath: string },
  mars: string,
  mode: MarsRunMode,
  options: MarsRunOptions = {},
  memoryConfiguration = getMemoryConfiguration(asmUri as any),
  resolved?: MarsResolvedArgumentSettings
): string[] {
  const profile = resolved?.profile ?? getProfile(asmUri as any);
  const courseTraceInvocation = isCourseTraceMarsRun(mode, options);
  const courseTraceRun = mode === 'run' && courseTraceInvocation;
  const args = options.p7RiInstruction
    ? ['-cp', `${mars}${path.delimiter}${options.p7InstructionClassDir ?? p7InternalUnknownInstructionClassDir()}`, 'Mars', 'nc', 'mc', memoryConfiguration]
    : ['-jar', mars, 'nc', 'mc', memoryConfiguration];
  const delayedBranching = courseTraceInvocation
    ? profile === 'P5' || profile === 'P6' || profile === 'P7'
    : resolved?.delayedBranching ?? useDelayedBranching(asmUri as any);
  if (delayedBranching) {
    args.push('db');
  }
  if (options.p7RiInstruction) {
    args.push('cl', `${p7InternalUnknownInstructionMnemonic}.class`);
  }
  // Course traces are a fixed golden-model invocation. Even an otherwise harmless-looking user
  // argument can change execution, output shape, loaded classes, or self-modifying-code policy.
  // Keep user launch overrides for ordinary MARS runs, but never pass them to the oracle.
  if (!courseTraceInvocation) {
    args.push(...(resolved?.extraArgs ?? getMipsExtraArgs(asmUri as any)));
  }
  if (courseTraceInvocation) {
    // MARS reports assembly/simulation failures in text but otherwise exits with code 0.  The
    // automated oracle must make those failures visible to runTool instead of accepting an empty
    // or truncated trace as a valid execution.
    args.push('ae1', 'se1');
  }
  if (mode === 'run' && options.traceOutput) {
    args.push(options.traceLevel === 2 ? 'coL2' : 'coL1');
  }
  if (courseTraceRun && profile === 'P7') {
    // efc = enable P7 exception/interrupt handling (dispatch to 0x4180, BUAA CP0 semantics).
    if (!hasMarsArg(args, 'efc')) {
      args.push('efc');
    }
    // p7irq = inject the external interrupt so MARS defers the same instruction the CPU does.
    // The schedule holds the testbench target_pc (the instruction the CPU defers, sampled at its
    // M-stage macroscopic_pc). MARS's prevIRQ injection commits the p7irq instruction and defers
    // the next one, so fire one slot earlier (target - 4); the generator guarantees target - 4 is
    // an executed simple instruction.
    const schedule = (options.interruptSchedule ?? []).filter((pc) => Number.isFinite(pc) && pc > 0);
    if (schedule.length && !args.some((arg) => arg.toLowerCase().startsWith('p7irq='))) {
      args.push(`p7irq=${schedule.map((pc) => `0x${((pc - 4) >>> 0).toString(16)}`).join(',')}`);
    }
  }
  const maxSteps = options.maxSteps;
  if (courseTraceRun && typeof maxSteps === 'number' && Number.isSafeInteger(maxSteps) && maxSteps > 0) {
    args.push(String(Math.max(maxSteps, STABLE_MARS_MINIMUM_UNAMBIGUOUS_MAX_STEPS)));
  }
  if (mode === 'run') {
    args.push(asmUri.fsPath);
  }
  return args;
}

// ────────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────────

export function isCourseTraceMarsRun(mode: MarsRunMode, options: MarsRunOptions): boolean {
  return options.courseTrace === true || options.traceOutput === true;
}

export function hasMarsArg(args: readonly string[], value: string): boolean {
  return args.some((arg) => arg.toLowerCase() === value.toLowerCase());
}

export function p7InternalUnknownInstructionClassDir(): string {
  return path.resolve(__dirname, '..', '..', '..', 'resources', 'mars');
}

export function p7InternalUnknownInstructionClassPath(): string {
  return path.join(p7InternalUnknownInstructionClassDir(), `${p7InternalUnknownInstructionMnemonic}.class`);
}

export async function p7RiInstructionNeeded(
  asmUri: { fsPath: string },
  resolvedProfile = getProfile(asmUri as any)
): Promise<boolean> {
  if (resolvedProfile !== 'P7') {
    return false;
  }
  try {
    return (await readTextFile(asmUri as any)).includes(p7InternalUnknownInstructionMnemonic);
  } catch {
    return false;
  }
}
