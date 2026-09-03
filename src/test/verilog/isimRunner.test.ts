import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import * as vscode from 'vscode';
import type { AppServices } from '../../types';
import type { AsmCase } from '../../asmCaseStore';
import { createTestRunResult } from '../helpers/appServices';
import { compileIsim, runIsim } from '../../verilog/isimRunner';
import {
  ensureConcreteProfile,
  getIsePath,
  getProfile,
  getSimTime
} from '../../config';
import {
  isFile,
  pathExists,
  workspaceFolderFor,
  writeTextFile
} from '../../fsUtil';
import { revealOutputChannel, runTool } from '../../process';
import { buildIseEnvironment, findFuse } from '../../toolchain';
import {
  copyAsmCaseArtifact,
  createAsmCaseFromAsm,
  prepareAsmCaseMachineCode,
  resolveAsmCaseInput,
  writeAsmCaseArtifact
} from '../../asmCaseStore';
import {
  generateIseProject,
  resolveIseProjectFiles,
  verilogProjectSignature
} from '../../verilog/iseProject';
import {
  copyMachineCodeToSimDirectory,
  resolveMachineCodeSource
} from '../../verilog/simulationInputs';
import {
  ensureP7InterruptTestbench,
  ensureRunnableTestbench,
  findUserTestbenchSourceUris,
  recordTestbenchForAsmCase,
  resolveNamedTestbench
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
  getIsePath: vi.fn(),
  getProfile: vi.fn(),
  getSimTime: vi.fn(() => '200us'),
  getTestbench: vi.fn(() => 'mips_tb')
}));

vi.mock('../../fsUtil', () => ({
  ensureDirectory: vi.fn(async () => undefined),
  isFile: vi.fn(),
  pathExists: vi.fn(),
  workspaceFolderFor: vi.fn(),
  writeTextFile: vi.fn(async () => undefined)
}));

vi.mock('../../process', () => ({
  revealOutputChannel: vi.fn(),
  runTool: vi.fn()
}));

vi.mock('../../toolchain', () => ({
  buildIseEnvironment: vi.fn(() => ({ PATH: 'ise-path' })),
  findFuse: vi.fn()
}));

vi.mock('../../asmCaseStore', () => ({
  asmCaseArtifactUri: vi.fn((_asmCase, _kind, fileName) =>
    URI.file(`E:/work/.co/cases/case-1/verilog/${fileName}`)),
  copyAsmCaseArtifact: vi.fn(async (_asmCase, _kind, _source, fileName) =>
    URI.file(`E:/work/.co/cases/case-1/verilog/${fileName}`)),
  createAsmCaseFromAsm: vi.fn(),
  prepareAsmCaseMachineCode: vi.fn(),
  resolveAsmCaseInput: vi.fn(),
  writeAsmCaseArtifact: vi.fn(async (_asmCase, _kind, fileName) => URI.file(`E:/work/.co/cases/case-1/verilog/${fileName}`))
}));

vi.mock('../../verilogSimulationFiles', () => ({
  buildIsimRunTcl: vi.fn((simTime: string) => `run ${simTime};\nexit\n`)
}));

vi.mock('../../verilogIsimOutput', () => ({
  isimOutputFileName: vi.fn((testbenchName: string, override?: string) => override ?? `${testbenchName}.sim.out`),
  simulationOutputDirectory: vi.fn(async () => URI.file('E:/work/.co/out'))
}));

