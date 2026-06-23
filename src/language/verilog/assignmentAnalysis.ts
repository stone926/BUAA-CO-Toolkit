import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseVerilogCst, VerilogCstDocument } from './cst';
import { VerilogToken } from './lexer';
import { verilogKeywords } from './model';

export interface AssignmentUse {
  name: string;
  operator: '=' | '<=';
  range: Range;
  blockIndex: number;
}

interface AssignmentTarget {
  name: string;
  token: VerilogToken;
}

const declarationKeywords = new Set([
  'input',
  'output',
  'inout',
  'wire',
  'reg',
  'logic',
  'integer',
  'real',
  'realtime',
  'time',
  'parameter',
  'localparam',
  'genvar'
]);

export function collectAssignmentsInText(document: TextDocument, text: string, offset: number, blockIndex: number): AssignmentUse[] {
  const cst = parseVerilogCst(TextDocument.create(`${document.uri}#assignment`, 'verilog', document.version, text), text);
  return collectAssignmentsFromTokens(document, cst, offset, blockIndex);
}

export function collectAssignmentsFromTokens(document: TextDocument, cst: VerilogCstDocument, offset: number, blockIndex: number): AssignmentUse[] {
  const assignments: AssignmentUse[] = [];
  for (const statement of cst.statements) {
    const tokens = trimSemicolon(statement.tokens);
    const operatorIndex = findAssignmentOperator(tokens);
    if (operatorIndex < 0 || isDeclarationStatement(tokens)) {
      continue;
    }
    const operator = tokens[operatorIndex].value as '=' | '<=';
    const lhs = tokens.slice(0, operatorIndex);
    for (const target of assignmentTargetsFromLeftHandSide(lhs)) {
      assignments.push({
        name: target.name,
        operator,
        range: Range.create(
          document.positionAt(offset + target.token.start),
          document.positionAt(offset + target.token.end)
        ),
        blockIndex
      });
    }
  }
  return assignments;
}

export function assignmentTargetNamesFromTokens(tokens: VerilogToken[]): string[] {
  const trimmed = trimSemicolon(tokens);
  const operatorIndex = findAssignmentOperator(trimmed);
  if (operatorIndex < 0 || isDeclarationStatement(trimmed)) {
    return [];
  }
  return assignmentTargetsFromLeftHandSide(trimmed.slice(0, operatorIndex)).map((target) => target.name);
}

export function findAssignmentOperator(tokens: VerilogToken[]): number {
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
    if (paren !== 0 || bracket !== 0 || brace !== 0) {
      continue;
    }
    if (token.value === '<=' || token.value === '=') {
      return index;
    }
  }
  return -1;
}

function assignmentTargetsFromLeftHandSide(tokens: VerilogToken[]): AssignmentTarget[] {
  const trimmed = trimTokenList(tokens);
  if (!trimmed.length) {
    return [];
  }
  const concat = trailingConcatenation(trimmed);
  if (concat) {
    return splitTopLevel(concat.slice(1, -1), ',').flatMap(assignmentTargetsFromLeftHandSide);
  }
  const target = trailingScalarTarget(trimmed);
  return target ? [target] : [];
}

function trailingScalarTarget(tokens: VerilogToken[]): AssignmentTarget | undefined {
  let index = tokens.length - 1;
  while (index >= 0) {
    if (tokens[index].value !== ']') {
      break;
    }
    const open = findMatchingTokenBackward(tokens, index, '[', ']');
    if (open < 0) {
      break;
    }
    index = open - 1;
  }
  const token = tokens[index];
  if (!token || token.kind !== 'identifier' || verilogKeywords.has(token.value)) {
    return undefined;
  }
  return { name: token.value, token };
}

function isDeclarationStatement(tokens: VerilogToken[]): boolean {
  const first = tokens.find((token) => token.kind !== 'eof');
  return Boolean(first && declarationKeywords.has(first.value));
}

function trailingConcatenation(tokens: VerilogToken[]): VerilogToken[] | undefined {
  if (tokens[tokens.length - 1]?.value !== '}') {
    return undefined;
  }
  const open = findMatchingTokenBackward(tokens, tokens.length - 1, '{', '}');
  return open >= 0 ? tokens.slice(open, tokens.length) : undefined;
}

function splitTopLevel(tokens: VerilogToken[], separator: string): VerilogToken[][] {
  const parts: VerilogToken[][] = [];
  let start = 0;
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
    if (token.value === separator && paren === 0 && bracket === 0 && brace === 0) {
      parts.push(trimTokenList(tokens.slice(start, index)));
      start = index + 1;
    }
  }
  parts.push(trimTokenList(tokens.slice(start)));
  return parts.filter((part) => part.length > 0);
}

function findMatchingTokenBackward(tokens: VerilogToken[], closeIndex: number, openValue: string, closeValue: string): number {
  let depth = 0;
  for (let index = closeIndex; index >= 0; index--) {
    if (tokens[index].value === closeValue) {
      depth++;
    } else if (tokens[index].value === openValue) {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function trimSemicolon(tokens: VerilogToken[]): VerilogToken[] {
  const trimmed = trimTokenList(tokens);
  return trimmed[trimmed.length - 1]?.value === ';' ? trimmed.slice(0, -1) : trimmed;
}

function trimTokenList(tokens: VerilogToken[]): VerilogToken[] {
  return tokens.filter((token) => token.kind !== 'eof');
}
