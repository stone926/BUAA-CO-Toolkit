import { TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentResultCache } from '../common/documentResultCache';
import { CoSettings } from '../common/settings';
import { MipsParseOptions, MipsParseResult, parseMips } from './parser';
import type { MipsServerState } from './state';

const parseCache = new DocumentResultCache<MipsParseResult>();

export function getCachedMipsParse(document: TextDocument, settings: CoSettings, state: MipsServerState): MipsParseResult {
  const settingKey = cacheKey(settings, state);
  return parseCache.getOrCreate(document, settingKey, () => {
    const options: MipsParseOptions = {
      ignoredPseudoInstructionFiles: state.ignoredPseudoInstructionFiles,
      ignoredPseudoInstructionMnemonics: state.ignoredPseudoInstructionMnemonics
    };
    return parseMips(document, settings, options);
  });
}

export function getCachedMipsSemanticParse(document: TextDocument, settings: CoSettings, state: MipsServerState): MipsParseResult {
  return getCachedMipsParse(document, settings, state);
}

export function clearCachedMipsParse(uri?: string): void {
  parseCache.clear(uri);
}

function cacheKey(settings: CoSettings, state: MipsServerState): string {
  return JSON.stringify({
    settings,
    ignoredFiles: [...state.ignoredPseudoInstructionFiles].sort(),
    ignoredMnemonics: [...state.ignoredPseudoInstructionMnemonics].sort()
  });
}
