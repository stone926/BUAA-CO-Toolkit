// @index verilog-iverilog-runtime — bundled Windows/macOS Icarus 定位、子进程环境与会话级预检
import * as path from 'path';
import { isDirectory, isFile } from '../nodeFs';
import { dedupePaths } from '../pathUtils';
import { runProcessCore, RunProcessCoreResult } from '../processCore';

export interface IverilogRuntime {
  target: IverilogRuntimeTarget;
  rootDir: string;
  binDir: string;
  libDir: string;
  iverilogPath: string;
  vvpPath: string;
}

export type IverilogRuntimeTarget =
  | 'win32-x64'
  | 'darwin-arm64'
  | 'darwin-x64';

export interface IverilogRuntimeTargetDescriptor {
  readonly target: IverilogRuntimeTarget;
  readonly iverilogExecutable: string;
  readonly vvpExecutable: string;
}

export type IverilogRuntimeErrorCode =
  | 'unsupported-platform'
  | 'missing-runtime'
  | 'preflight-failed';

export class IverilogRuntimeError extends Error {
  constructor(
    readonly code: IverilogRuntimeErrorCode,
    message: string,
    readonly missingPaths: readonly string[] = [],
    readonly result?: RunProcessCoreResult
  ) {
    super(message);
    this.name = 'IverilogRuntimeError';
  }
}

export interface IverilogPreflightOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const bundledIverilogEnvironmentOverrides = new Set([
  'iverilog_iconfig'
]);

export interface IverilogPreflightResult {
  runtime: IverilogRuntime;
  result: RunProcessCoreResult;
  version: string;
}

/**
 * Keep Verilog includes compatible with ordinary source trees while compiler
 * processes run from the shared simulation output directory. Icarus disables
 * source-relative includes by default, so both that mode and the workspace
 * root search path must be explicit.
 */
export function buildIverilogIncludeArgs(
  workspaceRoot: string,
  sourceFiles: readonly string[] = []
): string[] {
  const root = workspaceRoot.trim();
  if (!root) {
    throw new RangeError('workspaceRoot must not be empty');
  }
  const includeDirectories = dedupePaths([
    ...sourceFiles
      .map((file) => file.trim())
      .filter(Boolean)
      .map((file) => path.dirname(file)),
    root
  ]);
  return [
    '-grelative-include',
    ...includeDirectories.flatMap((directory) => ['-I', directory])
  ];
}

const preflightResultsByRoot = new Map<string, IverilogPreflightResult>();
const pendingPreflightsByRoot = new Map<string, Promise<IverilogPreflightResult>>();
const defaultPreflightTimeoutMs = 10_000;

/** Map a host platform/architecture pair to its bundled runtime layout. */
export function resolveIverilogRuntimeTarget(
  platform: NodeJS.Platform,
  arch: string
): IverilogRuntimeTargetDescriptor {
  if (platform === 'win32' && arch === 'x64') {
    return {
      target: 'win32-x64',
      iverilogExecutable: 'iverilog.exe',
      vvpExecutable: 'vvp.exe'
    };
  }
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return {
      target: `darwin-${arch}`,
      iverilogExecutable: 'iverilog',
      vvpExecutable: 'vvp'
    };
  }
  throw new IverilogRuntimeError(
    'unsupported-platform',
    `当前平台没有对应的 bundled Icarus 包（当前 ${platform}-${arch}）`
  );
}

export function resolveIverilogRuntime(
  extensionRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): IverilogRuntime {
  const trimmedRoot = extensionRoot.trim();
  if (!trimmedRoot) {
    throw new IverilogRuntimeError(
      'missing-runtime',
      '缺少扩展安装根路径，无法定位内置 Icarus Verilog'
    );
  }
  const descriptor = resolveIverilogRuntimeTarget(platform, arch);
  const rootDir = path.resolve(trimmedRoot, 'vendor', 'iverilog', descriptor.target);
  const binDir = path.join(rootDir, 'bin');
  return {
    target: descriptor.target,
    rootDir,
    binDir,
    libDir: path.join(rootDir, 'lib', 'ivl'),
    iverilogPath: path.join(binDir, descriptor.iverilogExecutable),
    vvpPath: path.join(binDir, descriptor.vvpExecutable)
  };
}

/** Override the Homebrew Cellar prefix embedded in macOS Icarus bottles. */
export function buildIverilogRuntimeArgs(runtime: IverilogRuntime): string[] {
  return runtime.target === 'win32-x64'
    ? []
    : ['-B', runtime.libDir];
}

