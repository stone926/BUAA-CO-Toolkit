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

let entry: CacheEntry | undefined;

export function getCachedMipsParse(document: TextDocument, settings: CoSettings, state: MipsServerState): MipsParseResult {
  const key = cacheKey(settings, state);
  const text = document.getText();
  let currentTextKey: string | undefined;
  if (entry && entry.uri === document.uri && entry.version === document.version && entry.key === key) {
    if (entry.text === text) {
      return entry.parsed;
    }
    currentTextKey = textKey(text);
    if (entry.textKey === currentTextKey) {
      return entry.parsed;
    }
  }

  const options: MipsParseOptions = {
    ignoredPseudoInstructionFiles: state.ignoredPseudoInstructionFiles,
    ignoredPseudoInstructionMnemonics: state.ignoredPseudoInstructionMnemonics
  };
  const parsed = parseMips(document, settings, options);
  entry = {
    uri: document.uri,
    version: document.version,
    text,
    textKey: currentTextKey ?? textKey(text),
    key,
    parsed
  };
  return parsed;
}

export function clearCachedMipsParse(uri?: string): void {
  if (!uri || entry?.uri === uri) {
    entry = undefined;
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
