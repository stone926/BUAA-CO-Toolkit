import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { configurationResource } from '../configurationResource';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('./helpers/vscodeMock').createVscodeMockState> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('./helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  return createVscodeModuleMock(vscodeState.state, vi.fn);
});

describe('configurationResource', () => {
  beforeEach(() => {
    vscodeState.state!.activeTextEditor = {
      document: { uri: vscode.Uri.file('E:/other/active.v') }
    };
  });

  it('prefers the diagnostic document URI over the active editor', () => {
    const resource = configurationResource('file:///E:/work/cpu.v');
    expect(resource?.fsPath.replace(/\\/g, '/').toLowerCase()).toBe('e:/work/cpu.v');
  });

  it('keeps the active editor fallback for command-palette invocation', () => {
    expect(configurationResource()?.toString()).toBe('file:///e%3A/other/active.v');
  });

  it('does not redirect a malformed explicit URI into the active editor root', () => {
    expect(configurationResource('not a URI')).toBeUndefined();
  });
});
