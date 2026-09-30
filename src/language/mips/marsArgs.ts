// @index mars-args — 原版 MARS CLI 参数与不支持的课程语义检查
import * as path from 'path';
import { resourcePath } from '../../resourcePaths';
import {
  getMemoryConfiguration,
  getMipsExtraArgs,
  getProfile,
  useDelayedBranching
} from '../../config';
import { readTextFile } from '../../fsUtil';
import {
  p7InternalUnknownInstructionMnemonic,
  sourceUnitsUseP7RiInstruction
} from '../../courseTesting/p7RiInstruction';
import { OFFICIAL_MARS_MEMORY_CONFIGURATIONS } from './legacyMarsPolicy';
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
  if ((resolved?.profile ?? getProfile(asmUri as any)) === 'P7') {
    throw new Error('原版 MARS 不支持 P7 课程异常/中断语义；请使用 builtin 引擎。');
  }
  const extraArgs = resolved?.extraArgs ?? getMipsExtraArgs(asmUri as any);
  const unsupported = officialMarsUnsupportedReason(mode, options, extraArgs);
  if (unsupported) throw new Error(unsupported);
  if (!(OFFICIAL_MARS_MEMORY_CONFIGURATIONS as readonly string[]).includes(memoryConfiguration)) {
    throw new Error(`原版 MARS 不支持内存配置 ${memoryConfiguration}；课程汇编和执行请使用 builtin 引擎。`);
  }
  const args = ['-jar', mars, 'nc', 'mc', memoryConfiguration];
  const delayedBranching = resolved?.delayedBranching ?? useDelayedBranching(asmUri as any);
  if (delayedBranching) {
    args.push('db');
  }
  args.push(...extraArgs);
  // Official MARS otherwise exits successfully after assembly or simulation errors.
  // Append these after user options so ae0/se0 cannot silently disable failure reporting.
  // Keep simulator diagnostics separate from user syscall output.
  args.push('me', 'ae1', 'se1');
  const maxSteps = options.maxSteps;
  if (mode === 'run' && typeof maxSteps === 'number' && Number.isSafeInteger(maxSteps) && maxSteps > 0) {
    args.push(String(Math.max(maxSteps, STABLE_MARS_MINIMUM_UNAMBIGUOUS_MAX_STEPS)));
  }
  if (mode === 'run') {
    args.push(asmUri.fsPath);
  }
  return args;
}

/** Shared by preflight and argument construction, including callers with a saved snapshot. */
export function officialMarsUnsupportedReason(
  mode: MarsRunMode,
  options: MarsRunOptions,
  extraArgs: readonly string[] = []
): string | undefined {
  if (isCourseTraceMarsRun(mode, options) || mode === 'dumpKernel'
    || options.p7RiInstruction === true || options.p7InstructionClassDir !== undefined
    || (options.interruptSchedule?.length ?? 0) > 0) {
    return '原版 MARS 不支持课程提交 Trace、P7 课程异常/中断或自定义 instruction class；请使用 builtin 引擎。';
  }
  const forbidden = extraArgs.find((arg) => /^(?:coL\d+|coZeroGpr|coStrictData|coHalt(?:=.*)?|coKernel(?:=.*)?|coERR|ig|cc|ccw|efc|p7irq(?:=.*)?|cl|-cp|-classpath|--class-path|.*\.class|FixedCompactLargeText|CompactLargeText)$/i.test(arg));
  if (forbidden) {
    return `原版 MARS 不支持参数 ${forbidden}；请移除改版参数，课程汇编和执行请使用 builtin 引擎。`;
  }
  return undefined;
}

/** Official MARS dump scans below its upper bound; include the final requested word explicitly. */
export function marsInclusiveDumpRange(firstWordAddress: number, lastWordAddress: number): string {
  if (!Number.isSafeInteger(firstWordAddress) || !Number.isSafeInteger(lastWordAddress)
    || firstWordAddress < 0 || lastWordAddress > 0xffff_fffb
    || firstWordAddress > lastWordAddress || firstWordAddress % 4 !== 0 || lastWordAddress % 4 !== 0) {
    throw new Error('MARS dump range 必须是递增且可表示含端点上界的 32 位 word 地址');
  }
  const format = (value: number) => `0x${value.toString(16).padStart(8, '0')}`;
  return `${format(firstWordAddress)}-${format(lastWordAddress + 4)}`;
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
  return resourcePath('mars');
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
    const text = await readTextFile(asmUri as any);
    return sourceUnitsUseP7RiInstruction(resolvedProfile, [{ id: asmUri.fsPath, text }]);
  } catch {
    return false;
  }
}
