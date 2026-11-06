import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { configureVerilogProjects } from '../../verilog/projectConfiguration';
import { executeLanguageServerCommand } from '../../languageClient';

const mocks = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('../helpers/vscodeMock').createVscodeMockState> | undefined
}));
vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  mocks.state = createVscodeMockState();
  return createVscodeModuleMock(mocks.state, vi.fn);
});
vi.mock('../../languageClient', () => ({ executeLanguageServerCommand: vi.fn() }));

describe('Verilog project configuration quick fix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state!.config.clear();
    mocks.state!.workspaceFolders.splice(0);
    mocks.state!.workspaceFolders.push({ uri: vscode.Uri.file(path.resolve('projects 中文')), name: 'projects' });
  });

  it('writes portable workspace settings only when the quick fix is invoked', async () => {
    const root = mocks.state!.workspaceFolders[0].uri.fsPath;
    vi.mocked(executeLanguageServerCommand).mockResolvedValue({
      P4: [path.join(root, 'p4/top.v'), path.join(root, 'shared/alu.v')],
      P7: [path.join(root, 'p7/top.v'), path.join(root, 'shared/alu.v')]
    });
    await configureVerilogProjects(vscode.Uri.file(path.join(root, 'p4/top.v')).toString());
    const config = vscode.workspace.getConfiguration('co');
    expect(config.update).toHaveBeenCalledWith('verilog.projects', {
      P4: ['p4/top.v', 'shared/alu.v'], P7: ['p7/top.v', 'shared/alu.v']
    }, vscode.ConfigurationTarget.Workspace);
  });

  it('preserves an existing explicit configuration', async () => {
    mocks.state!.config.set('co.verilog.projects', { custom: ['rtl'] });
    await configureVerilogProjects();
    expect(executeLanguageServerCommand).not.toHaveBeenCalled();
    expect(vscode.workspace.getConfiguration('co').update).not.toHaveBeenCalled();
  });

  it('does not save an ineffective source set for a genuine duplicate', async () => {
    vi.mocked(executeLanguageServerCommand).mockResolvedValue({ workspace: ['a.v', 'b.v'] });
    await configureVerilogProjects();
    expect(vscode.workspace.getConfiguration('co').update).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('同一目录'));
  });
});
