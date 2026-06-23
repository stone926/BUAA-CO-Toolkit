import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { MipsParseOptions, MipsParseResult, parseMips } from './parser';
import type { MipsServerState } from './state';

interface CacheEntry {
  uri: string;
  version: number;
  text: string;
  textKey: string;
  key: string;
  parsed: MipsParseResult;
}

const MAX_CACHE_ENTRIES = 16;
const entries = new Map<string, CacheEntry>();

export function getCachedMipsParse(document: TextDocument, settings: CoSettings, state: MipsServerState): MipsParseResult {
  const settingKey = cacheKey(settings, state);
  const text = document.getText();
  const key = documentCacheKey(document.uri, document.version, settingKey);
  let currentTextKey: string | undefined;
  const cached = entries.get(key);
  if (cached) {
    if (cached.text === text) {
      touchCacheEntry(key, cached);
      return cached.parsed;
    }
    currentTextKey = textKey(text);
    if (cached.textKey === currentTextKey) {
      touchCacheEntry(key, cached);
      return cached.parsed;
    }
  }

  const options: MipsParseOptions = {
    ignoredPseudoInstructionFiles: state.ignoredPseudoInstructionFiles,
    ignoredPseudoInstructionMnemonics: state.ignoredPseudoInstructionMnemonics
  };
  const parsed = parseMips(document, settings, options);
  storeCacheEntry(key, {
    uri: document.uri,
    version: document.version,
    text,
    textKey: currentTextKey ?? textKey(text),
    key: settingKey,
    parsed
  });
  return parsed;
}

export function clearCachedMipsParse(uri?: string): void {
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

function cacheKey(settings: CoSettings, state: MipsServerState): string {
  return JSON.stringify({
    settings,
    ignoredFiles: [...state.ignoredPseudoInstructionFiles].sort(),
    ignoredMnemonics: [...state.ignoredPseudoInstructionMnemonics].sort()
  });
}

function textKey(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${hash >>> 0}`;
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
