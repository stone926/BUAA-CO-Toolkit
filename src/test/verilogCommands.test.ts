import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { Commands } from '../constants';
import { registerVerilog } from '../verilog';
import { defaultCoSettings } from '../language/common/settings';
import { getIsePath } from '../config';
import { runVerilogSimulation as runVerilogSimulationCore } from '../verilog/simulationRunner';
import { openIsimWaveform, exportVcdWaveform } from '../verilogWaveform';
import { generateIseProject } from '../verilog/iseProject';
import { pathExists, writeTextFile } from '../fsUtil';
import {
  buildTestbench,
  moduleAtPosition,
  parseVerilog
} from '../language/verilog/service';
import {
  defaultUserTestbenchUri,
  findExistingTestbenchResolution
} from '../verilog/testbenchResolver';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('./helpers/vscodeMock').createVscodeMockState> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('./helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  return createVscodeModuleMock(vscodeState.state, vi.fn);
});

vi.mock('../config', () => ({
  ensureConcreteProfile: vi.fn(async () => 'P4'),
  getIsePath: vi.fn(() => 'D:/ISE'),
  getSimTime: vi.fn(() => '200us'),
  getTestbench: vi.fn(() => 'mips_tb'),
  getTopModule: vi.fn(() => 'mips')
}));

vi.mock('../language/verilog/service', () => ({
  buildTestbench: vi.fn(() => 'module mips_tb; endmodule\n'),
  moduleAtPosition: vi.fn(),
  parseVerilog: vi.fn()
}));

vi.mock('../fsUtil', () => ({
  pathExists: vi.fn(),
  writeTextFile: vi.fn(async () => undefined)
}));

vi.mock('../languageClient', () => ({
  executeLanguageServerCommand: vi.fn()
}));

vi.mock('../verilogWaveform', () => ({
  exportVcdWaveform: vi.fn(async () => undefined),
  openIsimWaveform: vi.fn(async () => undefined)
}));

vi.mock('../verilog/iseProject', () => ({
  generateIseProject: vi.fn(async () => undefined)
}));

vi.mock('../verilog/documentContext', () => ({
  coSettingsForUri: vi.fn(() => defaultCoSettings),
  toTextDocument: vi.fn(() => ({ uri: 'file:///E:/work/mips.v', getText: () => 'module mips; endmodule' })),
  verilogDelayFromSimTime: vi.fn(() => 200000)
}));

vi.mock('../verilog/testbenchResolver', () => ({
  defaultUserTestbenchUri: vi.fn(),
  findExistingTestbenchResolution: vi.fn()
}));

vi.mock('../verilog/isimRunner', () => ({
  compileIsim: vi.fn(async () => undefined),
  runIsim: vi.fn(async () => undefined)
}));

vi.mock('../verilog/simulationRunner', () => ({
  setVerilogSimulationModuleRegistry: vi.fn(),
  runVerilogSimulation: vi.fn(async () => undefined)
}));

function services() {
  return { output: {} as never, statusBar: {} as never };
}

function commandMap(): Map<string, (...args: unknown[]) => unknown> {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
    commands.set(command, callback as (...args: unknown[]) => unknown);
    return { dispose: vi.fn() };
  });
  return commands;
}

function setActiveDocument(filePath: string, languageId: string, text: string): void {
  vscodeState.state!.activeTextEditor = {
    document: {
      uri: vscode.Uri.file(filePath),
      languageId,
      isDirty: false,
      getText: () => text,
      save: vi.fn(async () => true)
    },
    selection: { active: { line: 0, character: 8 } }
  };
}

function normalizedFsPath(uri: vscode.Uri): string {
  return uri.fsPath.replace(/\\/g, '/').toLowerCase();
}

