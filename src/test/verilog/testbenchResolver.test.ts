import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import type { AppServices } from '../../types';
import type { MutableVerilogModuleProvider } from '../../language/verilog/moduleProvider';
import { parseModules } from '../../language/verilog/parser';
import { verilogDoc } from '../helpers/textDocument';
import { writeTextFile, writeTextFileIfAbsent } from '../../fsUtil';
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
    writeTextFile: vi.fn(async () => undefined),
    writeTextFileIfAbsent: vi.fn(async () => true)
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

  it('places standard and case-specific P7 automatic testbenches inside their runtime slot', async () => {
    const resource = URI.file('E:/work/mips.v');
    vscodeState.module!.workspace.fs.readFile.mockResolvedValue(Buffer.from('module mips(input clk, reset); endmodule'));
    const runtimeDirectory = URI.file('E:/work/.co/iverilog/automatic/slot-3');
    const standard = await ensureRunnableTestbench(services(), resource, false, undefined, {
      nonInteractive: true, runtimeDirectory
    });
    const p7 = await ensureP7InterruptTestbench(services(), resource, [0x3010], undefined, false, {
      nonInteractive: true, runtimeDirectory
    });
    for (const resolution of [standard, p7]) {
      expect(resolution?.generatedUri?.fsPath.replace(/\\/g, '/'))
        .toContain('/.co/iverilog/automatic/slot-3/');
    }
    expect(writeTextFile).toHaveBeenCalledTimes(2);
  });

  it('creates an editable course CPU .co/tb and stops the first manual P6 run', async () => {
    const resource = URI.file('E:/work/mips.v');
    vscodeState.module!.workspace.fs.readFile.mockResolvedValue(Buffer.from([
      'module mips(clk, reset);',
      '  input clk;',
      '  input reset;',
      'endmodule'
    ].join('\n')));
    const currentServices = services();

    const result = await ensureRunnableTestbench(currentServices, resource, true);

    expect(result).toBeUndefined();
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(writeTextFileIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: expect.stringMatching(/\.co[\\/]tb[\\/]mips_tb\.v$/i) }),
      expect.stringContaining('// CO_USER_CPU_TESTBENCH P6')
    );
    expect(vscodeState.module!.window.showTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: expect.stringMatching(/\.co[\\/]tb[\\/]mips_tb\.v$/i) }),
      { preview: false }
    );
    expect(vscodeState.module!.window.showInformationMessage).toHaveBeenCalled();
  });

  it('creates an editable course CPU .co/tb and continues the first manual P6 run after input preparation', async () => {
    const resource = URI.file('E:/work/mips.v');
    vscodeState.module!.workspace.fs.readFile.mockResolvedValue(Buffer.from([
      'module mips(clk, reset);',
      '  input clk;',
      '  input reset;',
      'endmodule'
    ].join('\n')));
    const currentServices = services();

    const beforeCreateUserCpuTestbench = vi.fn(async () => {
      expect(writeTextFileIfAbsent).not.toHaveBeenCalled();
      return true;
    });
    const result = await ensureRunnableTestbench(currentServices, resource, true, undefined, { beforeCreateUserCpuTestbench });
    expect(beforeCreateUserCpuTestbench).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: expect.stringMatching(/\.co[\\/]tb[\\/]mips_tb\.v$/i) }), 'P6'
    );

    expect(result).toMatchObject({ moduleName: 'mips_tb', kind: 'user', designSourceUri: resource });
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(writeTextFileIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: expect.stringMatching(/\.co[\\/]tb[\\/]mips_tb\.v$/i) }),
      expect.stringContaining('// CO_USER_CPU_TESTBENCH P6')
    );
    expect(vscodeState.module!.window.showTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: expect.stringMatching(/\.co[\\/]tb[\\/]mips_tb\.v$/i) }),
      { preview: false }
    );
    expect(vscodeState.module!.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does not create a CPU testbench when input preparation is cancelled', async () => {
    const resource = URI.file('E:/work/mips.v');
    vscodeState.module!.workspace.fs.readFile.mockResolvedValue(Buffer.from('module mips(input clk, reset); endmodule'));
    const result = await ensureRunnableTestbench(services(), resource, true, undefined, {
      beforeCreateUserCpuTestbench: async () => false
    });
    expect(result).toBeUndefined();
    expect(writeTextFileIfAbsent).not.toHaveBeenCalled();
    expect(vscodeState.module!.window.showTextDocument).not.toHaveBeenCalled();
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

  it('does not create a private P7 testbench for an interactive run', async () => {
    const result = await ensureP7InterruptTestbench(
      services(), URI.file('E:/work/mips.v'), [0x3010], undefined, true
    );

    expect(result).toBeUndefined();
    expect(writeTextFile).not.toHaveBeenCalled();
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

  it('ignores a custom testbench source when locating the automatic DUT top', async () => {
    const testbenchUri = URI.file('E:/work/test/fake_tb.v');
    const dutUri = URI.file('E:/work/src/mips.v');
    const testbenchDoc = verilogDoc('module mips(input bogus); endmodule', testbenchUri.toString());
    const customModules = parseModules(testbenchDoc, testbenchDoc.getText());
    const registry = {
      scanning: false,
      getModule: vi.fn(),
      getModules: vi.fn(() => customModules),
      allModules: vi.fn(() => []),
      updateUri: vi.fn(),
      removeUri: vi.fn()
    } satisfies MutableVerilogModuleProvider;
    vi.mocked(findWorkspaceFileCandidates).mockResolvedValue([{ uri: dutUri, rank: 0 }]);
    vscodeState.module!.workspace.fs.readFile.mockResolvedValue(Buffer.from('module mips(input clk, input reset); endmodule'));

    const result = await ensureRunnableTestbench(
      services(), URI.file('E:/work/program.asm'), false, registry, { nonInteractive: true }
    );

    expect(result?.designSourceUri?.fsPath.toLowerCase()).toBe(dutUri.fsPath.toLowerCase());
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
