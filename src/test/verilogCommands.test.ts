import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { Commands } from '../constants';
import { registerVerilog } from '../verilog';
import { defaultCoSettings } from '../language/common/settings';
import { runVerilogSimulation as runVerilogSimulationCore } from '../verilog/simulationRunner';
import { pathExists, writeTextFile } from '../fsUtil';
import { moduleAtPosition } from '../language/verilog/moduleUtils';
import { parseVerilogModuleDeclarations } from '../language/verilog/moduleDeclarations';
import {
  findExistingTestbenchResolution,
  userTestbenchText
} from '../verilog/testbenchResolver';
import {
  createUserTestbench,
  isUserTestbenchUri,
  userTestbenchUri
} from '../verilog/userTestbench';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('./helpers/vscodeMock').createVscodeMockState> | undefined,
  showWarningMessage: vi.fn<(message: string, ...items: string[]) => Promise<string | undefined>>(async () => undefined)
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('./helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  const module = createVscodeModuleMock(vscodeState.state, vi.fn);
  module.window.showWarningMessage = vscodeState.showWarningMessage;
  return module;
});

vi.mock('../config', () => ({
  configurationTargetForResource: vi.fn((resource?: unknown) => resource ? 3 : 1),
  ensureConcreteProfile: vi.fn(async () => 'P4'),
  getSimTime: vi.fn(() => '200us'),
  getTestbench: vi.fn(() => 'mips_tb'),
  getTopModule: vi.fn(() => 'mips')
}));

vi.mock('../language/verilog/moduleUtils', () => ({ moduleAtPosition: vi.fn() }));
vi.mock('../language/verilog/moduleDeclarations', () => ({ parseVerilogModuleDeclarations: vi.fn() }));

vi.mock('../fsUtil', () => ({
  pathExists: vi.fn(),
  writeTextFile: vi.fn(async () => undefined)
}));

vi.mock('../languageClient', () => ({
  executeLanguageServerCommand: vi.fn()
}));

vi.mock('../verilog/documentContext', () => ({
  coSettingsForUri: vi.fn(() => defaultCoSettings),
  toTextDocument: vi.fn(() => ({ uri: 'file:///E:/work/mips.v', getText: () => 'module mips; endmodule' }))
}));

vi.mock('../verilog/testbenchResolver', () => ({
  findExistingTestbenchResolution: vi.fn(),
  userTestbenchText: vi.fn(() => 'module mips_tb; endmodule\n')
}));

