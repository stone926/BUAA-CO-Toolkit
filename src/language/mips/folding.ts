import { FoldingRange, FoldingRangeKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { DocumentResultCache } from '../common/documentResultCache';
import { CoSettings } from '../common/settings';
import { getCachedMipsParse } from './parseCache';
import { MipsServerState } from './state';

export function getMipsFoldingRanges(document: TextDocument, settings: CoSettings, state: MipsServerState): FoldingRange[] {
  return foldingCache.getOrCreate(document, 'mips-folding', () => buildMipsFoldingRanges(document, settings, state));
}

const foldingCache = new DocumentResultCache<FoldingRange[]>();

function buildMipsFoldingRanges(document: TextDocument, settings: CoSettings, state: MipsServerState): FoldingRange[] {
  const ranges: FoldingRange[] = [];

  const parsed = getCachedMipsParse(document, settings, state);
  for (const macro of parsed.semantic.macros) {
    if (macro.bodyEndLine !== undefined && macro.bodyEndLine > macro.bodyStartLine - 1) {
      ranges.push({
        startLine: macro.range.start.line,
        endLine: macro.range.end.line,
        kind: FoldingRangeKind.Region
      });
    }
  }

  ranges.push(...regionFoldingRanges(document));
  return ranges;
}

function regionFoldingRanges(document: TextDocument): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  const stack: number[] = [];
  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const text = lineAt(document, lineNumber).text;
    if (isRegionStart(text)) {
      stack.push(lineNumber);
    } else if (isRegionEnd(text)) {
      const startLine = stack.pop();
      if (startLine !== undefined && lineNumber > startLine) {
        ranges.push({
          startLine,
          endLine: lineNumber,
          kind: FoldingRangeKind.Region
        });
      }
    }
  }
  return ranges;
}

function isRegionStart(text: string): boolean {
  return startsWithRegionDirective(text, 'region');
}

function isRegionEnd(text: string): boolean {
  return startsWithRegionDirective(text, 'endregion');
}

function startsWithRegionDirective(text: string, directive: string): boolean {
  let index = 0;
  while (text[index] === ' ' || text[index] === '\t') {
    index++;
  }
  if (text[index] === '#') {
    index++;
    while (text[index] === ' ' || text[index] === '\t') {
      index++;
    }
  }
  return text.slice(index, index + directive.length).toLowerCase() === directive &&
    !isIdentifierPart(text[index + directive.length] ?? '');
}

function isIdentifierPart(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char === '_';
}
