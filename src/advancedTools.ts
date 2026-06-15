import * as path from 'path';
import * as vscode from 'vscode';
import { getProfile } from './config';
import {
  AdvancedToolContext,
  buildAdvancedToolItems,
  CoActiveKind
} from './advancedToolModel';

export { buildAdvancedToolItems };

export function registerAdvancedTools(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('co.tools.openAdvanced', async () => {
      const items = buildAdvancedToolItems(contextFromActiveEditor());
      if (!items.length) {
        vscode.window.showInformationMessage('当前上下文没有可用的 CO 高级工具。请先选择 Profile 或打开 ASM / Verilog / .circ 文件。');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        items.map((item) => ({
          label: item.label,
          description: item.description,
          detail: item.detail,
          command: item.command
        })),
        {
          title: 'CO: 更多工具',
          matchOnDescription: true,
          matchOnDetail: true
        }
      );
      if (picked) {
        await vscode.commands.executeCommand(picked.command);
      }
    })
  );
}

export function activeKindForDocument(document?: vscode.TextDocument): CoActiveKind {
  if (!document) {
    return 'none';
  }
  if (document.languageId === 'mipsasm') {
    return 'mips';
  }
  if (document.languageId === 'verilog') {
    return 'verilog';
  }
  if (document.uri.scheme === 'file' && path.extname(document.uri.fsPath).toLowerCase() === '.circ') {
    return 'logisim';
  }
  return 'other';
}

function contextFromActiveEditor(): AdvancedToolContext {
  const document = vscode.window.activeTextEditor?.document;
  return {
    profile: getProfile(document?.uri),
    activeKind: activeKindForDocument(document),
    activeFileName: document?.uri.scheme === 'file' ? path.basename(document.uri.fsPath) : undefined
  };
}
