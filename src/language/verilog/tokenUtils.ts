import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { VerilogToken } from './lexer';

export function verilogTokenRange(document: TextDocument, token: VerilogToken): Range {
  return Range.create(document.positionAt(token.start), document.positionAt(token.end));
}

export function trimEofTokens(tokens: VerilogToken[]): VerilogToken[] {
  return tokens.filter((token) => token.kind !== 'eof');
}

export function trimTrailingSemicolonTokens(tokens: VerilogToken[]): VerilogToken[] {
  const trimmed = trimEofTokens(tokens);
  return trimmed[trimmed.length - 1]?.value === ';' ? trimmed.slice(0, -1) : trimmed;
}

export function splitTopLevelTokens(tokens: VerilogToken[], separator: string): VerilogToken[][] {
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
      parts.push(trimEofTokens(tokens.slice(start, index)));
      start = index + 1;
    }
  }
  parts.push(trimEofTokens(tokens.slice(start)));
  return parts.filter((part) => part.length > 0);
}

export function findMatchingTokenForward(tokens: VerilogToken[], openIndex: number, openValue: string, closeValue: string): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index++) {
    if (tokens[index].value === openValue) {
      depth++;
    } else if (tokens[index].value === closeValue) {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

export function findMatchingTokenBackward(tokens: VerilogToken[], closeIndex: number, openValue: string, closeValue: string): number {
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

export function findTopLevelToken(
  tokens: VerilogToken[],
  value: string,
  from = 0,
  to = tokens.length
): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = from; index < to; index++) {
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
    } else if (token.value === value && paren === 0 && bracket === 0 && brace === 0) {
      return index;
    }
  }
  return -1;
}

export function findLastTopLevelToken(
  tokens: VerilogToken[],
  value: string,
  from = 0,
  to = tokens.length
): number {
  let result = -1;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = from; index < to; index++) {
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
    } else if (token.value === value && paren === 0 && bracket === 0 && brace === 0) {
      result = index;
    }
  }
  return result;
}

export function findTopLevelTokenIndexes(tokens: VerilogToken[], predicate: (token: VerilogToken) => boolean): number[] {
  const result: number[] = [];
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (predicate(token) && paren === 0 && bracket === 0 && brace === 0) {
      result.push(index);
    }
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
  }
  return result;
}

export function nextSignificantTokenIndex(tokens: VerilogToken[], start: number): number {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].kind !== 'eof') {
      return index;
    }
  }
  return -1;
}
