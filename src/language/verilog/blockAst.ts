import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { VerilogCstDocument, VerilogCstStatement } from './cst';
import { VerilogToken } from './lexer';
import { VerilogModule } from './model';
import { parseVerilogProceduralBlockBody, VerilogBlockStatementAst } from './proceduralAst';

export interface VerilogAlwaysBlockAst {
  headerRange: Range;
  range: Range;
  sensitivityTokens: VerilogToken[];
  bodyTokens: VerilogToken[];
  statementTree: VerilogBlockStatementAst;
  statements: VerilogCstStatement[];
  bodyStart: number;
  bodyEnd: number;
  sequential: boolean;
  combinational: boolean;
}

export type VerilogProceduralBlockKind = 'always' | 'initial';
export type VerilogProceduralControlKind = 'none' | 'event' | 'delay';

export interface VerilogProceduralBlockAst {
  kind: VerilogProceduralBlockKind;
  headerRange: Range;
  range: Range;
  controlKind: VerilogProceduralControlKind;
  controlTokens: VerilogToken[];
  bodyTokens: VerilogToken[];
  statementTree: VerilogBlockStatementAst;
  statements: VerilogCstStatement[];
  bodyStart: number;
  bodyEnd: number;
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

export function collectProceduralBlocksFromCst(document: TextDocument, cst: VerilogCstDocument, module: VerilogModule): VerilogProceduralBlockAst[] {
  const moduleStart = document.offsetAt(module.headerEnd);
  const moduleEnd = document.offsetAt(module.range.end);
  const tokens = cst.codeTokens;
  const blocks: VerilogProceduralBlockAst[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.start < moduleStart || token.end > moduleEnd || (token.value !== 'always' && token.value !== 'initial')) {
      continue;
    }
    const parsed = parseProceduralBlockAt(document, cst, index, moduleEnd);
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
    statementTree: parseVerilogProceduralBlockBody(document, bodyTokens),
    statements: cst.statements.filter((statement) => statement.end > bodyStart && statement.start < bodyEnd),
    bodyStart,
    bodyEnd,
    sequential,
    combinational: !sequential
  };
}

function parseProceduralBlockAt(document: TextDocument, cst: VerilogCstDocument, keywordIndex: number, moduleEnd: number): VerilogProceduralBlockAst | undefined {
  const tokens = cst.codeTokens;
  const keyword = tokens[keywordIndex];
  if (keyword.value !== 'always' && keyword.value !== 'initial') {
    return undefined;
  }

  let cursor = keywordIndex + 1;
  let controlKind: VerilogProceduralControlKind = 'none';
  let controlTokens: VerilogToken[] = [];
  if (tokens[cursor]?.value === '@') {
    const end = parseEventControlEnd(tokens, cursor);
    if (end < 0) {
      return undefined;
    }
    controlKind = 'event';
    controlTokens = tokens.slice(cursor, end);
    cursor = end;
  } else if (tokens[cursor]?.value === '#') {
    const end = parseDelayControlEnd(tokens, cursor);
    controlKind = 'delay';
    controlTokens = tokens.slice(cursor, end);
    cursor = end;
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
  return {
    kind: keyword.value,
    headerRange: Range.create(document.positionAt(keyword.start), document.positionAt(bodyStartToken.start)),
    range: Range.create(document.positionAt(keyword.start), document.positionAt(bodyEnd)),
    controlKind,
    controlTokens,
    bodyTokens: tokens.slice(cursor, endIndex + 1),
    statementTree: parseVerilogProceduralBlockBody(document, tokens.slice(cursor, endIndex + 1)),
    statements: cst.statements.filter((statement) => statement.end > bodyStart && statement.start < bodyEnd),
    bodyStart,
    bodyEnd
  };
}

function parseEventControlEnd(tokens: VerilogToken[], atIndex: number): number {
  const cursor = atIndex + 1;
  if (tokens[cursor]?.value === '(') {
    const close = findMatchingForward(tokens, cursor, '(', ')');
    return close >= 0 ? close + 1 : -1;
  }
  return tokens[cursor] ? cursor + 1 : -1;
}

function parseDelayControlEnd(tokens: VerilogToken[], hashIndex: number): number {
  const cursor = hashIndex + 1;
  if (tokens[cursor]?.value === '(') {
    const close = findMatchingForward(tokens, cursor, '(', ')');
    return close >= 0 ? close + 1 : cursor + 1;
  }
  return tokens[cursor] ? cursor + 1 : cursor;
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
