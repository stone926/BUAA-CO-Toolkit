import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import type { AppServices } from '../../types';
import type { MutableVerilogModuleProvider } from '../../language/verilog/moduleProvider';
import { parseModules } from '../../language/verilog/parser';
import { verilogDoc } from '../helpers/textDocument';
import { getSimTime } from '../../config';
import { writeTextFile } from '../../fsUtil';
import {
  ensureP7InterruptTestbench,
  ensureRunnableTestbench,
  findExistingTestbenchResolution
} from '../../verilog/testbenchResolver';
import {
  automaticRuntimeTestbenchName,
  verilogProjectExcludeGlob
} from '../../verilogSimulationFiles';
import { findWorkspaceFileCandidates } from '../../workflowInputs';

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
  config: vi.fn((_key: string, fallback: unknown) => fallback),
  getIsePath: vi.fn(() => 'D:/ISE'),
  getProfile: vi.fn(() => 'P6'),
  getRunTimeout: vi.fn(() => 120000),
  getSimTime: vi.fn(() => '200us'),
  getTestbench: vi.fn(() => 'mips_tb'),
  getTopModule: vi.fn(() => 'mips')
}));

vi.mock('../../fsUtil', async () => {
  const actual = await vi.importActual<typeof import('../../fsUtil')>('../../fsUtil');
  return {
    ...actual,
    ensureDirectory: vi.fn(async () => undefined),
    isFile: vi.fn(async () => true),
    pathExists: vi.fn(async () => false),
    workspaceFolderFor: vi.fn(() => ({ uri: URI.file('E:/work'), name: 'work', index: 0 })),
    workspaceFolderForOrFirst: vi.fn(() => ({ uri: URI.file('E:/work'), name: 'work', index: 0 })),
    writeTextFile: vi.fn(async () => undefined)
  };
});

vi.mock('../../workflowInputs', () => ({
  findWorkspaceFileCandidates: vi.fn()
}));