/** Inherit the host environment and only prepend the bundled bin directory. */
export function buildIverilogEnvironment(
  runtime: IverilogRuntime,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const pathEntry = Object.entries(baseEnv).find(([key]) => key.toLowerCase() === 'path');
  const pathKey = pathEntry?.[0] ?? 'PATH';
  const inheritedPath = pathEntry?.[1];
  const environment = Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => {
      const normalized = key.toLowerCase();
      return normalized !== 'path' && !bundledIverilogEnvironmentOverrides.has(normalized);
    })
  );
  return {
    ...environment,
    [pathKey]: inheritedPath
      ? `${runtime.binDir}${path.delimiter}${inheritedPath}`
      : runtime.binDir
  };
}

/**
 * Validate the bundled layout and run `iverilog -V` once per extension root.
 * Failed probes are evicted so a later operation can retry. Concurrent callers
 * share the probe but keep independent wait cancellation and timeouts.
 */
export async function preflightIverilogRuntime(
  extensionRoot: string,
  options: IverilogPreflightOptions = {}
): Promise<IverilogPreflightResult> {
  const runtime = resolveIverilogRuntime(extensionRoot);
  const normalizedRoot = path.normalize(runtime.rootDir);
  const key = runtime.target === 'win32-x64'
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
  const cached = preflightResultsByRoot.get(key);
  if (cached) {
    return cached;
  }

  let pending = pendingPreflightsByRoot.get(key);
  if (!pending) {
    pending = performPreflight(runtime, defaultPreflightTimeoutMs).then((result) => {
      preflightResultsByRoot.set(key, result);
      return result;
    }).finally(() => {
      pendingPreflightsByRoot.delete(key);
    });
    pendingPreflightsByRoot.set(key, pending);
  }
  return await waitForSharedPreflight(pending, options);
}

async function performPreflight(
  runtime: IverilogRuntime,
  timeoutMs: number
): Promise<IverilogPreflightResult> {
  const requiredFiles = [runtime.iverilogPath, runtime.vvpPath];
  const fileChecks = await Promise.all(requiredFiles.map(async (file) => ({ file, ok: await isFile(file) })));
  const libExists = await isDirectory(runtime.libDir);
  const missingPaths = [
    ...fileChecks.filter((entry) => !entry.ok).map((entry) => entry.file),
    ...(libExists ? [] : [runtime.libDir])
  ];
  if (missingPaths.length) {
    throw new IverilogRuntimeError(
      'missing-runtime',
      `内置 Icarus Verilog 运行时不完整，缺少：${missingPaths.join(', ')}`,
      missingPaths
    );
  }

  const result = await runProcessCore(runtime.iverilogPath, [
    ...buildIverilogRuntimeArgs(runtime),
    '-V'
  ], {
    cwd: runtime.binDir,
    env: buildIverilogEnvironment(runtime),
    timeoutMs
  });
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const loadFailure = /(?:error:\s*)?Failed to open\b[^\r\n]*/i.exec(combinedOutput)?.[0];
  if (!result.ok || loadFailure) {
    const detail = loadFailure
      ?? (result.stopReason === 'aborted'
      ? '预检已取消'
      : result.timedOut
        ? '预检超时'
        : firstNonEmptyLine(result.stderr) ?? `退出码 ${result.exitCode ?? 'unknown'}`);
    throw new IverilogRuntimeError(
      'preflight-failed',
      `内置 Icarus Verilog 预检失败：${detail}`,
      [],
      result
    );
  }

  return {
    runtime,
    result,
    version: parseIverilogVersion(combinedOutput)
  };
}

/** Let each caller stop waiting without cancelling the shared runtime probe. */
async function waitForSharedPreflight(
  pending: Promise<IverilogPreflightResult>,
  options: IverilogPreflightOptions
): Promise<IverilogPreflightResult> {
  if (options.signal?.aborted) {
    throw preflightWaitError('预检已取消');
  }
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0
    ? options.timeoutMs
    : undefined;
  if (!options.signal && timeoutMs === undefined) {
    return await pending;
  }

  return await new Promise<IverilogPreflightResult>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(preflightWaitError('预检已取消'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        cleanup();
        reject(preflightWaitError('预检超时'));
      }, timeoutMs);
    }
    void pending.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function preflightWaitError(detail: string): IverilogRuntimeError {
  return new IverilogRuntimeError(
    'preflight-failed',
    `内置 Icarus Verilog 预检失败：${detail}`
  );
}

export function parseIverilogVersion(output: string): string {
  const version = /Icarus Verilog version\s+([^\r\n]+)/i.exec(output)?.[1]?.trim();
  return version ? `Icarus Verilog ${version}` : 'Icarus Verilog (bundled)';
}

function firstNonEmptyLine(text: string): string | undefined {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}
