import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import * as vscode from 'vscode';
import type { AppServices, RunResult } from '../../types';
import {
  buildIverilogCompileArgs,
  buildIverilogWatchdog,
  runIverilog,
  verilogDurationToPicoseconds,
  watchdogLimitPsFromTcl
} from '../../verilog/iverilogRunner';
import {
  ensureConcreteProfile,
  getProfile,
  getSimTime
} from '../../config';
import {
  ensureDirectory,
  workspaceFolderFor,
  writeTextFile
} from '../../fsUtil';
import { revealOutputChannel, runTool } from '../../process';
import {
  copyAsmCaseArtifact,
  writeAsmCaseArtifact
} from '../../asmCaseStore';
import { resolveIseProjectFiles } from '../../verilog/iseProject';
import {
  buildIverilogIncludeArgs,
  buildIverilogEnvironment,
  preflightIverilogRuntime
} from '../../verilog/iverilogRuntime';
import {
  copyMachineCodeToSimDirectory,
  resolveMachineCodeSource
} from '../../verilog/simulationInputs';
import {
  ensureP7InterruptTestbench,
  ensureRunnableTestbench,
  findUserTestbenchSourceUris,
  recordTestbenchForAsmCase
} from '../../verilog/testbenchResolver';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('../helpers/vscodeMock').createVscodeMockState> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  return createVscodeModuleMock(vscodeState.state, vi.fn);
});

vi.mock('../../config', () => ({
  ensureConcreteProfile: vi.fn(),
  getMachineCode: vi.fn(() => 'code.txt'),
  getProfile: vi.fn(),
  getSimTime: vi.fn(),
  getTestbench: vi.fn(() => 'mips_tb')
}));

vi.mock('../../fsUtil', () => ({
  ensureDirectory: vi.fn(async () => undefined),
  workspaceFolderFor: vi.fn(),
  writeTextFile: vi.fn(async () => undefined)
}));

vi.mock('../../process', () => ({
  revealOutputChannel: vi.fn(),
  runTool: vi.fn()
}));

vi.mock('../../asmCaseStore', () => ({
  copyAsmCaseArtifact: vi.fn(async () => undefined),
  createAsmCaseFromAsm: vi.fn(),
  prepareAsmCaseMachineCode: vi.fn(),
  resolveAsmCaseInput: vi.fn(),
  writeAsmCaseArtifact: vi.fn(async () => undefined)
}));

vi.mock('../../verilogIsimOutput', () => ({
  isimOutputFileName: vi.fn((testbenchName: string, override?: string) => override ?? `${testbenchName}.sim.out`),
  simulationOutputDirectory: vi.fn(async () => URI.file('E:/work/.co/out'))
}));

vi.mock('../../verilog/iseProject', () => ({ resolveIseProjectFiles: vi.fn() }));

vi.mock('../../verilog/iverilogRuntime', () => ({
  buildIverilogIncludeArgs: vi.fn((root: string) => ['-grelative-include', '-I', root]),
  buildIverilogEnvironment: vi.fn(() => ({ Path: 'bundled-bin' })),
  preflightIverilogRuntime: vi.fn()
}));

vi.mock('../../verilog/simulationInputs', () => ({
  copyMachineCodeToSimDirectory: vi.fn(async () => undefined),
  resolveMachineCodeSource: vi.fn()
}));

vi.mock('../../verilog/testbenchResolver', () => ({
  ensureP7InterruptTestbench: vi.fn(),
  ensureRunnableTestbench: vi.fn(),
  findUserTestbenchSourceUris: vi.fn(),
  recordTestbenchForAsmCase: vi.fn(async () => undefined),
  resolveNamedTestbench: vi.fn()
}));

const resource = URI.file('E:/work/src/mips.v');
const runtime = {
  rootDir: 'E:/extension/vendor/iverilog/win32-x64',
  binDir: 'E:/extension/vendor/iverilog/win32-x64/bin',
  libDir: 'E:/extension/vendor/iverilog/win32-x64/lib/ivl',
  iverilogPath: 'E:/extension/vendor/iverilog/win32-x64/bin/iverilog.exe',
  vvpPath: 'E:/extension/vendor/iverilog/win32-x64/bin/vvp.exe'
};

