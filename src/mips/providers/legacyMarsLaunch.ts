// @index mips-providers — Legacy MARS 无副作用 launch preflight 与不可变配置快照
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getJava,
  getMemoryConfiguration,
  getMipsExtraArgs,
  getMarsJar,
  getProfile,
  getRunTimeout,
  useDelayedBranching
} from '../../config';
import {
  isCourseTraceMarsRun,
  p7InternalUnknownInstructionClassPath,
  p7RiInstructionNeeded,
  type MarsRunMode,
  type MarsRunOptions
} from '../../language/mips/marsArgs';
import { legacyMarsConfigurationPolicyIssues } from '../../language/mips/legacyMarsPolicy';
import type { CapabilityDiagnostic, ResolvedEngineRun } from './contracts';

export interface ResolvedLegacyMarsLaunch extends Omit<ResolvedEngineRun, 'runtime'> {
  /** Legacy MARS is always a Java process; keep the narrower runtime for old consumers. */
  runtime: { kind: 'java'; command: string };
  sourcePath: string;
  mode: MarsRunMode;
  configuredMars: string;
  delayedBranching: boolean;
  extraArgs: string[];
}

export interface LegacyMarsLaunchResolution {
  diagnostics: CapabilityDiagnostic[];
  launch?: ResolvedLegacyMarsLaunch;
}

/**
 * Resolve every external capability and configuration value before registry/output writes.
 * The returned snapshot is subsequently consumed by the legacy process runner;
 * it must not re-read settings.
 */
export async function resolveLegacyMarsLaunch(
  sourceUri: vscode.Uri,
  mode: MarsRunMode,
  options: MarsRunOptions
): Promise<LegacyMarsLaunchResolution> {
  const diagnostics: CapabilityDiagnostic[] = [];
  const profile = getProfile(sourceUri);
  const configuredMars = getMarsJar(sourceUri);
  const java = getJava(sourceUri);
  const memoryConfiguration = getMemoryConfiguration(sourceUri);
  const wallClockMs = getRunTimeout(sourceUri);
  const courseInvocation = isCourseTraceMarsRun(mode, options);

  diagnostics.push(...legacyMarsConfigurationPolicyIssues(
    profile,
    memoryConfiguration,
    mode,
    courseInvocation
  ));
  if (!configuredMars) {
    diagnostics.push(diagnostic(
      'legacy-mars.jar-not-configured',
      'MARS jar 未配置。请设置 co.toolchain.mars 或 co.toolchain.marsP7',
      'legacy-mars'
    ));
  } else if (!await readableRegularFile(configuredMars)) {
    diagnostics.push(diagnostic(
      'legacy-mars.jar-unreadable',
      `MARS jar 不存在、不可读或不是普通文件：${configuredMars}`,
      'legacy-mars'
    ));
  }
  if (!java || !await executableAvailable(java)) {
    diagnostics.push(diagnostic(
      'legacy-mars.java-unavailable',
      `Java 命令不存在或不可执行：${java || '(empty)'}`,
      'java-runtime'
    ));
  }
  if (!Number.isSafeInteger(wallClockMs) || wallClockMs <= 0) {
    diagnostics.push(diagnostic(
      'legacy-mars.timeout-invalid',
      `MARS timeout 必须是正安全整数，当前为 ${wallClockMs}`,
      'bounded-execution'
    ));
  }

  if (mode === 'run' && courseInvocation) {
    if (!Number.isSafeInteger(options.maxSteps) || (options.maxSteps ?? 0) <= 0) {
      diagnostics.push(diagnostic(
        'legacy-mars.max-steps-required',
        '课程 MARS 黄金模型必须提供正整数 maxSteps',
        'bounded-execution'
      ));
    }
    if (!Number.isSafeInteger(options.haltPc)
      || (options.haltPc ?? -1) < 0
      || (options.haltPc ?? 0) > 0xffff_ffff) {
      diagnostics.push(diagnostic(
        'legacy-mars.halt-pc-required',
        '课程 MARS 黄金模型必须提供由机器码 dump 验证得到的 32 位 haltPc',
        'halt-loop-detection'
      ));
    }
  }

  const sourceReadable = await readableRegularFile(sourceUri.fsPath);
  if (!sourceReadable) {
    diagnostics.push(diagnostic(
      'legacy-mars.source-unreadable',
      `ASM 源文件不存在、不可读或不是普通文件：${sourceUri.fsPath}`,
      'source-input'
    ));
  }
  const p7RiInstruction = options.p7RiInstruction
    ?? (sourceReadable ? await p7RiInstructionNeeded(sourceUri, profile) : false);
  if (profile === 'P7') {
    if (p7RiInstruction && !await readableRegularFile(p7InternalUnknownInstructionClassPath())) {
      diagnostics.push(diagnostic(
        'legacy-mars.p7-ri-class-unavailable',
        `P7 RI 异常测试缺少内部 instruction class：${p7InternalUnknownInstructionClassPath()}`,
        'p7-ri-instruction'
      ));
    }
  }

  if (diagnostics.length || !configuredMars) {
    return { diagnostics };
  }
  return {
    diagnostics: [],
    launch: {
      sourcePath: path.resolve(sourceUri.fsPath),
      mode,
      profile,
      configuredMars: path.resolve(configuredMars),
      memoryConfiguration,
      runtime: { kind: 'java', command: java },
      wallClockMs,
      p7RiInstruction,
      delayedBranching: useDelayedBranching(sourceUri),
      extraArgs: [...getMipsExtraArgs(sourceUri)]
    }
  };
}

export function launchResolutionMessage(resolution: LegacyMarsLaunchResolution): string {
  return resolution.diagnostics.map((item) => `[${item.code}] ${item.message}`).join('\n');
}

async function readableRegularFile(file: string): Promise<boolean> {
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
      return (await handle.stat()).isFile();
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function executableAvailable(command: string): Promise<boolean> {
  const candidates = executableCandidates(command);
  for (const candidate of candidates) {
    try {
      const stat = await fs.promises.stat(candidate);
      if (!stat.isFile()) continue;
      await fs.promises.access(candidate, process.platform === 'win32' ? fs.constants.R_OK : fs.constants.X_OK);
      return true;
    } catch {
      // Try the next PATH/PATHEXT candidate.
    }
  }
  return false;
}

function executableCandidates(command: string): string[] {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return [path.resolve(command)];
  }
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  const hasExtension = path.extname(command).length > 0;
  const extensions = process.platform === 'win32' && !hasExtension
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  return directories.flatMap((directory) => extensions.map((extension) => path.join(directory, `${command}${extension}`)));
}

function diagnostic(code: string, message: string, capability: string): CapabilityDiagnostic {
  return { code, message, capability };
}
