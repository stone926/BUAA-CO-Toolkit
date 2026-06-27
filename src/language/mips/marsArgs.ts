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
  dumpOutputFile?: { fsPath: string };
  runOutputFile?: { fsPath: string };
  interruptSchedule?: number[];
  p7RiInstruction?: boolean;
}

export function buildMarsArgs(
  asmUri: { fsPath: string },
  mars: string,
  mode: MarsRunMode,
  options: MarsRunOptions = {},
  memoryConfiguration = getMemoryConfiguration(asmUri as any)
): string[] {
  const args = options.p7RiInstruction
    ? ['-cp', `${mars}${path.delimiter}${p7InternalUnknownInstructionClassDir()}`, 'Mars', 'nc', 'mc', memoryConfiguration]
    : ['-jar', mars, 'nc', 'mc', memoryConfiguration];
  if (useDelayedBranching(asmUri as any)) {
    args.push('db');
  }
  if (options.p7RiInstruction) {
    args.push('cl', `${p7InternalUnknownInstructionMnemonic}.class`);
  }
  args.push(...getMipsExtraArgs(asmUri as any));
  if (mode === 'run' && options.traceOutput && !hasMarsArg(args, 'coL1')) {
    args.push('coL1');
  }
  if (mode === 'run' && getProfile(asmUri as any) === 'P7' && isCourseTraceMarsRun(mode, options)) {
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