function services(extensionRoot: string | undefined = 'E:/extension'): AppServices {
  return {
    extensionRoot,
    output: {
      appendLine: vi.fn(),
      append: vi.fn(),
      show: vi.fn(),
      clear: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      name: 'test'
    } as never,
    statusBar: {} as never
  };
}

function toolResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    ok: true,
    exitCode: 0,
    commandLine: '',
    cwd: 'E:/work/.co/isim',
    stdout: 'trace stdout',
    stderr: '',
    timedOut: false,
    stopped: false,
    ...overrides
  };
}

describe('Icarus compile arguments and watchdog', () => {
  it('keeps source order and supplies both explicit roots', () => {
    const args = buildIverilogCompileArgs({
      testbenchModule: 'mips_tb',
      watchdogModule: '__co_iverilog_watchdog_ab12',
      outputFile: 'E:/work path/simulation.vvp',
      workspaceRoot: 'E:/课程 workspace path',
      sourceFiles: ['E:/work/a.v', 'E:/work/z.v', 'E:/work/generated_tb.v'],
      watchdogFile: 'E:/work/watchdog.v'
    });

    expect(args).toEqual([
      '-g2005', '-grelative-include', '-I', 'E:/课程 workspace path',
      '-t', 'vvp',
      '-s', 'mips_tb',
      '-s', '__co_iverilog_watchdog_ab12',
      '-o', 'E:/work path/simulation.vvp',
      'E:/work/a.v', 'E:/work/z.v', 'E:/work/generated_tb.v',
      'E:/work/watchdog.v'
    ]);
    expect(buildIverilogIncludeArgs).toHaveBeenCalledWith('E:/课程 workspace path', [
      'E:/work/a.v',
      'E:/work/z.v',
      'E:/work/generated_tb.v',
      'E:/work/watchdog.v'
    ]);
  });

  it('converts automatic TCL budgets into the 1ps watchdog time base', () => {
    expect(verilogDurationToPicoseconds('4195us')).toBe(4_195_000_000);
    expect(verilogDurationToPicoseconds('1.5 ns')).toBe(1_500);
    expect(verilogDurationToPicoseconds('0.5fs')).toBe(1);
    expect(verilogDurationToPicoseconds('not-a-time')).toBeUndefined();
    expect(watchdogLimitPsFromTcl('run 200us;\nrun 4195us;\nexit\n')).toBe(4_195_000_000);
  });

  it('emits a separate, bounded Verilog root with a final delta before finish', () => {
    expect(buildIverilogWatchdog('__co_iverilog_watchdog_ab12', 1234)).toBe([
      '`timescale 1ps/1ps',
      'module __co_iverilog_watchdog_ab12;',
      '    initial begin',
      '        #(1234);',
      '        #1;',
      '        $finish;',
      '    end',
      'endmodule',
      ''
    ].join('\n'));
  });
});

