import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { addVerilogDiagnostics, parseVerilog, stripCommentsAndStrings } from './parser';
import type { VerilogParseResult } from './model';

interface CacheEntry {
  uri: string;
  version: number;
  settingsKey: string;
  text: string;
  textKey: string;
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
  const text = document.getText();
  const key = documentCacheKey(document.uri, document.version, settingKey);
  const cached = entries.get(key);
  if (cached && cachedMatchesText(cached, text) && (!includeDiagnostics || cached.hasDiagnostics)) {
    touchCacheEntry(key, cached);
    return cached.parsed;
  }
  if (cached && cachedMatchesText(cached, text) && includeDiagnostics && !cached.hasDiagnostics) {
    const parsed = addVerilogDiagnostics(document, settings, cached.parsed, text);
    const upgraded: CacheEntry = {
      ...cached,
      hasDiagnostics: true,
      parsed
    };
    storeCacheEntry(key, upgraded);
    return parsed;
  }

  const parsed = parseVerilog(document, settings, includeDiagnostics);
  const strippedText = stripCommentsAndStrings(text);
  storeCacheEntry(key, {
    uri: document.uri,
    version: document.version,
    settingsKey: settingKey,
    text,
    textKey: textKey(text),
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
  const text = document.getText();
  const key = documentCacheKey(document.uri, document.version, settingKey);
  const cached = entries.get(key);
  if (cached && cachedMatchesText(cached, text)) {
    touchCacheEntry(key, cached);
    return cached.strippedText;
  }
  getCachedVerilogParse(document, settings, false);
  const reparsed = entries.get(key);
  return reparsed && cachedMatchesText(reparsed, text) ? reparsed.strippedText : stripCommentsAndStrings(text);
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

function textKey(text: string): string {
  return `${text.length}:${hashText(text)}`;
}

function cachedMatchesText(cached: CacheEntry, text: string): boolean {
  return cached.text === text || cached.text.length === text.length && cached.textKey === textKey(text);
}

function hashText(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
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
