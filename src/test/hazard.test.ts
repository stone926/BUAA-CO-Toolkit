import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { Commands } from '../constants';
import { registerHazard } from '../hazard';
import { assembleWithPreflight } from '../mips/providers/providerResolver';
import { ensureConcreteProfile } from '../config';
import { createTestServices } from './helpers/appServices';
import { readHazardReport } from '../hazardUi/reportStore';
import { isHazardReport } from '../hazardUi/reportValidation';
import { buildProgramImage } from '../mips/core/programImage';

const testState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('./helpers/vscodeMock').createVscodeMockState> | undefined,
  messages: [] as Array<(message: unknown) => Promise<void>>,
  cancel: false
}));
vi.mock('vscode', async () => {
  const { Utils } = await import('vscode-uri');
  const { createVscodeMockState, createVscodeModuleMock } = await import('./helpers/vscodeMock');
  testState.state = createVscodeMockState();
  const mock = createVscodeModuleMock(testState.state, vi.fn);
  Object.assign(mock.Uri, { joinPath: Utils.joinPath });
  return {
    ...mock, ProgressLocation: { Notification: 15 },
    window: {
      ...mock.window,
      withProgress: vi.fn(async (_options, task) => task({ report: vi.fn() }, {
        isCancellationRequested: testState.cancel, onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() }))
      })),
      createWebviewPanel: vi.fn(() => ({
        webview: { html: '', onDidReceiveMessage: vi.fn((callback) => { testState.messages.push(callback); return { dispose: vi.fn() }; }) },
        dispose: vi.fn(), onDidDispose: vi.fn(() => ({ dispose: vi.fn() }))
      }))
    }
  };
});
vi.mock('../config', () => ({ ensureConcreteProfile: vi.fn(async () => 'P6') }));
vi.mock('../mips/providers/providerResolver', () => ({ assembleWithPreflight: vi.fn(), preflightFailureMessage: vi.fn(() => '汇编语法错误') }));

function commandMap() {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
    commands.set(command, callback);
    return { dispose: vi.fn() };
  });
  registerHazard({ subscriptions: [] } as unknown as vscode.ExtensionContext, createTestServices());
  return commands;
}

let root: string;
let source: vscode.Uri;
beforeEach(async () => {
  vi.clearAllMocks();
  testState.cancel = false;
  testState.messages.length = 0;
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-native-hazard-'));
  source = vscode.Uri.file(path.join(root, '中文 code.txt'));
  // ori $1, $0, 1; addu $2, $1, $1; beq $0, $0, -1; nop
  await fs.promises.writeFile(source.fsPath, '34010001\n00211021\n1000ffff\n00000000\n');
  testState.state!.workspaceFolders.splice(0, testState.state!.workspaceFolders.length, { uri: vscode.Uri.file(root), name: 'cpu' });
  testState.state!.textDocuments.splice(0);
  vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([source]);
  vi.mocked(ensureConcreteProfile).mockResolvedValue('P6');
  vi.mocked(vscode.workspace.saveAll).mockResolvedValue(true);
});
afterEach(async () => {
  expect(root.startsWith(path.join(os.tmpdir(), 'co-native-hazard-'))).toBe(true);
  await fs.promises.rm(root, { recursive: true, force: true });
});

async function generatedReport() {
  const directory = path.join(root, '.co', 'hazard');
  const file = (await fs.promises.readdir(directory)).find((name) => name.endsWith('-hazard.json'))!;
  const uri = vscode.Uri.file(path.join(directory, file));
  return { uri, saved: await readHazardReport(uri) };
}