describe('Verilog command registration and entry behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIsePath).mockReturnValue('D:/ISE');
    vscodeState.state!.activeTextEditor = undefined;
    vscodeState.state!.config.clear();
    vi.mocked(parseVerilog).mockReturnValue({ modules: [{ name: 'mips' }] } as never);
    vi.mocked(moduleAtPosition).mockReturnValue({ name: 'mips' } as never);
    vi.mocked(findExistingTestbenchResolution).mockResolvedValue({} as never);
    vi.mocked(defaultUserTestbenchUri).mockResolvedValue(vscode.Uri.file('E:/work/mips_tb.v'));
    vi.mocked(pathExists).mockResolvedValue(false);
  });

  it('registers Verilog commands and passes the shared module registry to simulation commands', async () => {
    const commands = commandMap();
    const moduleRegistry = { updateUri: vi.fn() };
    const svc = services();

    registerVerilog({ subscriptions: [] } as never, svc, moduleRegistry as never);
    await commands.get(Commands.Verilog.RunIsim)!();
    await commands.get(Commands.Verilog.OpenIsimWaveform)!();
    await commands.get(Commands.Verilog.ExportVcd)!();

    expect([...commands.keys()]).toEqual(expect.arrayContaining([
      Commands.Verilog.DisableLintRule,
      Commands.Verilog.GenerateTestbench,
      Commands.Verilog.GenerateIseProject,
      Commands.Verilog.CheckSyntaxWithIse,
      Commands.Verilog.RunIsim,
      Commands.Verilog.OpenIsimWaveform,
      Commands.Verilog.ExportVcd
    ]));
    expect(runVerilogSimulationCore).toHaveBeenCalledWith(svc, { moduleRegistry });
    expect(openIsimWaveform).toHaveBeenCalledWith(svc, expect.objectContaining({ moduleRegistry }));
    expect(exportVcdWaveform).toHaveBeenCalledWith(svc, expect.objectContaining({ moduleRegistry }));
  });

  it('blocks ISE-only handlers when the resource-scoped ISE path is blank', async () => {
    vi.mocked(getIsePath).mockReturnValue('   ');
    const commands = commandMap();
    registerVerilog({ subscriptions: [] } as never, services());

    await commands.get(Commands.Verilog.GenerateIseProject)!();
    await commands.get(Commands.Verilog.OpenIsimWaveform)!();
    await commands.get(Commands.Verilog.ExportVcd)!();

    expect(generateIseProject).not.toHaveBeenCalled();
    expect(openIsimWaveform).not.toHaveBeenCalled();
    expect(exportVcdWaveform).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(3);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      '此功能需要 Xilinx ISE。请先设置 co.toolchain.isePath'
    );
  });

  it('merges and deduplicates a valid lint rule disable command', async () => {
    const commands = commandMap();
    vscodeState.state!.config.set('co.verilog.lint.disabledRules', ['vc-002']);
    registerVerilog({ subscriptions: [] } as never, services());

    await commands.get(Commands.Verilog.DisableLintRule)!('VC-001');
    await commands.get(Commands.Verilog.DisableLintRule)!('vc-001');

    const config = vscode.workspace.getConfiguration('co');
    expect(config.update).toHaveBeenLastCalledWith('verilog.lint.disabledRules', ['vc-001', 'vc-002'], vscode.ConfigurationTarget.Workspace);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('rejects generate testbench when the active editor is not Verilog', async () => {
    const commands = commandMap();
    setActiveDocument('E:/work/main.asm', 'mipsasm', 'ori $0, $0, 0');
    registerVerilog({ subscriptions: [] } as never, services());

    await commands.get(Commands.Verilog.GenerateTestbench)!();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('请先打开一个 Verilog 文件');
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('opens an existing testbench when requested and only overwrites after confirmation', async () => {
    const commands = commandMap();
    const moduleRegistry = { updateUri: vi.fn() };
    setActiveDocument('E:/work/mips.v', 'verilog', 'module mips; endmodule');
    vi.mocked(pathExists).mockResolvedValue(true);
    registerVerilog({ subscriptions: [] } as never, services(), moduleRegistry as never);

    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('打开');
    await commands.get(Commands.Verilog.GenerateTestbench)!();
    const openedUri = vi.mocked(vscode.window.showTextDocument).mock.calls[0]?.[0] as vscode.Uri;
    expect(normalizedFsPath(openedUri)).toBe('e:/work/mips_tb.v');
    expect(writeTextFile).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('覆盖');
    await commands.get(Commands.Verilog.GenerateTestbench)!();
    const [writtenUri, writtenText] = vi.mocked(writeTextFile).mock.calls[0];
    expect(normalizedFsPath(writtenUri as vscode.Uri)).toBe('e:/work/mips_tb.v');
    expect(writtenText).toBe('module mips_tb; endmodule\n');
    expect(buildTestbench).toHaveBeenCalledWith(expect.objectContaining({ name: 'mips' }), 'mips_tb', expect.objectContaining({ profile: 'P4' }));
    const updatedUri = vi.mocked(moduleRegistry.updateUri).mock.calls[0]?.[0] as vscode.Uri;
    expect(normalizedFsPath(updatedUri)).toBe('e:/work/mips_tb.v');
  });
});
