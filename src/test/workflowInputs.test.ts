import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  findWorkspaceFileCandidates,
  resolveActiveFile,
  resolveFileInput
} from '../workflowInputs';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('./helpers/vscodeMock').createVscodeMockState> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('./helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  return createVscodeModuleMock(vscodeState.state, vi.fn);
});

describe('workflow input resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeState.state!.activeTextEditor = undefined;
    vscodeState.state!.workspaceFolders.splice(0);
  });

  it('returns and saves the active editor file when it satisfies the predicate', async () => {
    const save = vi.fn(async () => true);
    const uri = vscode.Uri.file('E:/work/main.asm');
    vscodeState.state!.activeTextEditor = {
      document: {
        uri,
        languageId: 'mipsasm',
        isDirty: true,
        save
      }
    };

    await expect(resolveActiveFile({
      predicate: (candidate) => candidate.fsPath.endsWith('.asm'),
      saveDirty: true
    })).resolves.toBe(uri);
    expect(save).toHaveBeenCalled();
  });

  it('orders workspace candidates by rank before showing QuickPick', async () => {
    const root = vscode.Uri.file('E:/work');
    const slow = vscode.Uri.file('E:/work/slow.asm');
    const fast = vscode.Uri.file('E:/work/fast.asm');
    vscodeState.state!.workspaceFolders.push({ uri: root, name: 'work' });
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([slow, fast]);
    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async (items) => (await items)[0]);

    const picked = await resolveFileInput({
      title: '选择 ASM',
      active: false,
      include: '**/*.asm',
      exclude: '**/{node_modules,out,.git,.co}/**',
      pick: 'quickPick',
      filters: { ASM: ['asm'] },
      rank: (uri) => uri.fsPath.includes('fast') ? 0 : 10
    });

    expect(picked).toBe(fast);
    const quickPickItems = await vi.mocked(vscode.window.showQuickPick).mock.calls[0][0];
    expect(quickPickItems.map((item) => {
      if (!('uri' in item) || !(item.uri instanceof vscode.Uri)) {
        throw new Error('Expected each workspace QuickPick item to retain its URI.');
      }
      return item.uri.fsPath;
    })).toEqual([fast.fsPath, slow.fsPath]);
    expect(vscode.workspace.findFiles).toHaveBeenCalledWith('**/*.asm', '**/{node_modules,out,.git,.co}/**', 200);
  });

  it('falls back to an open dialog when no workspace candidate exists', async () => {
    const picked = vscode.Uri.file('E:/manual/code.txt');
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([]);
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce([picked]);

    await expect(resolveFileInput({
      title: '选择机器码',
      active: false,
      include: '**/code.txt',
      filters: { Text: ['txt'] }
    })).resolves.toBe(picked);
    expect(vscode.window.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '选择机器码',
      canSelectMany: false
    }));
  });

  it('returns undefined when the user cancels QuickPick or open dialog', async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([vscode.Uri.file('E:/work/a.asm'), vscode.Uri.file('E:/work/b.asm')]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);
    await expect(resolveFileInput({
      title: '选择 ASM',
      active: false,
      include: '**/*.asm',
      filters: { ASM: ['asm'] }
    })).resolves.toBeUndefined();

    vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([]);
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce(undefined);
    await expect(resolveFileInput({
      title: '选择 ASM',
      active: false,
      include: '**/*.asm',
      filters: { ASM: ['asm'] }
    })).resolves.toBeUndefined();
  });

  it('deduplicates explicit candidate paths and applies predicates before ranking', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-workflow-'));
    const source = path.join(root, 'main.asm');
    const generated = path.join(root, '.co', 'cases', 'program.asm');
    fs.mkdirSync(path.dirname(generated), { recursive: true });
    fs.writeFileSync(source, 'ori $0, $0, 0\n');
    fs.writeFileSync(generated, 'ori $0, $0, 0\n');

    const candidates = await findWorkspaceFileCandidates({
      candidatePaths: [source, source, generated],
      predicate: (uri) => !uri.fsPath.includes(`${path.sep}.co${path.sep}`),
      rank: (uri) => uri.fsPath.endsWith('main.asm') ? 0 : 10
    });

    expect(candidates.map((candidate) => candidate.uri.fsPath.toLowerCase())).toEqual([source.toLowerCase()]);
  });
});
