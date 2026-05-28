import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { MipsParseOptions, MipsParseResult, parseMips } from './parser';
import type { MipsServerState } from './state';

interface CacheEntry {
  uri: string;
  version: number;
  key: string;
  parsed: MipsParseResult;
}

let entry: CacheEntry | undefined;

export function getCachedMipsParse(document: TextDocument, settings: CoSettings, state: MipsServerState): MipsParseResult {
  const key = cacheKey(settings, state);
  if (entry && entry.uri === document.uri && entry.version === document.version && entry.key === key) {
    return entry.parsed;
  }

  const options: MipsParseOptions = {
    ignoredPseudoInstructionFiles: state.ignoredPseudoInstructionFiles,
    ignoredPseudoInstructionMnemonics: state.ignoredPseudoInstructionMnemonics
  };
  const parsed = parseMips(document, settings, options);
  entry = {
    uri: document.uri,
    version: document.version,
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
