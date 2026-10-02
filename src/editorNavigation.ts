// @index orchestration — 编辑器导航统一策略：复用已有文本页签，否则在当前组打开
import * as vscode from 'vscode';
import { normalizePathKey } from './pathUtils';

/** A navigation action never creates an editor group implicitly. */
export function textEditorColumn(uri: vscode.Uri): vscode.ViewColumn {
  const groups = vscode.window.tabGroups?.all ?? [];
  const key = uriKey(uri);
  const existing = (group: vscode.TabGroup) => group.tabs.some(tab =>
    tab.input instanceof vscode.TabInputText && uriKey(tab.input.uri) === key);
  const active = groups.find(group => group.isActive && existing(group));
  return (active ?? groups.find(existing))?.viewColumn ?? vscode.ViewColumn.Active;
}

function uriKey(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? `file:${normalizePathKey(uri.fsPath)}` : uri.toString();
}
