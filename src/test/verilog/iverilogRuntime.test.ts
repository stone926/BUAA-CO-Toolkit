import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { isDirectory, isFile } from '../../nodeFs';
import { runProcessCore } from '../../processCore';
import {
  buildIverilogIncludeArgs,
  buildIverilogEnvironment,
  buildIverilogRuntimeArgs,
  IverilogRuntimeError,
  parseIverilogVersion,
  preflightIverilogRuntime,
  resolveIverilogRuntime,
  resolveIverilogRuntimeTarget
} from '../../verilog/iverilogRuntime';

vi.mock('../../nodeFs', () => ({
  isDirectory: vi.fn(),
  isFile: vi.fn()
}));

vi.mock('../../processCore', () => ({
  runProcessCore: vi.fn()
}));

describe('bundled Icarus runtime', () => {
  let platformSpy: ReturnType<typeof vi.spyOn>;
  let archSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    archSpy = vi.spyOn(process, 'arch', 'get').mockReturnValue('x64');
  });

  afterAll(() => {
    platformSpy.mockRestore();
    archSpy.mockRestore();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isFile).mockResolvedValue(true);
    vi.mocked(isDirectory).mockResolvedValue(true);
    vi.mocked(runProcessCore).mockResolvedValue({
      ok: true,
      exitCode: 0,
      commandLine: '',
      cwd: '',
      stdout: 'Icarus Verilog version 13.0 (stable)',
      stderr: '',
      timedOut: false,
      stopped: false
    });
  });

  it.each([
    ['win32', 'x64', 'win32-x64', 'iverilog.exe', 'vvp.exe'],
    ['darwin', 'arm64', 'darwin-arm64', 'iverilog', 'vvp'],
    ['darwin', 'x64', 'darwin-x64', 'iverilog', 'vvp'],
    ['linux', 'arm64', 'linux-arm64', 'iverilog', 'vvp'],
    ['linux', 'x64', 'linux-x64', 'iverilog', 'vvp']
  ] as const)('maps %s-%s to the bundled %s installation layout', (
    platform,
    arch,
    target,
    iverilogExecutable,
    vvpExecutable
  ) => {
    const extensionRoot = path.resolve('Extension Root');
    const descriptor = resolveIverilogRuntimeTarget(platform, arch);
    const expectedRoot = path.join(extensionRoot, 'vendor', 'iverilog', target);
    const runtime = resolveIverilogRuntime(extensionRoot, platform, arch);
    expect(descriptor).toEqual({ target, iverilogExecutable, vvpExecutable });
    expect(runtime.target).toBe(target);
    expect(runtime.rootDir).toBe(expectedRoot);
    expect(runtime.iverilogPath).toBe(path.join(expectedRoot, 'bin', iverilogExecutable));
    expect(runtime.vvpPath).toBe(path.join(expectedRoot, 'bin', vvpExecutable));
    expect(runtime.libDir).toBe(path.join(expectedRoot, 'lib', 'ivl'));
  });

  it.each([
    ['linux', 'arm'],
    ['win32', 'arm64'],
    ['freebsd', 'x64']
  ] as const)('rejects %s-%s without a corresponding bundled runtime target', (platform, arch) => {
    expect(() => resolveIverilogRuntimeTarget(platform, arch)).toThrowError(expect.objectContaining({
      code: 'unsupported-platform',
      message: expect.stringContaining('当前平台没有对应的 bundled Icarus 包')
    }));
  });

  it('isolates the compiler config override, preserves VVP controls, and prepends bundled bin to Path', () => {
    const runtime = resolveIverilogRuntime('E:/Extension Root');
    const env = buildIverilogEnvironment(runtime, {
      Path: 'C:/Windows',
      PATH: 'C:/ambiguous-mingw',
      KEEP: 'yes',
      IVERILOG_ICONFIG: 'E:/host/iconfig',
      iverilog_vpi_module_path: 'E:/host/vpi',
      IVERILOG_DUMPER: 'fst'
    });
    expect(env.KEEP).toBe('yes');
    expect(normalized(env.Path ?? '')).toContain('vendor/iverilog/win32-x64/bin');
    expect(env.Path).toContain('C:/Windows');
    expect(env).not.toHaveProperty('PATH');
    expect(env).not.toHaveProperty('IVERILOG_ICONFIG');
    expect(env.iverilog_vpi_module_path).toBe('E:/host/vpi');
    expect(env.IVERILOG_DUMPER).toBe('fst');
  });

  it.each([
    ['win32', 'x64'],
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'arm64'],
    ['linux', 'x64']
  ] as const)('uses the bundled component base when needed for %s-%s', (platform, arch) => {
    const runtime = resolveIverilogRuntime('E:/Extension Root', platform, arch);
    expect(buildIverilogRuntimeArgs(runtime)).toEqual(platform === 'win32' ? [] : ['-B', runtime.libDir]);
  });

  it('enables source-relative and workspace-root includes without rewriting paths', () => {
    expect(buildIverilogIncludeArgs('E:/课程 workspace/include path')).toEqual([
      '-grelative-include',
      '-I',
      'E:/课程 workspace/include path'
    ]);
    expect(buildIverilogIncludeArgs('E:/课程 workspace', [
      'E:/课程 workspace/rtl one/a.v',
      'E:/课程 workspace/rtl one/b.v',
      'E:/课程 workspace/rtl 二/c.v'
    ])).toEqual([
      '-grelative-include',
      '-I',
      'E:/课程 workspace/rtl one',
      '-I',
      'E:/课程 workspace/rtl 二',
      '-I',
      'E:/课程 workspace'
    ]);
    expect(() => buildIverilogIncludeArgs('   ')).toThrow(RangeError);
  });

  it('reports incomplete runtime paths before launching a process', async () => {
    vi.mocked(isFile).mockImplementation(async (file) => !file.endsWith('vvp.exe'));

    await expect(preflightIverilogRuntime('E:/missing-runtime-case')).rejects.toMatchObject({
      name: 'IverilogRuntimeError',
      code: 'missing-runtime',
      missingPaths: [expect.stringMatching(/vvp\.exe$/i)]
    });
    expect(runProcessCore).not.toHaveBeenCalled();
  });

  it('runs -V once per extension-root session and returns a stable version label', async () => {
    const first = await preflightIverilogRuntime('E:/valid-runtime-case');
    const second = await preflightIverilogRuntime('E:/valid-runtime-case');

    expect(first.version).toBe('Icarus Verilog 13.0 (stable)');
    expect(second).toBe(first);
    expect(runProcessCore).toHaveBeenCalledTimes(1);
    expect(runProcessCore).toHaveBeenCalledWith(
      expect.stringMatching(/iverilog\.exe$/i),
      ['-V'],
      expect.objectContaining({ cwd: expect.stringMatching(/bin$/i) })
    );
  });

  it.each([
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'arm64'],
    ['linux', 'x64']
  ] as const)('preflights %s-%s with its bundled lib/ivl base', async (platform, arch) => {
    platformSpy.mockReturnValue(platform);
    archSpy.mockReturnValue(arch);
    try {
      const extensionRoot = `E:/unix-runtime-case-${platform}-${arch}`;
      const runtime = resolveIverilogRuntime(extensionRoot, platform, arch);
      await preflightIverilogRuntime(extensionRoot);

      expect(runProcessCore).toHaveBeenCalledWith(
        runtime.iverilogPath,
        ['-B', runtime.libDir, '-V'],
        expect.objectContaining({ cwd: runtime.binDir })
      );
    } finally {
      platformSpy.mockReturnValue('win32');
      archSpy.mockReturnValue('x64');
    }
  });

  it('evicts a failed preflight so a later operation can retry', async () => {
    vi.mocked(runProcessCore)
      .mockResolvedValueOnce({
        ok: false,
        exitCode: 1,
        commandLine: '',
        cwd: '',
        stdout: '',
        stderr: 'broken runtime',
        timedOut: false,
        stopped: false
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        commandLine: '',
        cwd: '',
        stdout: 'Icarus Verilog version 13.0',
        stderr: '',
        timedOut: false,
        stopped: false
      });

    await expect(preflightIverilogRuntime('E:/retry-runtime-case')).rejects.toBeInstanceOf(IverilogRuntimeError);
    await expect(preflightIverilogRuntime('E:/retry-runtime-case')).resolves.toMatchObject({
      version: 'Icarus Verilog 13.0'
    });
    expect(runProcessCore).toHaveBeenCalledTimes(2);
  });

  it('isolates caller cancellation while sharing one pending runtime probe', async () => {
    let completeProbe!: (value: Awaited<ReturnType<typeof runProcessCore>>) => void;
    vi.mocked(runProcessCore).mockImplementationOnce(async () => await new Promise((resolve) => {
      completeProbe = resolve;
    }));
    const controller = new AbortController();
    const cancelled = preflightIverilogRuntime('E:/concurrent-runtime-case', {
      signal: controller.signal
    });
    const continuing = preflightIverilogRuntime('E:/concurrent-runtime-case');

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({
      code: 'preflight-failed',
      message: expect.stringContaining('预检已取消')
    });
    completeProbe({
      ok: true,
      exitCode: 0,
      commandLine: '',
      cwd: '',
      stdout: 'Icarus Verilog version 13.0',
      stderr: '',
      timedOut: false,
      stopped: false
    });

    await expect(continuing).resolves.toMatchObject({ version: 'Icarus Verilog 13.0' });
    await expect(preflightIverilogRuntime('E:/concurrent-runtime-case')).resolves.toMatchObject({
      version: 'Icarus Verilog 13.0'
    });
    expect(runProcessCore).toHaveBeenCalledTimes(1);
  });

  it('rejects a zero-exit -V result when a bundled VPI module failed to load', async () => {
    vi.mocked(runProcessCore).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      commandLine: '',
      cwd: '',
      stdout: 'Icarus Verilog version 13.0',
      stderr: "error: Failed to open 'E:/runtime/lib/ivl/system.vpi' because: missing DLL",
      timedOut: false,
      stopped: false
    });

    await expect(preflightIverilogRuntime('E:/vpi-load-failure-case')).rejects.toMatchObject({
      code: 'preflight-failed',
      message: expect.stringContaining('Failed to open')
    });
  });

  it('parses version text from either Icarus output stream', () => {
    expect(parseIverilogVersion('Icarus Verilog version 13.0 (stable)\n')).toBe('Icarus Verilog 13.0 (stable)');
    expect(parseIverilogVersion('unrecognized output')).toBe('Icarus Verilog (bundled)');
    expect(() => resolveIverilogRuntime('   ')).toThrow(IverilogRuntimeError);
  });
});

function normalized(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}
