// @index diagnostic-settings — 诊断快速修复的资源级配置写入
import * as vscode from 'vscode';
import { configurationTargetForResource } from './config';
import { configurationResource } from './configurationResource';

export async function disableMipsPseudoWarnings(documentUri?: string): Promise<void> {
  const resource = configurationResource(documentUri);
  await vscode.workspace.getConfiguration('co', resource).update(
    'mips.warnPseudoInstruction',
    false,
    configurationTargetForResource(resource)
  );
  vscode.window.showInformationMessage('已在当前工作区中禁用 MIPS 伪指令警告');
}
