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

/** P7 课程约定：异常处理程序入口 0x4180 需要大内存布局。 */
export const P7_COURSE_MEMORY_CONFIG = 'CompactLargeText';
/** Modified-MARS flag that aligns all GPR reset values with the course tutorial. */
export const COURSE_ZERO_GPR_FLAG = 'coZeroGpr';
/** Modified-MARS flag that enforces the tutorial load/store address map and EA overflow rules. */
export const COURSE_STRICT_DATA_FLAG = 'coStrictData';
/** Modified-MARS option prefix for accepting only the validated course halt tail as termination. */
export const COURSE_HALT_FLAG = 'coHalt';

/** 支持大文本段（容纳 0x3000→0x4180+ 异常处理程序）的内存配置名称。 */
export const LARGE_TEXT_MEMORY_CONFIGS = new Set([
  'FixedCompactLargeText',
  'CompactLargeText'
]);

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
  /** Native MARS maximum executed-instruction count (stand-alone positive integer argument). */
  maxSteps?: number;
  /** PC of the validated final `beq $0,$0,-1`; required by course-run orchestration. */
  haltPc?: number;
}

export function buildMarsArgs(
  asmUri: { fsPath: string },
  mars: string,
  mode: MarsRunMode,
  options: MarsRunOptions = {},
  memoryConfiguration = getMemoryConfiguration(asmUri as any)
): string[] {
  const profile = getProfile(asmUri as any);
  const courseTraceInvocation = isCourseTraceMarsRun(mode, options);
  const courseTraceRun = mode === 'run' && courseTraceInvocation;
  const args = options.p7RiInstruction
    ? ['-cp', `${mars}${path.delimiter}${p7InternalUnknownInstructionClassDir()}`, 'Mars', 'nc', 'mc', memoryConfiguration]
    : ['-jar', mars, 'nc', 'mc', memoryConfiguration];
  const delayedBranching = courseTraceRun
    ? profile === 'P5' || profile === 'P6' || profile === 'P7'
    : useDelayedBranching(asmUri as any);
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
    args.push(...getMipsExtraArgs(asmUri as any));
  }
  if (courseTraceInvocation) {
    // MARS reports assembly/simulation failures in text but otherwise exits with code 0.  The
    // automated oracle must make those failures visible to runTool instead of accepting an empty
    // or truncated trace as a valid execution.
    args.push('ae1', 'se1');
  }
  if (courseTraceInvocation) {
    // coStrictData is also present during course dumps: it has no simulated load/store to police,
    // but selects the exact course Compact* boundary semantics so the final legal IM/DM word is
    // assemblable and dumpable. This keeps the 4096-word hardware image aligned with MARS.
    args.push(COURSE_STRICT_DATA_FLAG);
  }
  if (courseTraceRun) {
    // Compact MARS configurations conventionally seed $gp/$sp, while the tutorial resets every
    // GPR to zero. The strict-data flag above also keeps Compact*'s extra mapped data from becoming
    // an oracle and rejects signed effective-address overflow before its wrapped address is used.
    args.push(COURSE_ZERO_GPR_FLAG);
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
  if (courseTraceRun && Number.isSafeInteger(options.maxSteps) && (options.maxSteps ?? 0) > 0) {
    // MarsLaunch checks bare register names before stand-alone integers, so decimal 0..31 would
    // be mistaken for $0..$31. Integer.decode accepts this unambiguous hexadecimal spelling.
    args.push(`0x${(options.maxSteps as number).toString(16)}`);
  }
  if (courseTraceRun && Number.isSafeInteger(options.haltPc) && (options.haltPc ?? -1) >= 0) {
    args.push(`${COURSE_HALT_FLAG}=0x${((options.haltPc as number) >>> 0).toString(16)}`);
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

export function isLargeTextMemoryConfiguration(value: string): boolean {
  return LARGE_TEXT_MEMORY_CONFIGS.has(value);
}

export function p7InternalUnknownInstructionClassDir(): string {
  return path.resolve(__dirname, '..', '..', '..', 'resources', 'mars');
}

export function p7InternalUnknownInstructionClassPath(): string {
  return path.join(p7InternalUnknownInstructionClassDir(), `${p7InternalUnknownInstructionMnemonic}.class`);
}

export async function p7RiInstructionNeeded(asmUri: { fsPath: string }): Promise<boolean> {
  if (getProfile(asmUri as any) !== 'P7') {
    return false;
  }
  try {
    return (await readTextFile(asmUri as any)).includes(p7InternalUnknownInstructionMnemonic);
  } catch {
    return false;
  }
}
