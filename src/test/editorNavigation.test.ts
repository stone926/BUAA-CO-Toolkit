import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { textEditorColumn } from '../editorNavigation';

vi.mock('vscode', async () => {
  const { URI } = await import('vscode-uri');
  return {
    Uri: URI, ViewColumn: { Active: -1, Beside: -2 },
    TabInputText: class { constructor(readonly uri: unknown) {} },
    window: { tabGroups: { all: [] as unknown[] } }
  };
});

describe('editor navigation without implicit splits', () => {
  const target = vscode.Uri.file('E:/CPU 工程/ALU.v');
  const group = (column: number, active: boolean, uris: vscode.Uri[]) => ({
    viewColumn: column, isActive: active, tabs: uris.map(uri => ({ input: new vscode.TabInputText(uri) }))
  });
  const groups = (...values: unknown[]) => {
    (vscode.window.tabGroups.all as unknown as unknown[]).splice(0, Infinity, ...values);
  };
  it('opens new sources in the current group even when other groups already exist', () => {
    groups(group(1, false, []), group(2, true, []));
    expect(textEditorColumn(target)).toBe(vscode.ViewColumn.Active);
  });
  it('reuses a hidden source tab and normalizes Windows paths', () => {
    groups(group(1, false, [vscode.Uri.file('e:/cpu 工程/alu.v')]), group(2, true, []));
    expect(textEditorColumn(target)).toBe(1);
  });
  it('prefers an existing tab in the active group when the user has intentionally split the file', () => {
    groups(group(1, false, [target]), group(3, true, [target]));
    expect(textEditorColumn(target)).toBe(3);
  });
});
