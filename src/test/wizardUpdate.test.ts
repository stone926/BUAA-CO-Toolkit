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

  it('writes the MARS path globally before clearing folder and workspace values', async () => {
    const update = vi.fn(async () => undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      inspect: vi.fn(() => ({
        workspaceFolderValue: 'D:/old-folder/Mars.jar',
        workspaceValue: 'D:/old-workspace/Mars.jar'
      })),
      update
    } as never);

    await updateProjectSettings('P7', { mars: 'D:/new/Mars.jar' }, vscode.Uri.file('E:/work'));

    expect(update.mock.calls).toEqual([
      ['project.profile', 'P7', vscode.ConfigurationTarget.WorkspaceFolder],
      ['toolchain.mars', 'D:/new/Mars.jar', vscode.ConfigurationTarget.Global],
      ['toolchain.mars', undefined, vscode.ConfigurationTarget.WorkspaceFolder],
      ['toolchain.mars', undefined, vscode.ConfigurationTarget.Workspace]
    ]);
  });

  it('does not clear either legacy scope when the Global write fails', async () => {
    const update = vi.fn(async (_key: string, _value: unknown, target: vscode.ConfigurationTarget) => {
      if (target === vscode.ConfigurationTarget.Global) {
        throw new Error('global settings are read-only');
      }
    });
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      inspect: vi.fn(() => ({
        workspaceFolderValue: 'D:/old-folder/Mars.jar',
        workspaceValue: 'D:/old-workspace/Mars.jar'
      })),
      update
    } as never);

    await expect(updateProjectSettings('P7', { mars: 'D:/new/Mars.jar' }, vscode.Uri.file('E:/work')))
      .rejects.toThrow('global settings are read-only');

    expect(update.mock.calls).toEqual([
      ['project.profile', 'P7', vscode.ConfigurationTarget.WorkspaceFolder],
      ['toolchain.mars', 'D:/new/Mars.jar', vscode.ConfigurationTarget.Global]
    ]);
  });

  it('never asks for a P7 MARS override even with a historical MARS engine setting', async () => {
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
  });
});
