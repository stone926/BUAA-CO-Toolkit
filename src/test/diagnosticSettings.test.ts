import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  disableMipsPseudoWarnings
} from '../diagnosticSettings';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('./helpers/vscodeMock').createVscodeMockState> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('./helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  return createVscodeModuleMock(vscodeState.state, vi.fn);
});

describe('diagnostic setting commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeState.state!.config.clear();
    vscodeState.state!.workspaceFolders.splice(0);
    vscodeState.state!.workspaceFolders.push(
      { uri: vscode.Uri.file('E:/work'), name: 'work' },
      { uri: vscode.Uri.file('E:/other'), name: 'other' }
    );
    vscodeState.state!.activeTextEditor = {
      document: { uri: vscode.Uri.file('E:/other/active.v') }
    };
  });

  it('writes MIPS warning suppression to the diagnostic document folder', async () => {
    await disableMipsPseudoWarnings('file:///E:/work/main.asm');

    const configuredResource = vi.mocked(vscode.workspace.getConfiguration).mock.calls[0]?.[1] as vscode.Uri;
    expect(configuredResource.fsPath.replace(/\\/g, '/').toLowerCase()).toBe('e:/work/main.asm');
    const config = vscode.workspace.getConfiguration('co', configuredResource);
    expect(config.update).toHaveBeenLastCalledWith(
      'mips.warnPseudoInstruction',
      false,
      vscode.ConfigurationTarget.WorkspaceFolder
    );
  });

});
