// @index verilog-project-configuration — persist inferred source sets from the project quick fix
import * as path from 'path';
import * as vscode from 'vscode';
import { Commands } from '../constants';
import { executeLanguageServerCommand } from '../languageClient';
import { normalizeVerilogProjects } from '../language/verilog/projectContext';

export async function configureVerilogProjects(documentUri?: string): Promise<void> {
  const resource = documentUri ? vscode.Uri.parse(documentUri) : vscode.window.activeTextEditor?.document.uri;
  if (!vscode.workspace.workspaceFolders?.length) return;
  const configuration = vscode.workspace.getConfiguration('co', resource);
  if (Object.keys(normalizeVerilogProjects(configuration.get('verilog.projects'))).length) {
    void vscode.window.showInformationMessage('当前工作区已有显式 Verilog 工程配置，请在设置中调整 co.verilog.projects。');
    return;
  }
  const projects = normalizeVerilogProjects(await executeLanguageServerCommand(Commands.Server.InferVerilogProjects));
  if (Object.keys(projects).length < 2) {
    void vscode.window.showInformationMessage('未发现可按目录分开的独立设计。同一目录中的重复模块仍需调整源码或显式配置 co.verilog.projects。');
    return;
  }
  // One workspace can use portable relative paths; multi-root window settings
  // use absolute sources to avoid applying another folder's relative paths.
  const folders = vscode.workspace.workspaceFolders;
  const sources = folders.length === 1
    ? Object.fromEntries(Object.entries(projects).map(([name, files]) =>
      [name, files.map((file) => path.relative(folders[0].uri.fsPath, file).replace(/\\/g, '/'))]))
    : projects;
  // Recheck after awaiting indexing: never overwrite a concurrent user edit.
  if (Object.keys(normalizeVerilogProjects(configuration.get('verilog.projects'))).length) return;
  await configuration.update('verilog.projects', sources, vscode.ConfigurationTarget.Workspace);
  void vscode.window.showInformationMessage(`已配置 ${Object.keys(projects).length} 个 Verilog 工程；共享依赖已加入各自源集合。`);
}
