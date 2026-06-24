import {
  FoldingRange,
  FoldingRangeKind
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { DocumentResultCache } from '../common/documentResultCache';
import { CoSettings, defaultCoSettings } from '../common/settings';
import { getCachedVerilogParse } from './parseCache';
import type { VerilogAstDocument } from './ast';
import type { VerilogProceduralStatementAst } from './proceduralAst';

const foldingCache = new DocumentResultCache<FoldingRange[]>();

export function getVerilogFoldingRanges(document: TextDocument, _settings: CoSettings): FoldingRange[] {
  return foldingCache.getOrCreate(document, 'verilog-folding', () => buildVerilogFoldingRanges(document));
}

function buildVerilogFoldingRanges(document: TextDocument): FoldingRange[] {
  const parsed = getCachedVerilogParse(document, defaultCoSettings, false);
  const ranges: FoldingRange[] = [];
  ranges.push(...astFoldingRanges(parsed.ast));
  ranges.push(...regionFoldingRanges(document));
  return dedupeFoldingRanges(ranges);
}

function astFoldingRanges(ast: VerilogAstDocument): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  for (const moduleAst of ast.modules) {
    pushRangeFold(ranges, moduleAst.headerRange);
    for (const instance of moduleAst.instances) {
      if (instance.instance.portListRange || instance.instance.parameterListRange) {
        pushRangeFold(ranges, instance.range);
      }
    }
    for (const block of moduleAst.alwaysBlocks) {
      pushProceduralStatementFolds(ranges, block.statementTree);
    }
    for (const block of moduleAst.proceduralBlocks) {
      pushProceduralStatementFolds(ranges, block.statementTree);
    }
  }
  return ranges;
}

function pushProceduralStatementFolds(ranges: FoldingRange[], statement: VerilogProceduralStatementAst): void {
  if (statement.kind === 'block' || statement.kind === 'case') {
    pushRangeFold(ranges, statement.range);
  }
  switch (statement.kind) {
    case 'block':
      for (const child of statement.statements) {
        pushProceduralStatementFolds(ranges, child);
      }
      return;
    case 'if':
      pushProceduralStatementFolds(ranges, statement.consequent);
      if (statement.alternate) {
        pushProceduralStatementFolds(ranges, statement.alternate);
      }
      return;
    case 'case':
      for (const item of statement.items) {
        pushProceduralStatementFolds(ranges, item.body);
      }
      return;
    case 'loop':
      pushProceduralStatementFolds(ranges, statement.body);
      return;
  }
}

function pushRangeFold(ranges: FoldingRange[], range: { start: { line: number }; end: { line: number } }): void {
  if (range.end.line <= range.start.line) {
    return;
  }
  ranges.push({
    startLine: range.start.line,
    endLine: range.end.line,
    kind: FoldingRangeKind.Region
  });
}

function dedupeFoldingRanges(ranges: FoldingRange[]): FoldingRange[] {
  const result: FoldingRange[] = [];
  const seen = new Set<string>();
  for (const range of ranges) {
    const key = `${range.startLine}:${range.startCharacter ?? ''}:${range.endLine}:${range.endCharacter ?? ''}:${range.kind ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(range);
  }
  return result;
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
