// @index verilog-document-context — VS Code 文档到 Verilog LSP 解析上下文的适配
import * as vscode from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  config,
  getIsePath,
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
    toolchain: {
      isePath: getIsePath(uri)
    },
    run: {
      timeoutMs: getRunTimeout(uri)
    },
    verilog: {
      syntax: {
        ise: {
          enabled: config<boolean>('verilog.syntax.ise.enabled', defaultCoSettings.verilog.syntax.ise.enabled, uri),
          mode: config<CoSettings['verilog']['syntax']['ise']['mode']>('verilog.syntax.ise.mode', defaultCoSettings.verilog.syntax.ise.mode, uri),
          timeoutMs: config<number>('verilog.syntax.ise.timeoutMs', defaultCoSettings.verilog.syntax.ise.timeoutMs, uri)
        }
      },
      implicitNet: {
        diagnostic: config<CoSettings['verilog']['implicitNet']['diagnostic']>('verilog.implicitNet.diagnostic', defaultCoSettings.verilog.implicitNet.diagnostic, uri),
        ignorePatterns: config<string[]>('verilog.implicitNet.ignorePatterns', defaultCoSettings.verilog.implicitNet.ignorePatterns, uri)
      },
      lint: {
        courseRules: config<boolean>('verilog.lint.courseRules', defaultCoSettings.verilog.lint.courseRules, uri),
        synthesizableHints: config<boolean>('verilog.lint.synthesizableHints', defaultCoSettings.verilog.lint.synthesizableHints, uri),
        disabledRules: config<string[]>('verilog.lint.disabledRules', defaultCoSettings.verilog.lint.disabledRules, uri)
      },
      format: {
        style: config<CoSettings['verilog']['format']['style']>('verilog.format.style', defaultCoSettings.verilog.format.style, uri),
        continuationIndent: config<number>('verilog.format.continuationIndent', defaultCoSettings.verilog.format.continuationIndent, uri),
        spaceInRange: config<boolean>('verilog.format.spaceInRange', defaultCoSettings.verilog.format.spaceInRange, uri),
        declarationRangeSpacing: config<CoSettings['verilog']['format']['declarationRangeSpacing']>('verilog.format.declarationRangeSpacing', defaultCoSettings.verilog.format.declarationRangeSpacing, uri),
        spaceBeforeInstancePorts: config<boolean>('verilog.format.spaceBeforeInstancePorts', defaultCoSettings.verilog.format.spaceBeforeInstancePorts, uri),
        separateElse: config<boolean>('verilog.format.separateElse', defaultCoSettings.verilog.format.separateElse, uri),
        maxBlankLines: config<number>('verilog.format.maxBlankLines', defaultCoSettings.verilog.format.maxBlankLines, uri)
      }
    }
  };
}

export function verilogDelayFromSimTime(simTime: string): string {
  const match = /^(\d+(?:\.\d+)?)\s*(fs|ps|ns|us|ms|s)?$/i.exec(simTime.trim());
  if (!match) {
    return '200000';
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? 'ns').toLowerCase();
  const multipliers: Record<string, number> = {
    fs: 0.000001,
    ps: 0.001,
    ns: 1,
    us: 1000,
    ms: 1000000,
    s: 1000000000
  };
  const delay = value * multipliers[unit];
  if (!Number.isFinite(delay) || delay < 0) {
    return '200000';
  }
  const rounded = Math.round(delay);
  return Math.abs(delay - rounded) < 1e-9 ? String(rounded) : Number(delay.toFixed(6)).toString();
}
