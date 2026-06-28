import { TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentResultCache } from '../common/documentResultCache';
import { CoSettings, defaultCoSettings } from '../common/settings';
import { addVerilogDiagnostics, parseVerilog, stripCommentsAndStrings } from './parser';
import type { VerilogParseResult } from './model';

interface CachedVerilogParse {
  parsed: VerilogParseResult;
  strippedText: string;
  diagnosticsBySettings: Map<string, VerilogParseResult>;
}

const parseCache = new DocumentResultCache<CachedVerilogParse>();
const structuralParseDiscriminator = 'verilog-structural';

function settingsKey(settings: CoSettings): string {
  return JSON.stringify(settings);
}

/**
 * 获取缓存的 Verilog 解析结果。同一文档版本+配置只解析一次。
 */
export function getCachedVerilogParse(document: TextDocument, settings: CoSettings, includeDiagnostics: boolean): VerilogParseResult {
  const cached = parseCache.getOrCreate(document, structuralParseDiscriminator, () => createCachedVerilogParse(document));
  if (!includeDiagnostics) {
    return cached.parsed;
  }
  const settingKey = settingsKey(settings);
  const existing = cached.diagnosticsBySettings.get(settingKey);
  if (existing) {
    return existing;
  }
  const parsed = addVerilogDiagnostics(document, settings, cached.parsed, document.getText());
  cached.diagnosticsBySettings.set(settingKey, parsed);
  return parsed;
}

/**
 * 获取缓存的去除注释/字符串后的文档文本。
 * 避免在 workspaceDiagnostics 等模块中重复调用 stripCommentsAndStrings。
 */
export function getCachedStrippedText(document: TextDocument, _settings: CoSettings): string {
  return parseCache.getOrCreate(document, structuralParseDiscriminator, () => createCachedVerilogParse(document)).strippedText;
}

export function clearCachedVerilogParse(uri?: string): void {
  parseCache.clear(uri);
}

function createCachedVerilogParse(document: TextDocument): CachedVerilogParse {
  const text = document.getText();
  return {
    parsed: parseVerilog(document, defaultCoSettings, false),
    strippedText: stripCommentsAndStrings(text),
    diagnosticsBySettings: new Map()
  };
}
