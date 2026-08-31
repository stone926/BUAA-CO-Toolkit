import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { isDirectory, isFile } from '../../nodeFs';
import { runProcessCore } from '../../processCore';
import {
  buildIverilogIncludeArgs,
  buildIverilogEnvironment,
  IverilogRuntimeError,
  parseIverilogVersion,
  preflightIverilogRuntime,
  resolveIverilogRuntime
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

  it('resolves only the fixed win32-x64 installation layout', () => {
    const extensionRoot = path.resolve('Extension Root');
    const expectedRoot = path.join(extensionRoot, 'vendor', 'iverilog', 'win32-x64');
    const runtime = resolveIverilogRuntime(extensionRoot);
    expect(runtime.rootDir).toBe(expectedRoot);
    expect(runtime.iverilogPath).toBe(path.join(expectedRoot, 'bin', 'iverilog.exe'));
    expect(runtime.vvpPath).toBe(path.join(expectedRoot, 'bin', 'vvp.exe'));
    expect(runtime.libDir).toBe(path.join(expectedRoot, 'lib', 'ivl'));
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