describe('Icarus runner orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeState.state!.activeTextEditor = undefined;
    vi.mocked(ensureConcreteProfile).mockResolvedValue('P1' as never);
    vi.mocked(getProfile).mockReturnValue('P1');
    vi.mocked(getSimTime).mockReturnValue('200us');
    vi.mocked(workspaceFolderFor).mockReturnValue({ uri: URI.file('E:/work'), name: 'work', index: 0 });
    vi.mocked(preflightIverilogRuntime).mockResolvedValue({
      runtime,
      version: 'Icarus Verilog 13.0',
      result: toolResult()
    } as never);
    vi.mocked(ensureP7InterruptTestbench).mockResolvedValue(undefined);
    vi.mocked(ensureRunnableTestbench).mockResolvedValue({
      kind: 'user',
      moduleName: 'mips_tb',
      sourceUri: URI.file('E:/work/test/mips_tb.v')
    });
    vi.mocked(findUserTestbenchSourceUris).mockResolvedValue([URI.file('E:/work/test/mips_tb.v')]);
    vi.mocked(resolveIseProjectFiles).mockResolvedValue([
      URI.file('E:/work/src/a.v'),
      URI.file('E:/work/src/z.v'),
      URI.file('E:/work/test/mips_tb.v')
    ]);
    vi.mocked(runTool).mockResolvedValue(toolResult());
    vi.mocked(resolveMachineCodeSource).mockResolvedValue(undefined);
  });

  it('runs absolute iverilog then vvp -N in one cwd and writes stdout unchanged', async () => {
    const controller = new AbortController();
    const result = await runIverilog(services(), {
      resource,
      showMessages: false,
      tclText: 'run 4195us;\nexit\n',
      signal: controller.signal
    });

    expect(result).toMatchObject({
      backend: 'iverilog',
      runtimeVersion: 'Icarus Verilog 13.0',
      compileResult: { ok: true },
      simResult: { ok: true }
    });
    expect(runTool).toHaveBeenCalledTimes(2);
    const [compileCommand, compileArgs, compileOptions] = vi.mocked(runTool).mock.calls[0];
    expect(compileCommand).toBe(runtime.iverilogPath);
    expect(compileArgs.slice(0, 12)).toEqual([
      '-g2005', '-grelative-include', '-I', expect.stringMatching(/e:[\\/]work/i),
      '-t', 'vvp', '-s', 'mips_tb', '-s',
      expect.stringMatching(/^__co_iverilog_watchdog_[0-9a-f]{8}$/),
      '-o',
      expect.stringMatching(/simulation\.vvp$/i)
    ]);
    expect(compileArgs.slice(12, -1).map(normalized)).toEqual([
      'e:/work/src/a.v',
      'e:/work/src/z.v',
      'e:/work/test/mips_tb.v'
    ]);
    expect(normalized(compileArgs.at(-1) ?? '')).toMatch(/__co_iverilog_watchdog_[0-9a-f]{8}\.v$/);
    expect(compileOptions).toEqual(expect.objectContaining({
      cwd: expect.stringMatching(/[\\/]\.co[\\/]isim$/i),
      env: { Path: 'bundled-bin' },
      signal: controller.signal,
      maxStdoutBytes: 4 * 1024 * 1024,
      maxStderrBytes: 4 * 1024 * 1024
    }));
    expect(runTool).toHaveBeenNthCalledWith(
      2,
      runtime.vvpPath,
      ['-N', expect.stringMatching(/simulation\.vvp$/i)],
      expect.objectContaining({
        cwd: compileOptions.cwd,
        signal: controller.signal,
        maxStdoutBytes: 16 * 1024 * 1024,
        maxStderrBytes: 16 * 1024 * 1024
      })
    );
    expect(writeTextFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringMatching(/mips_tb\.sim\.out$/i) }),
      'trace stdout'
    );
    expect(writeTextFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringMatching(/watchdog_[0-9a-f]{8}\.v$/i) }),
      expect.stringContaining('#(4195000000);')
    );
  });

  it('returns compile stderr/timeout state without starting VVP', async () => {
    vi.mocked(runTool).mockResolvedValueOnce(toolResult({
      ok: false,
      exitCode: 1,
      stderr: 'mips.v:3: syntax error',
      timedOut: true,
      stopped: true,
      stopReason: 'timeout'
    }));

    const result = await runIverilog(services(), { resource, showMessages: false });

    expect(result?.compileResult).toMatchObject({
      ok: false,
      stderr: 'mips.v:3: syntax error',
      timedOut: true,
      stopReason: 'timeout'
    });
    expect(result?.simResult).toBeUndefined();
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(writeTextFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringMatching(/\.sim\.out$/i) }),
      expect.anything()
    );
  });

  it('surfaces the process output ceiling as a bounded simulation failure', async () => {
    vi.mocked(runTool)
      .mockResolvedValueOnce(toolResult())
      .mockResolvedValueOnce(toolResult({
        ok: false,
        exitCode: null,
        stopped: true,
        stopReason: 'stdout-limit',
        stdout: 'bounded trace'
      }));

    const result = await runIverilog(services(), { resource, showMessages: false });

    expect(result?.simResult).toMatchObject({
      ok: false,
      stopReason: 'stdout-limit',
      stdout: 'bounded trace'
    });
    expect(result?.simOut).toBeUndefined();
    expect(vi.mocked(runTool).mock.calls[1][2]).toEqual(expect.objectContaining({
      maxStdoutBytes: 16 * 1024 * 1024,
      maxStderrBytes: 16 * 1024 * 1024
    }));
  });

  it('shows the first actionable compiler location for an interactive run', async () => {
    vi.mocked(runTool).mockResolvedValueOnce(toolResult({
      ok: false,
      exitCode: 26,
      stderr: 'E:/work/CPU.v:449: error: Net D_fixedRD1_reg is not defined'
    }));

    await runIverilog(services(), { resource });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Icarus 编译失败（退出码 26）：CPU.v:449: Net D_fixedRD1_reg is not defined'
    );
  });

  it('surfaces VVP failure (including -N $stop) and does not persist partial stdout', async () => {
    vi.mocked(runTool)
      .mockResolvedValueOnce(toolResult())
      .mockResolvedValueOnce(toolResult({ ok: false, exitCode: 1, stdout: 'partial', stderr: '$stop' }));

    const result = await runIverilog(services(), { resource, showMessages: false });

    expect(result?.simResult).toMatchObject({ ok: false, exitCode: 1, stderr: '$stop' });
    expect(result?.simOut).toBeUndefined();
    expect(writeAsmCaseArtifact).not.toHaveBeenCalled();
  });

  it('stores raw compile diagnostics as a private case artifact without command metadata', async () => {
    vi.mocked(getProfile).mockReturnValue('P4');
    const currentCase = {
      machineCode: URI.file('E:/work/.co/cases/case-failure/code.txt'),
      manifestUri: URI.file('E:/work/.co/cases/case-failure/case.json')
    } as never;
    vi.mocked(runTool).mockResolvedValueOnce(toolResult({
      ok: false,
      exitCode: 26,
      commandLine: 'E:/SECRET/iverilog.exe --private',
      cwd: 'E:/SECRET/cwd',
      stderr: 'E:/work/CPU.v:449: Unable to bind `D_fixedRD1_reg`'
    }));

    await runIverilog(services(), {
      resource,
      asmCase: currentCase,
      nonInteractive: true
    });

    expect(writeAsmCaseArtifact).toHaveBeenCalledWith(
      currentCase,
      'verilog',
      'iverilog-compile.log',
      expect.stringContaining('CPU.v:449'),
      'compileLog'
    );
    const log = vi.mocked(writeAsmCaseArtifact).mock.calls[0][3];
    expect(log).not.toContain('--private');
    expect(log).not.toContain('E:/SECRET/cwd');
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it('uses the private automatic testbench/source exclusions and prepares code.txt in the shared cwd', async () => {
    vi.mocked(getProfile).mockReturnValue('P7');
    const generatedTb = URI.file('E:/work/.co/isim/co_generated_p7_auto_tb.v');
    vi.mocked(ensureP7InterruptTestbench).mockResolvedValue({
      kind: 'p7-auto',
      moduleName: 'co_generated_p7_auto_tb',
      generatedUri: generatedTb,
      designSourceUri: URI.file('E:/work/src/mips.v')
    });
    const currentCase = {
      machineCode: URI.file('E:/work/.co/cases/case-1/code.txt'),
      manifestUri: URI.file('E:/work/.co/cases/case-1/case.json')
    } as never;

    await runIverilog(services(), {
      resource,
      asmCase: currentCase,
      nonInteractive: true,
      interruptSchedule: [0x3000],
      tclText: 'run 5000us;\nexit\n'
    });

    expect(resolveIseProjectFiles).toHaveBeenCalledWith(
      expect.anything(),
      [generatedTb],
      expect.objectContaining({
        excludedFiles: [URI.file('E:/work/test/mips_tb.v')],
        excludedBasenames: ['mips_tb.v'],
        protectedFiles: [URI.file('E:/work/src/mips.v')]
      })
    );
    expect(copyMachineCodeToSimDirectory).toHaveBeenCalledWith(
      currentCase.machineCode,
      expect.objectContaining({ path: expect.stringMatching(/[\\/]\.co[\\/]isim$/i) }),
      resource
    );
    expect(copyAsmCaseArtifact).toHaveBeenCalledWith(
      currentCase,
      'verilog',
      expect.objectContaining({ path: expect.stringMatching(/[\\/]\.co[\\/]isim[\\/]code\.txt$/i) }),
      'machine-code-in-sim.txt',
      'machineCodeInSim'
    );
    expect(recordTestbenchForAsmCase).toHaveBeenCalledWith(
      currentCase,
      expect.objectContaining({ moduleName: 'co_generated_p7_auto_tb' })
    );
    expect(vscodeState.state).toBeDefined();
    expect(revealOutputChannel).not.toHaveBeenCalled();
    expect(vi.mocked(runTool).mock.calls[0][2]).toEqual(expect.objectContaining({
      nonInteractive: true,
      timeoutMs: 300_000
    }));
  });

  it('fails clearly when the production service did not supply an extension installation root', async () => {
    const currentServices = services('');

    await expect(runIverilog(currentServices, { resource, showMessages: false })).resolves.toBeUndefined();

    expect(preflightIverilogRuntime).not.toHaveBeenCalled();
    expect(currentServices.output.appendLine).toHaveBeenCalledWith(expect.stringContaining('扩展安装根路径'));
    expect(runTool).not.toHaveBeenCalled();
  });

  it('passes an explicit extension root to preflight and builds the bundled environment', async () => {
    await runIverilog(services(''), {
      resource,
      extensionRoot: 'E:/installed extension',
      showMessages: false
    });

    expect(preflightIverilogRuntime).toHaveBeenCalledWith('E:/installed extension', expect.anything());
    expect(buildIverilogEnvironment).toHaveBeenCalledWith(runtime);
  });

  it('serializes shared testbench/input artifacts and tool processes per workspace', async () => {
    vi.mocked(getProfile).mockReturnValue('P4');
    const currentCase = {
      machineCode: URI.file('E:/work/.co/cases/case-serial/code.txt'),
      manifestUri: URI.file('E:/work/.co/cases/case-serial/case.json')
    } as never;
    let finishFirstSimulation!: (result: RunResult) => void;
    const firstSimulation = new Promise<RunResult>((resolve) => {
      finishFirstSimulation = resolve;
    });
    vi.mocked(runTool)
      .mockResolvedValueOnce(toolResult())
      .mockImplementationOnce(async () => await firstSimulation)
      .mockResolvedValueOnce(toolResult())
      .mockResolvedValueOnce(toolResult());

    const firstRun = runIverilog(services(), {
      resource,
      asmCase: currentCase,
      showMessages: false
    });
    await vi.waitFor(() => expect(runTool).toHaveBeenCalledTimes(2));

    const secondRun = runIverilog(services(), {
      resource,
      asmCase: currentCase,
      showMessages: false
    });
    await vi.waitFor(() => expect(preflightIverilogRuntime).toHaveBeenCalledTimes(2));

    expect(ensureRunnableTestbench).toHaveBeenCalledTimes(1);
    expect(copyMachineCodeToSimDirectory).toHaveBeenCalledTimes(1);
    expect(runTool).toHaveBeenCalledTimes(2);

    finishFirstSimulation(toolResult({ stdout: 'first serialized trace' }));
    await firstRun;
    await secondRun;

    expect(ensureRunnableTestbench).toHaveBeenCalledTimes(2);
    expect(copyMachineCodeToSimDirectory).toHaveBeenCalledTimes(2);
    expect(runTool).toHaveBeenCalledTimes(4);
  });

  it('cancels a queued workspace turn without blocking the next simulation', async () => {
    vi.mocked(getProfile).mockReturnValue('P4');
    const currentCase = {
      machineCode: URI.file('E:/work/.co/cases/case-cancel/code.txt'),
      manifestUri: URI.file('E:/work/.co/cases/case-cancel/case.json')
    } as never;
    let finishFirstSimulation!: (result: RunResult) => void;
    vi.mocked(runTool)
      .mockResolvedValueOnce(toolResult())
      .mockImplementationOnce(async () => await new Promise<RunResult>((resolve) => {
        finishFirstSimulation = resolve;
      }))
      .mockResolvedValue(toolResult());

    const firstRun = runIverilog(services(), {
      resource,
      asmCase: currentCase,
      showMessages: false
    });
    await vi.waitFor(() => expect(runTool).toHaveBeenCalledTimes(2));

    const controller = new AbortController();
    const cancelledRun = runIverilog(services(), {
      resource,
      asmCase: currentCase,
      showMessages: false,
      signal: controller.signal
    });
    await vi.waitFor(() => expect(preflightIverilogRuntime).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(cancelledRun).resolves.toBeUndefined();

    finishFirstSimulation(toolResult({ stdout: 'first trace' }));
    await firstRun;
    await runIverilog(services(), {
      resource,
      asmCase: currentCase,
      showMessages: false
    });

    expect(ensureRunnableTestbench).toHaveBeenCalledTimes(2);
    expect(copyMachineCodeToSimDirectory).toHaveBeenCalledTimes(2);
    expect(runTool).toHaveBeenCalledTimes(4);
  });
});

function normalized(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}
