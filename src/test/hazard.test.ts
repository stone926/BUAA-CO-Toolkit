import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { Commands } from '../constants';
import { registerHazard, renderHazardReport } from '../hazard';
import { workspaceFolderForOrFirst } from '../fsUtil';
import { resolveFileInput } from '../workflowInputs';
import { runTool } from '../process';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('./helpers/vscodeMock').createVscodeMockState> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('./helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  return createVscodeModuleMock(vscodeState.state, vi.fn);
});

vi.mock('../config', () => ({
  ensureConcreteProfile: vi.fn(async () => 'P6'),
  getHazardCalculator: vi.fn(() => path.join(os.tmpdir(), 'co-hazard-tool')),
  getMachineCode: vi.fn(() => 'code.txt'),
  getProfile: vi.fn(() => 'P6'),
  resolvePython: vi.fn(async () => 'python')
}));

vi.mock('../fsUtil', () => ({
  ensureDirectory: vi.fn(async (uri: vscode.Uri) => fs.promises.mkdir(uri.fsPath, { recursive: true })),
  fileMtimeMs: vi.fn(async () => Date.now()),
  isDirectory: vi.fn(async (file: string) => fs.existsSync(file) && fs.statSync(file).isDirectory()),
  isFile: vi.fn(async (file: string) => fs.existsSync(file)),
  readTextFile: vi.fn(async (uri: vscode.Uri) => fs.promises.readFile(uri.fsPath, 'utf8')),
  workspaceFolderForOrFirst: vi.fn()
}));

vi.mock('../mips', () => ({
  runMarsFile: vi.fn()
}));

vi.mock('../process', () => ({
  revealOutputChannel: vi.fn(),
  runTool: vi.fn()
}));

vi.mock('../workflowInputs', () => ({
  resolveFileInput: vi.fn()
}));

function services() {
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

function commandMap(): Map<string, (...args: unknown[]) => unknown> {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
    commands.set(command, callback as (...args: unknown[]) => unknown);
    return { dispose: vi.fn() };
  });
  return commands;
}

describe('hazard analysis workflow and report rendering', () => {
  let root: string;
  let toolDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-hazard-work-'));
    toolDir = path.join(os.tmpdir(), 'co-hazard-tool');
    fs.mkdirSync(toolDir, { recursive: true });
    fs.writeFileSync(path.join(toolDir, 'Hazard-Calculator.jar'), '');
    fs.writeFileSync(path.join(toolDir, 'analyzer.py'), '');
    vscodeState.state!.workspaceFolders.splice(0, vscodeState.state!.workspaceFolders.length, { uri: vscode.Uri.file(root), name: 'cpu' });
    vi.mocked(workspaceFolderForOrFirst).mockReturnValue({
      uri: vscode.Uri.file(root),
      name: 'cpu',
      index: 0
    } as never);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(new TextEncoder().encode('00000000\n'));
    vi.mocked(resolveFileInput).mockResolvedValue(vscode.Uri.file(path.join(root, 'code.txt')));
    vi.mocked(runTool).mockResolvedValue({ ok: false, code: 1, stdout: 'bad', stderr: 'traceback' });
  });

  it('returns without running the analyzer when machine-code selection is cancelled', async () => {
    const commands = commandMap();
    vi.mocked(resolveFileInput).mockResolvedValueOnce(undefined);
    registerHazard({ subscriptions: [] } as never, services());

    await commands.get(Commands.Hazard.AnalyzeCurrentMachineCode)!();

    expect(runTool).not.toHaveBeenCalled();
  });

  it('reports analyzer failure without claiming a completed report', async () => {
    const commands = commandMap();
    registerHazard({ subscriptions: [] } as never, services());

    await commands.get(Commands.Hazard.AnalyzeCurrentMachineCode)!();

    const [tool, args, options] = vi.mocked(runTool).mock.calls[0];
    expect(tool).toBe('python');
    expect(args).toEqual(['analyzer.py']);
    expect((options as { cwd: string }).cwd.toLowerCase()).toMatch(/[\\/]\.co[\\/]hazard$/);
    expect((options as { stdin: string }).stdin).toBe('Ya\n');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('冲突分析失败。请查看插件输出面板');
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith('冲突分析完成');
  });

  it('renders statistic coverage metrics and warning sections from Hazard JSON', () => {
    const html = renderHazardReport({
      forward_valid_ratio: 0.75,
      forward_coverage: 0.5,
      stall_coverage: 0.25,
      forward_count: 3,
      stall_count: 2,
      grade: {
        forward: { average: 88.5, warning: ['E->D'] },
        stall: { average: 77, warning: [] }
      }
    }, vscode.Uri.file('E:/work/hazard_statistic.json'));

    expect(html).toContain('75.0%');
    expect(html).toContain('50.0%');
    expect(html).toContain('25.0%');
    expect(html).toContain('E-&gt;D');
    expect(html).toContain('hazard_statistic.json');
  });
});