describe('native hazard command workflow', () => {
  it('runs actual machine code without tools, saves a reopenable report, and shows interactive HTML', async () => {
    const commands = commandMap();
    await commands.get(Commands.Hazard.AnalyzeCurrentMachineCode)!();
    expect(vscode.window.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      filters: { '汇编 / 机器码': ['asm', 's', 'mips', 'txt', 'hex', 'coe'] }
    }));
    expect(vi.mocked(vscode.window.showOpenDialog).mock.calls[0][0]?.defaultUri?.toString()).toBe(vscode.Uri.file(root).toString());
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    const { uri, saved } = await generatedReport();
    expect(saved.report.summary.validForwardEvents).toBeGreaterThan(0);
    expect(saved.report.stopReason).toBe('course-halt-loop');
    expect(saved.sourceUri).toBe(source.toString());
    expect(isHazardReport(saved.report)).toBe(true);
    const panel = vi.mocked(vscode.window.createWebviewPanel).mock.results[0].value;
    expect(panel.webview.html).toContain('冲突冒险报告');
    expect(assembleWithPreflight).not.toHaveBeenCalled();
    await commands.get(Commands.Hazard.OpenReport)!(uri);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
  });

  it('uses unsaved machine code text and rejects malformed input with no report', async () => {
    testState.state!.textDocuments.push({ uri: source, getText: () => 'broken machine code' });
    await commandMap().get(Commands.Hazard.AnalyzeCurrentMachineCode)!();
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, '.co', 'hazard'))).toBe(false);
  });

  it('stops quietly on selection or progress cancellation', async () => {
    const commands = commandMap();
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce(undefined);
    await commands.get(Commands.Hazard.AnalyzeCurrentMachineCode)!();
    testState.cancel = true;
    await commands.get(Commands.Hazard.AnalyzeCurrentMachineCode)!();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, '.co'))).toBe(false);
  });

  it('never falls back to old code when ASM fails or saving is cancelled', async () => {
    const asm = vscode.Uri.file(path.join(root, 'program.asm'));
    await fs.promises.writeFile(asm.fsPath, 'bad instruction');
    vi.mocked(assembleWithPreflight).mockResolvedValue({ ok: false, preflight: { ok: false, diagnostics: [], descriptor: {} as never } });
    const commands = commandMap();
    await commands.get(Commands.Hazard.AnalyzeCurrentMachineCode)!(asm);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('汇编语法错误'));
    expect(assembleWithPreflight).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requirements: expect.objectContaining({ profile: 'P6' }) }), expect.anything(), expect.objectContaining({ primaryEngineId: 'builtin-ts' }));
    vi.mocked(assembleWithPreflight).mockClear();
    vi.mocked(vscode.workspace.saveAll).mockResolvedValue(false);
    await commands.get(Commands.Hazard.AnalyzeCurrentMachineCode)!(asm);
    expect(assembleWithPreflight).not.toHaveBeenCalled();
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
  });

  it('analyzes the builtin assembler image including initialized data instead of a text dump', async () => {
    const asm = vscode.Uri.file(path.join(root, 'data.asm'));
    const image = buildProgramImage({ entryPc: 0x3000, inputGraph: [], segments: [
      { name: 'text', baseAddress: 0x3000, words: [0x8c010000, 0x00211021] },
      { name: 'data', baseAddress: 0, words: [7] }
    ] });
    const descriptor = { id: 'builtin-ts', kind: 'assembler' as const, build: 'test', semanticsRevision: 1, capabilitiesRevision: 1 };
    vi.mocked(assembleWithPreflight).mockResolvedValue({ ok: true,
      preflight: { ok: true, diagnostics: [], descriptor },
      result: { ok: true, image, descriptor, status: { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false } }
    });
    await commandMap().get(Commands.Hazard.AnalyzeCurrentMachineCode)!(asm);
    const { saved } = await generatedReport();
    expect(saved.report.imageFingerprint).toBe(image.fingerprint);
    expect(saved.report.summary.validForwardEvents).toBe(2);
    expect(saved.report.stopReason).toBe('program-end');
  });

  it('validates imported JSON and ignores arbitrary webview commands or injected paths', async () => {
    const commands = commandMap();
    await commands.get(Commands.Hazard.AnalyzeCurrentMachineCode)!();
    await testState.messages[0]({ action: 'runCommand', command: 'workbench.action.closeWindow' });
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    await testState.messages[0]({ action: 'openInput', uri: 'command:evil' });
    const opened = vi.mocked(vscode.window.showTextDocument).mock.calls[0][0] as vscode.Uri;
    expect(opened.toString()).toBe(source.toString());
    expect(vi.mocked(vscode.window.showTextDocument).mock.calls[0][1]).toEqual({ preview: false });
    const { uri, saved } = await generatedReport();
    await fs.promises.writeFile(uri.fsPath, JSON.stringify({ ...saved, sourceUri: 'command:evil' }));
    await commands.get(Commands.Hazard.OpenReport)!(uri);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('不支持此报告格式'));
    expect(isHazardReport({ ...saved.report, summary: { ...saved.report.summary, forwardCoverage: 2 } })).toBe(false);
    expect(isHazardReport({ ...saved.report, stopReason: 'made-up' })).toBe(false);
  });

  it('rejects non-pipeline profiles before running', async () => {
    vi.mocked(ensureConcreteProfile).mockResolvedValue('P4');
    await commandMap().get(Commands.Hazard.AnalyzeCurrentMachineCode)!();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('P5–P7'));
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
  });
});
