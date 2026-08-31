import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  disableDiagnosticCode,
  disableMipsPseudoWarnings,
  disableVerilogLintRule
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

  it('merges Verilog lint suppression in the diagnostic document folder', async () => {
    vscodeState.state!.config.set('co.verilog.lint.disabledRules', ['vc-002']);

    await disableVerilogLintRule('VC-001', 'file:///E:/work/cpu.v');

    const configuredResource = vi.mocked(vscode.workspace.getConfiguration).mock.calls[0]?.[1] as vscode.Uri;
    expect(configuredResource.fsPath.replace(/\\/g, '/').toLowerCase()).toBe('e:/work/cpu.v');
    const config = vscode.workspace.getConfiguration('co', configuredResource);
    expect(config.update).toHaveBeenLastCalledWith(
      'verilog.lint.disabledRules',
      ['vc-001', 'vc-002'],
      vscode.ConfigurationTarget.WorkspaceFolder
    );
  });

  it('uses the source root for workspace suppression without mistaking its URI for file scope', async () => {
    await disableDiagnosticCode(
      'verilog',
      'width-mismatch',
      'workspace',
      'file:///E:/work/cpu.v'
    );

    const configuredResource = vi.mocked(vscode.workspace.getConfiguration).mock.calls[0]?.[1] as vscode.Uri;
    expect(configuredResource.fsPath.replace(/\\/g, '/').toLowerCase()).toBe('e:/work/cpu.v');
    const config = vscode.workspace.getConfiguration('co', configuredResource);
    expect(config.update).toHaveBeenLastCalledWith(
      'diagnostics.disabledCodes',
      expect.arrayContaining(['verilog:width-mismatch']),
      vscode.ConfigurationTarget.WorkspaceFolder
    );
    expect(config.update).not.toHaveBeenCalledWith(
      'diagnostics.disabledFileCodes',
      expect.anything(),
      expect.anything()
    );
  });

  it('keeps file suppression file-scoped in the source root', async () => {
    await disableDiagnosticCode(
      'verilog',
      'width-mismatch',
      'file',
      'file:///E:/work/cpu.v'
    );

    const configuredResource = vi.mocked(vscode.workspace.getConfiguration).mock.calls[0]?.[1] as vscode.Uri;
    const config = vscode.workspace.getConfiguration('co', configuredResource);
    expect(config.update).toHaveBeenLastCalledWith(
      'diagnostics.disabledFileCodes',
      expect.arrayContaining(['verilog:width-mismatch@file:///E:/work/cpu.v']),
      vscode.ConfigurationTarget.WorkspaceFolder
    );
  });
});
