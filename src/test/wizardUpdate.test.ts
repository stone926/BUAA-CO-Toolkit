import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { configureToolchainPaths, updateProjectSettings } from '../wizard';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('./helpers/vscodeMock').createVscodeMockState> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('./helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  return createVscodeModuleMock(vscodeState.state, vi.fn);
});

describe('updateProjectSettings tool-path migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates P2 project profile without requesting or writing an external MIPS tool', async () => {
    const update = vi.fn(async () => undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      inspect: vi.fn(() => ({
        workspaceFolderValue: 'D:/old-folder/Mars.jar',
        workspaceValue: 'D:/old-workspace/Mars.jar'
      })),
      update
    } as never);

    await updateProjectSettings('P2', {}, vscode.Uri.file('E:/work'));

    expect(update.mock.calls).toEqual([
      ['project.profile', 'P2', vscode.ConfigurationTarget.WorkspaceFolder]
    ]);
  });

  it('writes a Logisim path globally before clearing folder and workspace values', async () => {
    const update = vi.fn(async () => undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      inspect: vi.fn(() => ({
        workspaceFolderValue: 'D:/old-folder/Mars.jar',
        workspaceValue: 'D:/old-workspace/Mars.jar'
      })),
      update
    } as never);

    await updateProjectSettings('P3', { logisim: 'D:/new/logisim.jar' }, vscode.Uri.file('E:/work'));

    expect(update.mock.calls).toEqual([
      ['project.profile', 'P3', vscode.ConfigurationTarget.WorkspaceFolder],
      ['toolchain.logisim', 'D:/new/logisim.jar', vscode.ConfigurationTarget.Global],
      ['toolchain.logisim', undefined, vscode.ConfigurationTarget.WorkspaceFolder],
      ['toolchain.logisim', undefined, vscode.ConfigurationTarget.Workspace]
    ]);
  });

  it('never asks for an external MIPS tool path for P2 or P7', async () => {
    const values = new Map<string, unknown>([
      ['project.profile', 'P6'],
      ['mips.engine', 'mars'],
      ['toolchain.mars', 'E:/tools/Generic-Mars.jar']
    ]);
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation(() => ({
      get: vi.fn((key: string) => values.get(key)),
      inspect: vi.fn((key: string) => ({
        workspaceFolderValue: values.get(key)
      })),
      update: vi.fn(async () => undefined)
    } as never));
    const prompts: Array<{ title?: string; value?: string }> = [];
    const showInputBox = vi.fn(async (options: { title?: string; value?: string }) => {
      prompts.push(options);
      return undefined;
    });
    (vscode.window as unknown as { showInputBox: typeof showInputBox }).showInputBox = showInputBox;

    await configureToolchainPaths('P7', vscode.Uri.file('E:/work'));

    expect(prompts).toEqual([]);

    await configureToolchainPaths('P2', vscode.Uri.file('E:/work'));
    expect(prompts).toEqual([]);
  });
});
