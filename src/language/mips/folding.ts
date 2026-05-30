import { FoldingRange, FoldingRangeKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { getCachedMipsParse } from './parseCache';
import { allMacros } from './parser';
import { MipsServerState } from './state';
import { stripComment } from './syntax';

export function getMipsFoldingRanges(document: TextDocument, settings: CoSettings, state: MipsServerState): FoldingRange[] {
  const ranges: FoldingRange[] = [];

  // 1. Macro body folding (.macro line to .end_macro line)
  const parsed = getCachedMipsParse(document, settings, state);
  for (const macro of allMacros(parsed)) {
    if (macro.bodyEndLine !== undefined && macro.bodyEndLine > macro.bodyStartLine - 1) {
      ranges.push({
        startLine: macro.range.start.line,
        endLine: macro.range.end.line,
        kind: FoldingRangeKind.Region
      });
    }
  }

  // 2. Region markers (# region / # endregion)
  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const text = lineAt(document, lineNumber).text;
    const stripped = stripComment(text).trim();
    if (/^#?\s*region\b/i.test(stripped)) {
      const endLine = findMatchingRegionEnd(document, lineNumber + 1);
      if (endLine !== undefined) {
        ranges.push({
          startLine: lineNumber,
          endLine,
          kind: FoldingRangeKind.Region
        });
      }
    }
  }

  return ranges;
}

function findMatchingRegionEnd(document: TextDocument, startLine: number): number | undefined {
  let depth = 1;
  for (let lineNumber = startLine; lineNumber < document.lineCount; lineNumber++) {
    const text = lineAt(document, lineNumber).text;
    const stripped = stripComment(text).trim();
    if (/^#?\s*region\b/i.test(stripped)) {
      depth++;
    } else if (/^#?\s*endregion\b/i.test(stripped)) {
      depth--;
      if (depth === 0) {
        return lineNumber;
      }
    }
  }
  return undefined;
}