vi.mock('../verilog/userTestbench', () => ({
  createUserTestbench: vi.fn(async () => true),
  isUserTestbenchUri: vi.fn(() => false),
  userTestbenchUri: vi.fn()
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
    vscodeState.state!.activeTextEditor = undefined;
    vscodeState.state!.config.clear();
    vi.mocked(parseVerilogModuleDeclarations).mockReturnValue([{ name: 'mips' }] as never);
    vi.mocked(moduleAtPosition).mockReturnValue({ name: 'mips' } as never);
    vi.mocked(findExistingTestbenchResolution).mockResolvedValue({} as never);
    vi.mocked(userTestbenchUri).mockReturnValue(vscode.Uri.file('E:/work/.co/tb/mips_tb.v'));
    vi.mocked(isUserTestbenchUri).mockReturnValue(false);
    vi.mocked(userTestbenchText).mockReturnValue('module mips_tb; endmodule\n');
    vi.mocked(pathExists).mockResolvedValue(false);
  });

  it('registers Verilog commands and passes the shared module registry to simulation commands', async () => {
    const commands = commandMap();
    const moduleRegistry = { updateUri: vi.fn() };
    const svc = services();

    registerVerilog({ subscriptions: [] } as never, svc, moduleRegistry as never);
    await commands.get(Commands.Verilog.RunSimulation)!();

    expect([...commands.keys()]).toEqual([
      Commands.Verilog.GenerateTestbench,
      Commands.Verilog.CheckSyntax,
      Commands.Verilog.RunSimulation
    ]);
    expect(runVerilogSimulationCore).toHaveBeenCalledWith(svc, { moduleRegistry });
  });

  it('rejects generate testbench when the active editor is not Verilog', async () => {
    const commands = commandMap();
    setActiveDocument('E:/work/main.asm', 'mipsasm', 'ori $0, $0, 0');
    registerVerilog({ subscriptions: [] } as never, services());

    await commands.get(Commands.Verilog.GenerateTestbench)!();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('请先打开一个 Verilog 文件');
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('opens an unusable existing .co/tb file when requested and only overwrites after confirmation', async () => {
    const commands = commandMap();
    const moduleRegistry = { updateUri: vi.fn() };
    setActiveDocument('E:/work/mips.v', 'verilog', 'module mips; endmodule');
    vi.mocked(pathExists).mockResolvedValue(true);
    registerVerilog({ subscriptions: [] } as never, services(), moduleRegistry as never);

    vscodeState.showWarningMessage.mockResolvedValueOnce('打开');
    await commands.get(Commands.Verilog.GenerateTestbench)!();
    const openedUri = vi.mocked(vscode.window.showTextDocument).mock.calls[0]?.[0] as vscode.Uri;
    expect(normalizedFsPath(openedUri)).toBe('e:/work/.co/tb/mips_tb.v');
    expect(writeTextFile).not.toHaveBeenCalled();

    vscodeState.showWarningMessage.mockResolvedValueOnce('覆盖');
    await commands.get(Commands.Verilog.GenerateTestbench)!();
    const [writtenUri, writtenText] = vi.mocked(writeTextFile).mock.calls[0];
    expect(normalizedFsPath(writtenUri as vscode.Uri)).toBe('e:/work/.co/tb/mips_tb.v');
    expect(writtenText).toBe('module mips_tb; endmodule\n');
    expect(userTestbenchText).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'mips' }),
      'mips_tb',
      { profile: 'P4', configuredTop: true, simTime: '200us' }
    );
    expect(createUserTestbench).not.toHaveBeenCalled();
    // .co/tb stays outside the project module registry.
    expect(moduleRegistry.updateUri).not.toHaveBeenCalled();
  });

  it('creates a missing testbench in .co/tb without replacing existing files', async () => {
    const commands = commandMap();
    setActiveDocument('E:/work/alu.v', 'verilog', 'module alu; endmodule');
    vi.mocked(parseVerilogModuleDeclarations).mockReturnValue([{ name: 'alu' }] as never);
    vi.mocked(moduleAtPosition).mockReturnValue({ name: 'alu' } as never);
    vi.mocked(userTestbenchUri).mockReturnValue(vscode.Uri.file('E:/work/.co/tb/alu_tb.v'));
    vi.mocked(userTestbenchText).mockReturnValue('module alu_tb; endmodule\n');
    registerVerilog({ subscriptions: [] } as never, services());

    await commands.get(Commands.Verilog.GenerateTestbench)!();

    expect(vi.mocked(userTestbenchUri).mock.calls[0]?.[1]).toBe('alu_tb');
    expect(userTestbenchText).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'alu' }),
      'alu_tb',
      { profile: 'P4', configuredTop: false, simTime: '200us' }
    );
    const [createdUri, createdText] = vi.mocked(createUserTestbench).mock.calls[0];
    expect(normalizedFsPath(createdUri)).toBe('e:/work/.co/tb/alu_tb.v');
    expect(createdText).toBe('module alu_tb; endmodule\n');
    expect(writeTextFile).not.toHaveBeenCalled();
    const [openedUri, openOptions] = vi.mocked(vscode.window.showTextDocument).mock.calls[0] ?? [];
    expect(normalizedFsPath(openedUri as vscode.Uri)).toBe('e:/work/.co/tb/alu_tb.v');
    expect(openOptions).toEqual({ preview: false });
  });

  it('opens the resolved testbench instead of generating another one', async () => {
    const commands = commandMap();
    setActiveDocument('E:/work/alu.v', 'verilog', 'module alu; endmodule');
    vi.mocked(moduleAtPosition).mockReturnValue({ name: 'alu' } as never);
    vi.mocked(findExistingTestbenchResolution).mockResolvedValue({
      conflict: false,
      resolution: { moduleName: 'alu_tb', kind: 'user', sourceUri: vscode.Uri.file('E:/work/.co/tb/alu_tb.v') }
    });
    registerVerilog({ subscriptions: [] } as never, services());

    await commands.get(Commands.Verilog.GenerateTestbench)!();

    const openedUri = vi.mocked(vscode.window.showTextDocument).mock.calls[0]?.[0] as vscode.Uri;
    expect(normalizedFsPath(openedUri)).toBe('e:/work/.co/tb/alu_tb.v');
    expect(createUserTestbench).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('does not generate a testbench for a file that already is a .co/tb testbench', async () => {
    const commands = commandMap();
    setActiveDocument('E:/work/.co/tb/alu_tb.v', 'verilog', 'module alu_tb; endmodule');
    vi.mocked(isUserTestbenchUri).mockReturnValue(true);
    registerVerilog({ subscriptions: [] } as never, services());

    await commands.get(Commands.Verilog.GenerateTestbench)!();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      '当前文件已是用户 testbench，编写激励后点击运行即可仿真'
    );
    expect(createUserTestbench).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it.each(['alu_tb.v', 'alu_testbench.v', 'tb.v', 'testbench.v', '.co/iverilog/co_generated_auto_tb.v'])(
    'does not generate another testbench from %s', async (file) => {
      const commands = commandMap();
      setActiveDocument(`E:/work/${file}`, 'verilog', 'module arbitrary_name; endmodule');
      registerVerilog({ subscriptions: [] } as never, services());

      await commands.get(Commands.Verilog.GenerateTestbench)!();

      expect(createUserTestbench).not.toHaveBeenCalled();
      expect(writeTextFile).not.toHaveBeenCalled();
      expect(findExistingTestbenchResolution).not.toHaveBeenCalled();
    }
  );
});
