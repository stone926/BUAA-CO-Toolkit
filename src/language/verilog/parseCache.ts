import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { parseVerilog, stripCommentsAndStrings } from './parser';
import type { VerilogParseResult } from './model';

interface CacheEntry {
  uri: string;
  version: number;
  settingsKey: string;
  hasDiagnostics: boolean;
  parsed: VerilogParseResult;
  strippedText: string;
}

const MAX_CACHE_ENTRIES = 16;
const entries = new Map<string, CacheEntry>();

function settingsKey(settings: CoSettings): string {
  return JSON.stringify(settings);
}

/**
 * 获取缓存的 Verilog 解析结果。同一文档版本+配置只解析一次。
 */
export function getCachedVerilogParse(document: TextDocument, settings: CoSettings, includeDiagnostics: boolean): VerilogParseResult {
  const settingKey = settingsKey(settings);
  const key = documentCacheKey(document.uri, document.version, settingKey);
  const cached = entries.get(key);
  if (cached && (!includeDiagnostics || cached.hasDiagnostics)) {
    touchCacheEntry(key, cached);
    return cached.parsed;
  }
  if (cached && includeDiagnostics && !cached.hasDiagnostics) {
    const parsed = parseVerilog(document, settings, true);
    const upgraded: CacheEntry = {
      ...cached,
      hasDiagnostics: true,
      parsed
    };
    storeCacheEntry(key, upgraded);
    return parsed;
  }

  const parsed = parseVerilog(document, settings, includeDiagnostics);
  const strippedText = stripCommentsAndStrings(document.getText());
  storeCacheEntry(key, {
    uri: document.uri,
    version: document.version,
    settingsKey: settingKey,
    hasDiagnostics: includeDiagnostics,
    parsed,
    strippedText
  });
  return parsed;
}

/**
 * 获取缓存的去除注释/字符串后的文档文本。
 * 避免在 workspaceDiagnostics 等模块中重复调用 stripCommentsAndStrings。
 */
export function getCachedStrippedText(document: TextDocument, settings: CoSettings): string {
  const settingKey = settingsKey(settings);
  const key = documentCacheKey(document.uri, document.version, settingKey);
  const cached = entries.get(key);
  if (cached) {
    touchCacheEntry(key, cached);
    return cached.strippedText;
  }
  getCachedVerilogParse(document, settings, false);
  return entries.get(key)?.strippedText ?? stripCommentsAndStrings(document.getText());
}

export function clearCachedVerilogParse(uri?: string): void {
  if (!uri) {
    entries.clear();
    return;
  }
  for (const [key, cached] of entries) {
    if (cached.uri === uri) {
      entries.delete(key);
    }
  }
}

function documentCacheKey(uri: string, version: number, settings: string): string {
  return `${uri}\u0000${version}\u0000${settings}`;
}

function storeCacheEntry(key: string, value: CacheEntry): void {
  if (entries.has(key)) {
    entries.delete(key);
  }
  entries.set(key, value);
  while (entries.size > MAX_CACHE_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    entries.delete(oldest);
  }
}

function touchCacheEntry(key: string, value: CacheEntry): void {
  entries.delete(key);
  entries.set(key, value);
}
