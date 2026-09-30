// @index mips-providers — 原版 MARS 无副作用 launch preflight 与配置快照（保留历史 API 名）
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
  officialMarsUnsupportedReason,
  type MarsRunMode,
  type MarsRunOptions
} from '../../language/mips/marsArgs';
import { officialMarsConfigurationPolicyIssues } from '../../language/mips/legacyMarsPolicy';
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
  const courseInvocation = options.courseTrace === true || options.traceOutput === true;
  const extraArgs = [...getMipsExtraArgs(sourceUri)];
  const delayedBranching = useDelayedBranching(sourceUri);

  diagnostics.push(...officialMarsConfigurationPolicyIssues(
    profile,
    memoryConfiguration,
    mode,
    courseInvocation
  ));
  const unsupported = officialMarsUnsupportedReason(mode, options, extraArgs);
  if (unsupported) {
    diagnostics.push(diagnostic('official-mars.course-semantics-unsupported', unsupported, 'course-semantics'));
  }
  // Reject unsupported semantics before even probing external tools or reading source files.
  if (diagnostics.length) return { diagnostics };
  if (!configuredMars) {
    diagnostics.push(diagnostic(
      'legacy-mars.jar-not-configured',
      '原版 MARS jar 未配置。请设置 co.toolchain.mars',
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

  const sourceReadable = await readableRegularFile(sourceUri.fsPath);
  if (!sourceReadable) {
    diagnostics.push(diagnostic(
      'legacy-mars.source-unreadable',
      `ASM 源文件不存在、不可读或不是普通文件：${sourceUri.fsPath}`,
      'source-input'
    ));
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
      p7RiInstruction: false,
      delayedBranching,
      extraArgs
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
