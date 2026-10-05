// @index verilog-document-context — VS Code 文档到 Verilog LSP 解析上下文的适配
import * as vscode from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  config,
  getProfile,
  getRunTimeout,
  getSimTime,
  getTestbench,
  getTopModule
} from '../config';
import { CoSettings, defaultCoSettings } from '../language/common/settings';

export function toTextDocument(document: vscode.TextDocument): TextDocument {
  return TextDocument.create(document.uri.toString(), document.languageId, document.version, document.getText());
}

/** Prefer the active editor's unsaved text; otherwise read the file, skipping unreadable ones. */
export async function verilogDocumentForUri(uri: vscode.Uri): Promise<TextDocument | undefined> {
  const active = vscode.window.activeTextEditor?.document;
  if (active && active.uri.toString() === uri.toString()) {
    return toTextDocument(active);
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return TextDocument.create(uri.toString(), 'verilog', 1, Buffer.from(bytes).toString('utf8'));
  } catch {
    // 文件不可读时跳过该 Verilog 候选
    return undefined;
  }
}

export function coSettingsForUri(uri: vscode.Uri): CoSettings {
  return {
    ...defaultCoSettings,
    project: {
      ...defaultCoSettings.project,
      profile: getProfile(uri),
      topModule: getTopModule(uri),
      testbench: getTestbench(uri),
      simTime: getSimTime(uri)
    },
    run: {
      timeoutMs: getRunTimeout(uri)
    },
    verilog: {
      syntax: {
        external: {
          mode: config<CoSettings['verilog']['syntax']['external']['mode']>('verilog.syntax.external.mode', defaultCoSettings.verilog.syntax.external.mode, uri),
          timeoutMs: config<number>('verilog.syntax.external.timeoutMs', defaultCoSettings.verilog.syntax.external.timeoutMs, uri)
        }
      },
      implicitNet: {
        diagnostic: config<CoSettings['verilog']['implicitNet']['diagnostic']>('verilog.implicitNet.diagnostic', defaultCoSettings.verilog.implicitNet.diagnostic, uri),
        ignorePatterns: config<string[]>('verilog.implicitNet.ignorePatterns', defaultCoSettings.verilog.implicitNet.ignorePatterns, uri)
      },
      lint: {
        courseRules: config<boolean>('verilog.lint.courseRules', defaultCoSettings.verilog.lint.courseRules, uri)
      }
    }
  };
}