vi.mock('../../verilog/iseProject', () => ({
  generateIseProject: vi.fn(),
  resolveIseProjectFiles: vi.fn(),
  verilogProjectSignature: vi.fn()
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
const generated = {
  outDir: URI.file('E:/work/.co/isim'),
  prj: URI.file('E:/work/.co/isim/mips_tb.prj'),
  tcl: URI.file('E:/work/.co/isim/mips_tb.tcl')
};

function normalizedPath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function services(): AppServices {
  return {
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

function asmCase(): AsmCase {
  return {
    id: 'case-1',
    dir: URI.file('E:/work/.co/cases/case-1'),
    manifestUri: URI.file('E:/work/.co/cases/case-1/case.json'),
    asm: URI.file('E:/work/.co/cases/case-1/program.asm'),
    sourceAsm: URI.file('E:/work/src/test.asm'),
    machineCode: URI.file('E:/work/.co/cases/case-1/code.txt'),
    manifest: {
      version: 1,
      caseId: 'case-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      profile: 'P5',
      originalAsmPath: 'E:/work/src/test.asm',
      source: { kind: 'selected' },
      asmSnapshot: { path: 'program.asm', sha256: 'asm', bytes: 0 }
    }
  };
}

describe('Verilog ISim runner orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeState.state!.activeTextEditor = undefined;
    vi.mocked(ensureConcreteProfile).mockResolvedValue('P5' as never);
    vi.mocked(getIsePath).mockReturnValue('D:/ISE');
    vi.mocked(getProfile).mockReturnValue('P5');
    vi.mocked(findFuse).mockReturnValue('D:/ISE/fuse.exe');
    vi.mocked(isFile).mockResolvedValue(true);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(workspaceFolderFor).mockReturnValue({ uri: URI.file('E:/work'), name: 'work', index: 0 });
    vi.mocked(resolveNamedTestbench).mockResolvedValue({ kind: 'user', moduleName: 'mips_tb', sourceUri: URI.file('E:/work/tb.v') });
    vi.mocked(ensureRunnableTestbench).mockResolvedValue({ kind: 'user', moduleName: 'mips_tb', sourceUri: URI.file('E:/work/tb.v') });
    vi.mocked(ensureP7InterruptTestbench).mockResolvedValue(undefined);
    vi.mocked(findUserTestbenchSourceUris).mockResolvedValue([URI.file('E:/work/tb.v')]);
    vi.mocked(resolveIseProjectFiles).mockResolvedValue([URI.file('E:/work/src/mips.v'), URI.file('E:/work/tb.v')]);
    vi.mocked(verilogProjectSignature).mockResolvedValue('project-signature');
    vi.mocked(generateIseProject).mockResolvedValue(generated);
    vi.mocked(runTool).mockResolvedValue(createTestRunResult({ stdout: 'sim stdout' }));
    vi.mocked(resolveMachineCodeSource).mockResolvedValue(URI.file('E:/work/code.txt'));
  });

  it('returns before project generation when profile resolution fails', async () => {
    vi.mocked(ensureConcreteProfile).mockResolvedValueOnce(undefined);

    await expect(compileIsim(services(), { resource })).resolves.toBeUndefined();

    expect(generateIseProject).not.toHaveBeenCalled();
    expect(runTool).not.toHaveBeenCalled();
  });

  it('reports missing ISE path or missing fuse without later side effects', async () => {
    vi.mocked(getIsePath).mockReturnValueOnce('');
    await expect(compileIsim(services(), { resource })).resolves.toBeUndefined();
    expect(vscodeState.state).toBeDefined();
    expect(generateIseProject).not.toHaveBeenCalled();

    vi.mocked(getIsePath).mockReturnValue('D:/ISE');
    vi.mocked(isFile).mockResolvedValueOnce(false);
    await expect(compileIsim(services(), { resource })).resolves.toBeUndefined();
    expect(generateIseProject).not.toHaveBeenCalled();
    expect(runTool).not.toHaveBeenCalled();
  });

  it('passes resolved project files and Tcl text to fuse compilation', async () => {
    const result = await compileIsim(services(), {
      resource,
      testbenchName: 'mips_tb',
      tclText: 'run 1us;\nexit\n',
      tclFileName: 'custom.tcl'
    });

    expect(normalizedPath(result?.exePath ?? '')).toBe('e:/work/.co/isim/mips_tb.exe');
    expect(generateIseProject).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      testbenchName: 'mips_tb',
      projectFiles: [URI.file('E:/work/src/mips.v'), URI.file('E:/work/tb.v')],
      tclText: 'run 1us;\nexit\n',
      tclFileName: 'custom.tcl'
    }));
    expect(runTool).toHaveBeenCalledWith('D:/ISE/fuse.exe', expect.arrayContaining(['-prj', 'mips_tb.prj', '-o', 'mips_tb.exe', 'mips_tb']), expect.objectContaining({
      cwd: generated.outDir.fsPath,
      maxStdoutBytes: 4 * 1024 * 1024,
      maxStderrBytes: 4 * 1024 * 1024
    }));
  });

  it('forwards one AbortSignal through both fuse and ISim process launches', async () => {
    vi.mocked(getProfile).mockReturnValue('P1');
    const controller = new AbortController();

    await runIsim(services(), { resource, signal: controller.signal });

    expect(runTool).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runTool).mock.calls[0][2]).toEqual(expect.objectContaining({
      signal: controller.signal,
      maxStdoutBytes: 4 * 1024 * 1024,
      maxStderrBytes: 4 * 1024 * 1024
    }));
    expect(vi.mocked(runTool).mock.calls[1][2]).toEqual(expect.objectContaining({
      signal: controller.signal,
      maxStdoutBytes: 16 * 1024 * 1024,
      maxStderrBytes: 16 * 1024 * 1024
    }));
  });

  it('uses one dispatcher-supplied ISE path snapshot for compile and simulation', async () => {
    vi.mocked(getProfile).mockReturnValue('P1');
    vi.mocked(getIsePath).mockReturnValue('D:/changed-during-operation');

    await runIsim(services(), { resource, isePath: 'D:/snapshot-ISE' });

    expect(getIsePath).not.toHaveBeenCalled();
    expect(findFuse).toHaveBeenCalledWith('D:/snapshot-ISE');
    expect(buildIseEnvironment).toHaveBeenCalledTimes(2);
    expect(buildIseEnvironment).toHaveBeenNthCalledWith(1, 'D:/snapshot-ISE');
    expect(buildIseEnvironment).toHaveBeenNthCalledWith(2, 'D:/snapshot-ISE');
  });

  it('propagates the automatic non-interactive boundary and hides machine-code paths', async () => {
    const currentServices = services();
    const currentCase = asmCase();

    await runIsim(currentServices, {
      resource,
      asmCase: currentCase,
      nonInteractive: true,
      tclText: 'run 4195us;\nexit\n'
    });

    expect(runTool).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runTool).mock.calls[0][2]).toEqual(expect.objectContaining({
      nonInteractive: true,
      timeoutMs: 300_000
    }));
    expect(vi.mocked(runTool).mock.calls[1][2]).toEqual(expect.objectContaining({
      nonInteractive: true,
      timeoutMs: 300_000
    }));
    expect(ensureP7InterruptTestbench).toHaveBeenCalledWith(
      currentServices,
      resource,
      undefined,
      undefined,
      false,
      { nonInteractive: true }
    );
    expect(ensureRunnableTestbench).toHaveBeenCalledWith(
      currentServices,
      resource,
      false,
      undefined,
      { nonInteractive: true }
    );
    expect(generateIseProject).toHaveBeenCalledWith(currentServices, expect.objectContaining({
      nonInteractive: true,
      tclText: 'run 4195us;\nexit\n'
    }));
    expect(resolveIseProjectFiles).toHaveBeenCalledWith(
      expect.anything(),
      [],
      expect.objectContaining({
        excludedFiles: [URI.file('E:/work/tb.v')],
        excludedBasenames: ['mips_tb.v']
      })
    );
    expect(getSimTime).not.toHaveBeenCalled();
    expect(revealOutputChannel).not.toHaveBeenCalled();
    expect(currentServices.output.appendLine).not.toHaveBeenCalledWith(expect.stringContaining(currentCase.machineCode.fsPath));
  });

  it('reuses a compile cache hit without generating a project or running fuse', async () => {
    const cached = {
      generated,
      fuseResult: { ok: true, code: 0, stdout: '', stderr: '' },
      testbenchName: 'mips_tb',
      exePath: 'E:/work/.co/isim/cached.exe',
      testbench: { kind: 'user' as const, moduleName: 'mips_tb', sourceUri: URI.file('E:/work/tb.v') }
    };
    const compileCache = { get: vi.fn(() => cached), set: vi.fn(), clear: vi.fn() };

    await expect(compileIsim(services(), { resource, compileCache })).resolves.toBe(cached);

    expect(generateIseProject).not.toHaveBeenCalled();
    expect(runTool).not.toHaveBeenCalled();
  });

  it('adds a generated runtime testbench to project resolution inputs', async () => {
    const generatedUri = URI.file('E:/work/.co/isim/co_generated_tb.v');
    vi.mocked(ensureP7InterruptTestbench).mockResolvedValueOnce({
      kind: 'generated',
      moduleName: 'co_generated_tb',
      generatedUri,
      sha256: 'tb-sha'
    });

    await compileIsim(services(), { resource, interruptSchedule: [0x3000] });

    expect(resolveIseProjectFiles).toHaveBeenCalledWith(expect.anything(), [generatedUri], {});
  });

  it('does not run P4-P7 simulation when ASM case selection is cancelled', async () => {
    vi.mocked(resolveAsmCaseInput).mockResolvedValueOnce(undefined);

    await expect(runIsim(services(), { resource })).resolves.toBeUndefined();

    expect(resolveAsmCaseInput).toHaveBeenCalled();
    expect(runTool).not.toHaveBeenCalled();
  });

  it('runs P1 simulation without requiring an ASM case or machine code warning', async () => {
    vi.mocked(getProfile).mockReturnValue('P1');

    const result = await runIsim(services(), { resource });

    expect(result?.simResult?.ok).toBe(true);
    expect(resolveAsmCaseInput).not.toHaveBeenCalled();
    expect(resolveMachineCodeSource).not.toHaveBeenCalled();
    expect(runTool).toHaveBeenCalledTimes(2);
  });

  it('returns the fuse process result when compilation fails before ISim starts', async () => {
    vi.mocked(getProfile).mockReturnValue('P1');
    const fuseResult = {
      ok: false,
      exitCode: 1,
      commandLine: 'D:/ISE/fuse.exe -prj mips_tb.prj',
      cwd: generated.outDir.fsPath,
      stdout: '',
      stderr: 'ERROR:HDLCompiler:806 - "E:/work/CPU.v" Line 28: Syntax error.',
      timedOut: false,
      stopped: false
    };
    vi.mocked(runTool).mockResolvedValueOnce(fuseResult);

    const result = await runIsim(services(), { resource });

    expect(result).toEqual({ generated, fuseResult });
    expect(result?.simResult).toBeUndefined();
    expect(runTool).toHaveBeenCalledOnce();
    expect(resolveMachineCodeSource).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'ISim 编译失败（退出码 1）：CPU.v:28: Syntax error.'
    );
  });

  it('records machine code, project, testbench, and sim output artifacts on successful case simulation', async () => {
    const currentCase = asmCase();
    const simOutputUri = URI.file('E:/work/.co/cases/case-1/verilog/case.sim.out');

    const result = await runIsim(services(), { resource, asmCase: currentCase, simOutputUri });

    expect(result?.simOut).toBe(simOutputUri);
    expect(copyMachineCodeToSimDirectory).toHaveBeenCalledWith(currentCase.machineCode, generated.outDir, resource);
    expect(copyAsmCaseArtifact).toHaveBeenCalledWith(
      currentCase,
      'verilog',
      expect.objectContaining({ path: expect.stringMatching(/\/E:\/work\/\.co\/isim\/code\.txt$/i) }),
      'machine-code-in-sim.txt',
      'machineCodeInSim'
    );
    expect(copyAsmCaseArtifact).toHaveBeenCalledWith(currentCase, 'verilog', generated.prj, 'isim-project.prj', 'prj');
    expect(copyAsmCaseArtifact).toHaveBeenCalledWith(currentCase, 'verilog', generated.tcl, 'isim-run.tcl', 'tcl');
    expect(recordTestbenchForAsmCase).toHaveBeenCalledWith(currentCase, expect.objectContaining({ moduleName: 'mips_tb' }));
    expect(writeTextFile).not.toHaveBeenCalledWith(simOutputUri, 'sim stdout');
    expect(writeAsmCaseArtifact).toHaveBeenCalledWith(
      currentCase,
      'verilog',
      'case.sim.out',
      'sim stdout',
      'simOut'
    );
    expect(copyAsmCaseArtifact).not.toHaveBeenCalledWith(
      currentCase,
      'verilog',
      simOutputUri,
      'case.sim.out',
      'simOut'
    );
  });

  it('does not treat a non-file output URI with the same fsPath as the case artifact', async () => {
    const currentCase = asmCase();
    const simOutputUri = URI.parse('memfs:/E:/work/.co/cases/case-1/verilog/case.sim.out');

    const result = await runIsim(services(), { resource, asmCase: currentCase, simOutputUri });

    expect(result?.simOut).toBe(simOutputUri);
    expect(writeTextFile).toHaveBeenCalledWith(simOutputUri, 'sim stdout');
    expect(writeAsmCaseArtifact).toHaveBeenCalledWith(
      currentCase,
      'verilog',
      'case.sim.out',
      'sim stdout',
      'simOut'
    );
    expect(copyAsmCaseArtifact).not.toHaveBeenCalledWith(
      currentCase,
      'verilog',
      simOutputUri,
      'case.sim.out',
      'simOut'
    );
  });

  it('does not write simulation output when the simulator process fails', async () => {
    vi.mocked(runTool)
      .mockResolvedValueOnce(createTestRunResult())
      .mockResolvedValueOnce({
        ok: false,
        exitCode: 1,
        commandLine: 'E:/work/.co/isim/mips_tb.exe',
        cwd: generated.outDir.fsPath,
        stdout: 'bad',
        stderr: 'ERROR:Simulator:999 - "C:/Users/private-user/tb.v" Line 7: Runtime failure.',
        timedOut: false,
        stopped: false
      });

    const result = await runIsim(services(), { resource, asmCase: asmCase() });

    expect(result?.simOut).toBeUndefined();
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(writeAsmCaseArtifact).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'ISim 仿真失败（退出码 1）：tb.v:7: Runtime failure.'
    );
    expect(vi.mocked(vscode.window.showErrorMessage).mock.calls.flat().join('\n'))
      .not.toContain('private-user');
  });

  it('classifies an ISim output ceiling and never writes the truncated trace', async () => {
    vi.mocked(getProfile).mockReturnValue('P1');
    vi.mocked(runTool)
      .mockResolvedValueOnce(createTestRunResult())
      .mockResolvedValueOnce({
        ok: false,
        exitCode: null,
        commandLine: 'E:/work/.co/isim/mips_tb.exe',
        cwd: generated.outDir.fsPath,
        stdout: 'bounded trace',
        stderr: '',
        timedOut: false,
        stopped: true,
        stopReason: 'stdout-limit'
      });

    const result = await runIsim(services(), { resource });

    expect(result?.simResult).toMatchObject({
      ok: false,
      stopReason: 'stdout-limit',
      stdout: 'bounded trace'
    });
    expect(result?.simOut).toBeUndefined();
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(vi.mocked(runTool).mock.calls[1][2]).toEqual(expect.objectContaining({
      maxStdoutBytes: 16 * 1024 * 1024,
      maxStderrBytes: 16 * 1024 * 1024
    }));
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'ISim 仿真输出过多，进程已终止'
    );
  });
});
