import { FoldingRange, FoldingRangeKind, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { VerilogCstDocument, VerilogCstStatement } from './cst';
import { VerilogToken } from './lexer';
import { VerilogModule } from './model';

export interface VerilogAlwaysBlockAst {
  headerRange: Range;
  range: Range;
  sensitivityTokens: VerilogToken[];
  bodyTokens: VerilogToken[];
  statements: VerilogCstStatement[];
  bodyStart: number;
  bodyEnd: number;
  sequential: boolean;
  combinational: boolean;
}

const blockOpeners = new Set(['begin', 'case', 'casex', 'casez', 'generate', 'function', 'task']);
const blockClosers = new Map([
  ['end', 'begin'],
  ['endcase', 'case'],
  ['endgenerate', 'generate'],
  ['endfunction', 'function'],
  ['endtask', 'task']
]);

export function collectVerilogFoldingRangesFromCst(document: TextDocument, cst: VerilogCstDocument): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  const stack: Array<{ kind: string; token: VerilogToken }> = [];
  for (const token of cst.codeTokens) {
    if (token.kind !== 'keyword') {
      continue;
    }
    if (blockOpeners.has(token.value)) {
      stack.push({ kind: foldStackKind(token.value), token });
      continue;
    }
    const expected = blockClosers.get(token.value);
    if (!expected) {
      continue;
    }
    closeFoldStack(document, stack, expected, token, ranges);
  }
  return ranges;
}

export function collectAlwaysBlocksFromCst(document: TextDocument, cst: VerilogCstDocument, module: VerilogModule): VerilogAlwaysBlockAst[] {
  const moduleStart = document.offsetAt(module.headerEnd);
  const moduleEnd = document.offsetAt(module.range.end);
  const tokens = cst.codeTokens;
  const blocks: VerilogAlwaysBlockAst[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.start < moduleStart || token.end > moduleEnd || token.value !== 'always') {
      continue;
    }
    const parsed = parseAlwaysBlockAt(document, cst, index, moduleEnd);
    if (parsed) {
      blocks.push(parsed);
    }
  }
  return blocks;
}

export function edgeSignalsFromSensitivity(tokens: VerilogToken[]): string[] {
  const signals: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value !== 'posedge' && token.value !== 'negedge') {
      continue;
    }
    const signal = nextIdentifier(tokens, index + 1);
    if (signal) {
      signals.push(signal.value);
    }
  }
  return signals;
}

export function hasTokenValue(tokens: VerilogToken[], value: string): boolean {
  return tokens.some((token) => token.value === value);
}

export function hasAnyTokenValue(tokens: VerilogToken[], values: Set<string>): boolean {
  return tokens.some((token) => values.has(token.value));
}

export function tokenListText(source: string, tokens: VerilogToken[]): string {
  if (!tokens.length) {
    return '';
  }
  return source.slice(tokens[0].start, tokens[tokens.length - 1].end);
}

export function assignmentRhsContainsIdentifier(tokens: VerilogToken[], identifier: string): boolean {
  for (const statement of splitStatementsBySemicolon(tokens)) {
    const operatorIndex = topLevelAssignmentOperator(statement);
    if (operatorIndex < 0) {
      continue;
    }
    if (statement.slice(operatorIndex + 1).some((token) => token.kind === 'identifier' && token.value === identifier)) {
      return true;
    }
  }
  return false;
}

export function isOffsetInsideForControl(tokens: VerilogToken[], offset: number): boolean {
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== 'for') {
      continue;
    }
    const open = nextTokenValue(tokens, index + 1, '(');
    if (open < 0) {
      continue;
    }
    const close = findMatchingForward(tokens, open, '(', ')');
    if (close >= 0 && tokens[open].start <= offset && offset <= tokens[close].end) {
      return true;
    }
  }
  return false;
}