describe('testbench workspace discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeState.state!.activeTextEditor = undefined;
    vscodeState.state!.textDocuments.splice(0);
    vscodeState.state!.workspaceFolders.splice(0, vscodeState.state!.workspaceFolders.length, {
      uri: URI.file('E:/work'),
      name: 'work'
    });
    vi.mocked(getSimTime).mockReturnValue('1ns');
    vi.mocked(findWorkspaceFileCandidates).mockResolvedValue([]);
    vscodeState.module!.workspace.fs.readFile.mockResolvedValue(Buffer.from('module mips_tb; endmodule\n'));
  });

  it('excludes editor-owned .vscode testbench copies before conflict ranking', async () => {
    const rootTestbench = URI.file('E:/work/mips_tb.v');
    vi.mocked(findWorkspaceFileCandidates).mockImplementation(async (options) => {
      expect(options.exclude).toBe(verilogProjectExcludeGlob);
      expect(options.exclude).toContain('.vscode');
      expect(options.exclude).toContain('.vscode-test');
      return [{ uri: rootTestbench, rank: 0 }];
    });

    const result = await findExistingTestbenchResolution(URI.file('E:/work/program.asm'), 'mips_tb');

    expect(result.conflict).toBe(false);
    expect(result.resolution?.sourceUri?.fsPath).toBe(rootTestbench.fsPath);
    expect(findWorkspaceFileCandidates).toHaveBeenCalledTimes(1);
  });

  it('lets private TCL control automatic runtime-testbench termination despite stale simTime', async () => {
    const resource = URI.file('E:/work/mips.v');
    vscodeState.module!.workspace.fs.readFile.mockResolvedValue(Buffer.from([
      'module mips(clk, reset);',
      '  input clk;',
      '  input reset;',
      'endmodule'
    ].join('\n')));
    const currentServices = services();

    const result = await ensureRunnableTestbench(
      currentServices,
      resource,
      true,
      undefined,
      { nonInteractive: true }
    );

    expect(result?.kind).toBe('generated');
    const generatedText = vi.mocked(writeTextFile).mock.calls.at(-1)?.[1] as string | undefined;
    expect(generatedText).toContain("reset = 1'b0;");
    expect(generatedText).not.toContain('$finish;');
    expect(generatedText).not.toContain('#1;');
    expect(currentServices.output.appendLine).not.toHaveBeenCalled();
    expect(vscodeState.module!.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('ignores an existing early-finishing user testbench during automatic runs', async () => {
    const resource = URI.file('E:/work/mips.v');
    vscodeState.module!.workspace.fs.readFile.mockResolvedValue(Buffer.from([
      'module mips(clk, reset);',
      '  input clk;',
      '  input reset;',
      'endmodule',
      'module mips_tb;',
      '  initial begin',
      '    #1 $finish;',
      '  end',
      'endmodule'
    ].join('\n')));

    const result = await ensureRunnableTestbench(
      services(),
      resource,
      true,
      undefined,
      { nonInteractive: true }
    );

    expect(result).toMatchObject({
      kind: 'generated',
      moduleName: automaticRuntimeTestbenchName
    });
    expect(result?.sourceUri).toBeUndefined();
    expect(result?.generatedUri?.fsPath).toContain(`${automaticRuntimeTestbenchName}.v`);
    const generatedText = vi.mocked(writeTextFile).mock.calls.at(-1)?.[1] as string | undefined;
    expect(generatedText).toContain(`module ${automaticRuntimeTestbenchName};`);
    expect(generatedText).not.toContain('$finish;');
    expect(generatedText).not.toContain('module mips_tb;');
  });

  it('keeps configured simTime and generation messages for manual runtime testbenches', async () => {
    const resource = URI.file('E:/work/mips.v');
    vscodeState.module!.workspace.fs.readFile.mockResolvedValue(Buffer.from([
      'module mips(clk, reset);',
      '  input clk;',
      '  input reset;',
      'endmodule'
    ].join('\n')));
    const currentServices = services();

    await ensureRunnableTestbench(currentServices, resource, true);

    const generatedText = vi.mocked(writeTextFile).mock.calls.at(-1)?.[1] as string | undefined;
    expect(generatedText).toContain('#1;');
    expect(generatedText).toContain('$finish;');
    expect(currentServices.output.appendLine).toHaveBeenCalledWith(expect.stringContaining('co_generated_mips_tb.v'));
    expect(vscodeState.module!.window.showInformationMessage).toHaveBeenCalled();
  });

  it('does not expose automatic P7 testbench paths, target PCs, or probe scenarios', async () => {
    const resource = URI.file('E:/work/mips.v');
    vscodeState.module!.workspace.fs.readFile.mockResolvedValue(Buffer.from([
      'module mips(clk, reset);',
      '  input clk;',
      '  input reset;',
      'endmodule'
    ].join('\n')));
    const currentServices = services();

    await ensureP7InterruptTestbench(
      currentServices,
      resource,
      [0x3010],
      undefined,
      true,
      { nonInteractive: true }
    );
    await ensureP7InterruptTestbench(
      currentServices,
      resource,
      undefined,
      { scenarios: [{ id: 7, kind: 'ri' }] } as never,
      true,
      { nonInteractive: true }
    );

    expect(currentServices.output.appendLine).not.toHaveBeenCalled();
    expect(vscodeState.module!.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('uses the module registry for P7 top lookup without scanning the workspace', async () => {
    const topUri = URI.file('E:/work/src/mips.v');
    const document = verilogDoc('module mips; endmodule', topUri.toString());
    const modules = parseModules(document, document.getText());
    const registry = {
      scanning: false,
      getModule: vi.fn(),
      getModules: vi.fn((_name: string) => modules),
      allModules: vi.fn(() => []),
      updateUri: vi.fn(),
      removeUri: vi.fn()
    } satisfies MutableVerilogModuleProvider;

    const result = await ensureP7InterruptTestbench(
      services(),
      URI.file('E:/work/program.asm'),
      [0x3010],
      undefined,
      false,
      { nonInteractive: true },
      registry
    );

    expect(result).toMatchObject({
      kind: 'p7-auto',
      moduleName: 'co_generated_p7_auto_tb'
    });
    expect(result?.designSourceUri?.fsPath.toLowerCase()).toBe(topUri.fsPath.toLowerCase());
    expect(registry.getModules).toHaveBeenCalledWith('mips');
    expect(findWorkspaceFileCandidates).not.toHaveBeenCalled();
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
