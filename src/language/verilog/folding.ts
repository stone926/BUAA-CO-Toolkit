import {
  FoldingRange,
  FoldingRangeKind
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { collectVerilogFoldingRangesFromCst, collectModuleBodyFoldingRanges } from './blockAst';
import { getCachedVerilogParse } from './parseCache';

export function getVerilogFoldingRanges(document: TextDocument, settings: CoSettings): FoldingRange[] {
  const parsed = getCachedVerilogParse(document, settings, false);
  const ranges: FoldingRange[] = [];
  ranges.push(...collectVerilogFoldingRangesFromCst(document, parsed.cst));
  ranges.push(...collectModuleBodyFoldingRanges(document, parsed.cst));
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
  return startsWithLineCommentDirective(text, 'region');
}

function isRegionEnd(text: string): boolean {
  return startsWithLineCommentDirective(text, 'endregion');
}

function startsWithLineCommentDirective(text: string, directive: string): boolean {
  let index = 0;
  while (text[index] === ' ' || text[index] === '\t') {
    index++;
  }
  if (text[index] !== '/' || text[index + 1] !== '/') {
    return false;
  }
  index += 2;
  while (text[index] === ' ' || text[index] === '\t') {
    index++;
  }
  return text.slice(index, index + directive.length).toLowerCase() === directive &&
    !isIdentifierPart(text[index + directive.length] ?? '');
}

function isIdentifierPart(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char === '_';
}
