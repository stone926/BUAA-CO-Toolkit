// @index configuration-resource — 来源文档配置作用域与报告焦点下保留的项目资源
import * as vscode from 'vscode';

let lastProjectResource: vscode.Uri | undefined;

/** Keep the source context when focus moves from an editor into a report/view. */
export function activeProjectResource(resource?: vscode.Uri): vscode.Uri | undefined {
  const eligible = (uri: vscode.Uri | undefined): uri is vscode.Uri =>
    uri?.scheme === 'file' && /\.(?:v|vh|asm|s|mips|circ)$/i.test(uri.fsPath);
  if (resource) {
    if (eligible(resource)) lastProjectResource = resource;
    return resource;
  }
  const active = vscode.window?.activeTextEditor?.document.uri;
  const visible = vscode.window?.visibleTextEditors?.map((editor) => editor.document.uri).find(eligible);
  const current = eligible(active) ? active : visible;
  if (current) lastProjectResource = current;
  if (lastProjectResource && vscode.workspace.workspaceFolders?.length &&
      !vscode.workspace.getWorkspaceFolder?.(lastProjectResource)) lastProjectResource = undefined;
  return lastProjectResource;
}

export function clearActiveProjectResource(): void {
  lastProjectResource = undefined;
}

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
