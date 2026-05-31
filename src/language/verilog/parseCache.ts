import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { parseVerilog, stripCommentsAndStrings } from './parser';
import type { VerilogParseResult } from './model';

interface CacheEntry {
  uri: string;
  version: number;
  settingsKey: string;
  parsed: VerilogParseResult;
  strippedText: string;
}

let entry: CacheEntry | undefined;

function settingsKey(settings: CoSettings): string {
  return JSON.stringify(settings);
}

/**
 * 获取缓存的 Verilog 解析结果。同一文档版本+配置只解析一次。
 */
export function getCachedVerilogParse(document: TextDocument, settings: CoSettings, includeDiagnostics: boolean): VerilogParseResult {
  const key = settingsKey(settings);
  if (entry && entry.uri === document.uri && entry.version === document.version && entry.settingsKey === key) {
    if (includeDiagnostics && entry.parsed.diagnostics.length === 0) {
      const parsed = parseVerilog(document, settings, true);
      entry = { uri: document.uri, version: document.version, settingsKey: key, parsed, strippedText: entry.strippedText };
      return parsed;
    }
    return entry.parsed;
  }

  const parsed = parseVerilog(document, settings, includeDiagnostics);
  const strippedText = stripCommentsAndStrings(document.getText());
  entry = { uri: document.uri, version: document.version, settingsKey: key, parsed, strippedText };
  return parsed;
}

/**
 * 获取缓存的去除注释/字符串后的文档文本。
 * 避免在 workspaceDiagnostics 等模块中重复调用 stripCommentsAndStrings。
 */
export function getCachedStrippedText(document: TextDocument, settings: CoSettings): string {
  const key = settingsKey(settings);
  if (entry && entry.uri === document.uri && entry.version === document.version && entry.settingsKey === key) {
    return entry.strippedText;
  }
  // 如果缓存未命中，先触发解析（会填充缓存）
  getCachedVerilogParse(document, settings, false);
  return entry!.strippedText;
}

export function clearCachedVerilogParse(uri?: string): void {
  if (!uri || entry?.uri === uri) {
    entry = undefined;
  }
}
