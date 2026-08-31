// @index diagnostic-settings — 诊断快速修复的资源级配置写入
import * as vscode from 'vscode';
import { configurationTargetForResource } from './config';
import { configurationResource } from './configurationResource';
import {
  defaultCoSettings,
  diagnosticCodeKey,
  diagnosticCodeToString,
  diagnosticFileCodeKey
} from './language/common/settings';

export type DiagnosticSuppressionScope = 'file' | 'workspace';

export async function disableMipsPseudoWarnings(documentUri?: string): Promise<void> {
  const resource = configurationResource(documentUri);
  await vscode.workspace.getConfiguration('co', resource).update(
    'mips.warnPseudoInstruction',
    false,
    configurationTargetForResource(resource)
  );
  vscode.window.showInformationMessage('已在当前工作区中禁用 MIPS 伪指令警告');
}

export async function disableVerilogLintRule(rule?: string, documentUri?: string): Promise<void> {
  const normalized = normalizeLintRule(rule);
  if (!normalized) {
    vscode.window.showErrorMessage('无法禁用此 Verilog Lint 规则，因为规则 ID 无效');
    return;
  }
  const resource = configurationResource(documentUri);
  const config = vscode.workspace.getConfiguration('co', resource);
  const current = config.get<string[]>('verilog.lint.disabledRules', defaultCoSettings.verilog.lint.disabledRules);
  const merged = [...new Set([...current.map((item) => item.toLowerCase()), normalized])].sort();
  await config.update('verilog.lint.disabledRules', merged, configurationTargetForResource(resource));
  vscode.window.showInformationMessage(`已在当前工作区中禁用 ${normalized.toUpperCase()}`);
}

export async function disableDiagnosticCode(
  languageId?: string,
  code?: string,
  scope?: DiagnosticSuppressionScope,
  documentUri?: string
): Promise<void> {
  const normalizedLanguageId = typeof languageId === 'string' ? languageId.trim().toLowerCase() : '';
  const normalizedCode = diagnosticCodeToString(code);
  if (!normalizedLanguageId || !normalizedCode || (scope !== 'file' && scope !== 'workspace')) {
    vscode.window.showErrorMessage('无法禁用此诊断，因为其代码或作用域无效');
    return;
  }
  const resource = configurationResource(documentUri);
  if (!resource || !documentUri?.trim()) {
    vscode.window.showErrorMessage('无法禁用此诊断，因为无法确定诊断所属工作区');
    return;
  }
  const config = vscode.workspace.getConfiguration('co', resource);
  const target = configurationTargetForResource(resource);
  if (scope === 'file') {
    const key = diagnosticFileCodeKey(normalizedLanguageId, normalizedCode, documentUri);
    const current = config.get<string[]>('diagnostics.disabledFileCodes', defaultCoSettings.diagnostics.disabledFileCodes);
    const merged = [...new Set([...current.map((item) => item.trim()).filter(Boolean), key])].sort();
    await config.update('diagnostics.disabledFileCodes', merged, target);
    vscode.window.showInformationMessage(`已在当前工作区中对该文件禁用 ${normalizedCode} 诊断`);
    return;
  }

  const key = diagnosticCodeKey(normalizedLanguageId, normalizedCode);
  const current = config.get<string[]>('diagnostics.disabledCodes', defaultCoSettings.diagnostics.disabledCodes);
  const merged = [...new Set([...current.map((item) => item.trim().toLowerCase()).filter(Boolean), key])].sort();
  await config.update('diagnostics.disabledCodes', merged, target);
  vscode.window.showInformationMessage(`已在当前工作区中禁用 ${normalizedCode} 诊断`);
}

function normalizeLintRule(rule?: string): string | undefined {
  const normalized = rule?.trim().toLowerCase();
  return normalized && /^vc-\d{3}$/.test(normalized) ? normalized : undefined;
}
