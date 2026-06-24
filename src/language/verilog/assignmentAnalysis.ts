import { VerilogToken } from './lexer';
import { verilogKeywords } from './model';
import {
  findLastTopLevelToken,
  findMatchingTokenBackward,
  findMatchingTokenForward,
  splitTopLevelTokens,
  trimEofTokens,
  trimTrailingSemicolonTokens
} from './tokenUtils';

export interface AssignmentTarget {
  name: string;
  token: VerilogToken;
}

export interface ParsedAssignmentTokens {
  operator: '=' | '<=';
  operatorIndex: number;
  lhsStart: number;
  lhsTokens: VerilogToken[];
  rhsTokens: VerilogToken[];
  targets: AssignmentTarget[];
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

export function parseAssignmentTokens(rawTokens: VerilogToken[]): ParsedAssignmentTokens | undefined {
  const tokens = trimTrailingSemicolonTokens(rawTokens);
  const operatorIndex = findAssignmentOperator(tokens);
  if (operatorIndex < 0 || isDeclarationStatement(tokens)) {
    return undefined;
  }
  const operator = tokens[operatorIndex].value;
  if (operator !== '=' && operator !== '<=') {
    return undefined;
  }
  const lhsStart = assignmentLeftHandSideStart(tokens, operatorIndex);
  const lhsTokens = trimEofTokens(tokens.slice(lhsStart, operatorIndex));
  const rhsTokens = trimEofTokens(tokens.slice(operatorIndex + 1));
  return {
    operator,
    operatorIndex,
    lhsStart,
    lhsTokens,
    rhsTokens,
    targets: assignmentTargetsFromLeftHandSide(lhsTokens)
  };
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
  const trimmed = trimEofTokens(tokens);
  if (!trimmed.length) {
    return [];
  }
  const concat = trailingConcatenation(trimmed);
  if (concat) {
    return splitTopLevelTokens(concat.slice(1, -1), ',').flatMap(assignmentTargetsFromLeftHandSide);
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

function assignmentLeftHandSideStart(tokens: VerilogToken[], operatorIndex: number): number {
  if (tokens[0]?.value === 'assign') {
    return 1;
  }
  let start = 0;
  while (start < operatorIndex) {
    const token = tokens[start];
    if (token.value === 'if' || token.value === 'while' || token.value === 'repeat' || token.value === 'for') {
      const open = nextTokenIndex(tokens, start + 1, '(');
      if (open < 0) {
        return start;
      }
      const close = findMatchingTokenForward(tokens, open, '(', ')');
      if (close < 0 || close >= operatorIndex) {
        return start;
      }
      start = close + 1;
      continue;
    }
    if (token.value === 'forever') {
      start++;
      continue;
    }
    if (token.value === '#') {
      const next = skipDelayControl(tokens, start);
      if (next <= start || next > operatorIndex) {
        return start;
      }
      start = next;
      continue;
    }
    break;
  }

  const label = findLastTopLevelToken(tokens, ':', start, operatorIndex);
  if (label >= 0) {
    start = label + 1;
  }

  while (tokens[start]?.value === '#') {
    const next = skipDelayControl(tokens, start);
    if (next <= start || next > operatorIndex) {
      break;
    }
    start = next;
  }
  return start;
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

function skipDelayControl(tokens: VerilogToken[], hashIndex: number): number {
  if (tokens[hashIndex + 1]?.value === '(') {
    const close = findMatchingTokenForward(tokens, hashIndex + 1, '(', ')');
    return close >= 0 ? close + 1 : hashIndex + 2;
  }
  return Math.min(tokens.length, hashIndex + 2);
}

function nextTokenIndex(tokens: VerilogToken[], start: number, value: string): number {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].value === value) {
      return index;
    }
  }
  return -1;
}
