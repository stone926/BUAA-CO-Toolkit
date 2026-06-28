import { TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentResultCache } from '../common/documentResultCache';
import { CoSettings } from '../common/settings';
import { addVerilogDiagnostics, parseVerilog, stripCommentsAndStrings } from './parser';
import type { VerilogParseResult } from './model';

interface CachedVerilogParse {
  hasDiagnostics: boolean;
  parsed: VerilogParseResult;
  strippedText: string;
}

const parseCache = new DocumentResultCache<CachedVerilogParse>();

function settingsKey(settings: CoSettings): string {
  return JSON.stringify(settings);
}

/**
 * 获取缓存的 Verilog 解析结果。同一文档版本+配置只解析一次。
 */
export function getCachedVerilogParse(document: TextDocument, settings: CoSettings, includeDiagnostics: boolean): VerilogParseResult {
  const settingKey = settingsKey(settings);
  const cached = parseCache.getOrCreate(document, settingKey, () => createCachedVerilogParse(document, settings, includeDiagnostics));
  if (includeDiagnostics && !cached.hasDiagnostics) {
    const parsed = addVerilogDiagnostics(document, settings, cached.parsed, document.getText());
    cached.hasDiagnostics = true;
    cached.parsed = parsed;
    return parsed;
  }
  return cached.parsed;
}

/**
 * 获取缓存的去除注释/字符串后的文档文本。
 * 避免在 workspaceDiagnostics 等模块中重复调用 stripCommentsAndStrings。
 */
export function getCachedStrippedText(document: TextDocument, settings: CoSettings): string {
  const settingKey = settingsKey(settings);
  return parseCache.getOrCreate(document, settingKey, () => createCachedVerilogParse(document, settings, false)).strippedText;
}

export function clearCachedVerilogParse(uri?: string): void {
  parseCache.clear(uri);
}

function createCachedVerilogParse(document: TextDocument, settings: CoSettings, includeDiagnostics: boolean): CachedVerilogParse {
  const text = document.getText();
  return {
    hasDiagnostics: includeDiagnostics,
    parsed: parseVerilog(document, settings, includeDiagnostics),
    strippedText: stripCommentsAndStrings(text)
  };
}
