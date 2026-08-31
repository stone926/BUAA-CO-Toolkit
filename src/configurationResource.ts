// @index configuration-resource — 诊断命令按来源文档选择多根工作区配置作用域
import * as vscode from 'vscode';

/**
 * Language-server commands carry the diagnostic document URI explicitly.
 * Palette invocations have no URI and retain the active-editor fallback.
 */
export function configurationResource(documentUri?: string): vscode.Uri | undefined {
  if (documentUri) {
    try {
      return vscode.Uri.parse(documentUri, true);
    } catch {
      // Never redirect an explicitly targeted command into an unrelated active root.
      return undefined;
    }
  }
  return vscode.window.activeTextEditor?.document.uri;
}
