import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import type { AppServices } from '../../types';
import { ensureConcreteProfile, getSimTime } from '../../config';
import { workspaceFolderFor, writeTextFile } from '../../fsUtil';
import { generateIseProject } from '../../verilog/iseProject';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('../helpers/vscodeMock').createVscodeMockState> | undefined,
  module: undefined as ReturnType<typeof import('../helpers/vscodeMock').createVscodeModuleMock> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  vscodeState.module = createVscodeModuleMock(vscodeState.state, vi.fn);
  return vscodeState.module;
});

vi.mock('../../config', () => ({
  ensureConcreteProfile: vi.fn(),
  getSimTime: vi.fn(() => '1ns'),
  getTestbench: vi.fn(() => 'mips_tb')
}));

vi.mock('../../fsUtil', () => ({
  ensureDirectory: vi.fn(async () => undefined),
  workspaceFolderFor: vi.fn(),
  writeTextFile: vi.fn(async () => undefined)
}));

vi.mock('../../verilogSimulationFiles', () => ({
  buildIseProjectText: vi.fn((files: readonly string[]) => files.join('\n')),
  buildIsimRunTcl: vi.fn((simTime: string) => `run ${simTime};\nexit\n`),
  verilogProjectExcludeGlob: '**/.co/**'
}));

const resource = URI.file('E:/work/src/mips.v');

describe('ISE project generation visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ensureConcreteProfile).mockResolvedValue('P6' as never);
    vi.mocked(workspaceFolderFor).mockReturnValue({
      uri: URI.file('E:/work'),
      name: 'work',
      index: 0
    });
    vi.mocked(getSimTime).mockReturnValue('1ns');
  });

  it('writes private automatic PRJ/TCL artifacts without exposing paths or reading stale simTime', async () => {
    const currentServices = services();

    const result = await generateIseProject(currentServices, {
      resource,
      testbenchName: 'mips_tb',
      projectFiles: [resource],
      tclText: 'run 4195us;\nexit\n',
      nonInteractive: true
    });

    expect(result?.prj.fsPath).toMatch(/mips_tb\.prj$/i);
    expect(result?.tcl.fsPath).toMatch(/mips_tb\.tcl$/i);
    expect(writeTextFile).toHaveBeenCalledWith(result?.tcl, 'run 4195us;\nexit\n');
    expect(getSimTime).not.toHaveBeenCalled();
    expect(currentServices.output.appendLine).not.toHaveBeenCalled();
    expect(vscodeState.module!.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('preserves configured simTime and artifact messages for manual project generation', async () => {
    const currentServices = services();

    const result = await generateIseProject(currentServices, {
      resource,
      testbenchName: 'mips_tb',
      projectFiles: [resource]
    });

    expect(writeTextFile).toHaveBeenCalledWith(result?.tcl, 'run 1ns;\nexit\n');
    expect(currentServices.output.appendLine).toHaveBeenCalledWith(expect.stringMatching(/mips_tb\.prj$/i));
    expect(currentServices.output.appendLine).toHaveBeenCalledWith(expect.stringMatching(/mips_tb\.tcl$/i));
    expect(vscodeState.module!.window.showInformationMessage).toHaveBeenCalledWith('已生成 ISE PRJ/TCL 文件');
  });
});

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