function parseAlwaysBlockAt(document: TextDocument, cst: VerilogCstDocument, alwaysIndex: number, moduleEnd: number): VerilogAlwaysBlockAst | undefined {
  const tokens = cst.codeTokens;
  const always = tokens[alwaysIndex];
  let cursor = alwaysIndex + 1;
  if (tokens[cursor]?.value !== '@') {
    return undefined;
  }
  cursor++;

  let sensitivityTokens: VerilogToken[] = [];
  if (tokens[cursor]?.value === '(') {
    const close = findMatchingForward(tokens, cursor, '(', ')');
    if (close < 0) {
      return undefined;
    }
    sensitivityTokens = tokens.slice(cursor + 1, close);
    cursor = close + 1;
  } else if (tokens[cursor]) {
    sensitivityTokens = [tokens[cursor]];
    cursor++;
  }

  const bodyStartToken = tokens[cursor];
  if (!bodyStartToken || bodyStartToken.start >= moduleEnd) {
    return undefined;
  }

  let endIndex: number;
  if (bodyStartToken.value === 'begin') {
    endIndex = findMatchingBeginEnd(tokens, cursor);
  } else {
    endIndex = findStatementSemicolon(tokens, cursor);
  }
  if (endIndex < cursor) {
    endIndex = cursor;
  }

  const bodyEndToken = tokens[endIndex];
  const bodyStart = bodyStartToken.start;
  const bodyEnd = bodyEndToken?.end ?? bodyStartToken.end;
  const bodyTokens = tokens.slice(cursor, endIndex + 1);
  const sequential = sensitivityTokens.some((token) => token.value === 'posedge' || token.value === 'negedge');
  return {
    headerRange: Range.create(document.positionAt(always.start), document.positionAt(bodyStartToken.start)),
    range: Range.create(document.positionAt(always.start), document.positionAt(bodyEnd)),
    sensitivityTokens,
    bodyTokens,
    statements: cst.statements.filter((statement) => statement.end > bodyStart && statement.start < bodyEnd),
    bodyStart,
    bodyEnd,
    sequential,
    combinational: !sequential
  };
}

function closeFoldStack(document: TextDocument, stack: Array<{ kind: string; token: VerilogToken }>, expected: string, close: VerilogToken, ranges: FoldingRange[]): void {
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index].kind !== expected) {
      continue;
    }
    const open = stack[index].token;
    stack.length = index;
    const startLine = document.positionAt(open.start).line;
    const endLine = document.positionAt(close.end).line;
    if (endLine > startLine) {
      ranges.push({ startLine, endLine, kind: FoldingRangeKind.Region });
    }
    return;
  }
}

function foldStackKind(value: string): string {
  return value === 'casex' || value === 'casez' ? 'case' : value;
}

function findMatchingForward(tokens: VerilogToken[], openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === open) {
      depth++;
    } else if (token.value === close) {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function findMatchingBeginEnd(tokens: VerilogToken[], beginIndex: number): number {
  let depth = 0;
  for (let index = beginIndex; index < tokens.length; index++) {
    if (tokens[index].value === 'begin') {
      depth++;
    } else if (tokens[index].value === 'end') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function findStatementSemicolon(tokens: VerilogToken[], start: number): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      paren = Math.max(0, paren - 1);
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      brace = Math.max(0, brace - 1);
    } else if (token.value === ';' && paren === 0 && bracket === 0 && brace === 0) {
      return index;
    }
  }
  return tokens.length - 1;
}

function nextIdentifier(tokens: VerilogToken[], start: number): VerilogToken | undefined {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].kind === 'identifier') {
      return tokens[index];
    }
    if (tokens[index].value === 'or' || tokens[index].value === ',' || tokens[index].value === ')') {
      return undefined;
    }
  }
  return undefined;
}

function nextTokenValue(tokens: VerilogToken[], start: number, value: string): number {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].value === value) {
      return index;
    }
    if (tokens[index].value !== 'automatic') {
      return -1;
    }
  }
  return -1;
}

function splitStatementsBySemicolon(tokens: VerilogToken[]): VerilogToken[][] {
  const statements: VerilogToken[][] = [];
  let start = 0;
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value === ';') {
      statements.push(tokens.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < tokens.length) {
    statements.push(tokens.slice(start));
  }
  return statements;
}

function topLevelAssignmentOperator(tokens: VerilogToken[]): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      paren = Math.max(0, paren - 1);
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      brace = Math.max(0, brace - 1);
    }
    if (paren === 0 && bracket === 0 && brace === 0 && (token.value === '=' || token.value === '<=')) {
      return index;
    }
  }
  return -1;
}
