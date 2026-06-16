import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { VerilogToken } from './lexer';

export function hasTrailingSemicolon(tokens: VerilogToken[]): boolean {
  return tokens[tokens.length - 1]?.value === ';';
}

export function trimTrailingSemicolon(tokens: VerilogToken[]): VerilogToken[] {
  return hasTrailingSemicolon(tokens) ? tokens.slice(0, -1) : tokens;
}

export function firstTopLevelAssignmentOperator(tokens: VerilogToken[], from: number, to: number): number {
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
    } else if ((token.value === '=' || token.value === '<=') && paren === 0 && bracket === 0 && brace === 0) {
      return index;
    }
  }
  return -1;
}

export function firstTopLevelToken(tokens: VerilogToken[], value: string, from: number): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = from; index < tokens.length; index++) {
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

export function lastTopLevelToken(tokens: VerilogToken[], value: string, from: number, to: number): number {
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

export function splitTopLevel(tokens: VerilogToken[], separator: string): VerilogToken[][] {
  const result: VerilogToken[][] = [];
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
    } else if (token.value === separator && paren === 0 && bracket === 0 && brace === 0) {
      result.push(tokens.slice(start, index).filter((item) => item.kind !== 'eof'));
      start = index + 1;
    }
  }
  result.push(tokens.slice(start).filter((item) => item.kind !== 'eof'));
  return result.filter((part) => part.length > 0);
}

export function topLevelIndexes(tokens: VerilogToken[], predicate: (token: VerilogToken) => boolean): number[] {
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

export function skipDelayControl(tokens: VerilogToken[], hashIndex: number): number {
  if (tokens[hashIndex + 1]?.value === '(') {
    const close = findMatchingToken(tokens, hashIndex + 1, '(', ')');
    return close >= 0 ? close + 1 : hashIndex + 2;
  }
  return Math.min(tokens.length, hashIndex + 2);
}

export function nextSignificantTokenIndex(tokens: VerilogToken[], start: number): number {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].kind !== 'eof') {
      return index;
    }
  }
  return -1;
}

export function findMatchingToken(tokens: VerilogToken[], openIndex: number, openValue: string, closeValue: string): number {
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

export function isInsideDelimitedControl(tokens: VerilogToken[], index: number): boolean {
  const stack: Array<string | undefined> = [];
  for (let cursor = 0; cursor < index; cursor++) {
    const token = tokens[cursor];
    if (token.value === '(') {
      stack.push(previousToken(tokens, cursor)?.value);
    } else if (token.value === ')') {
      stack.pop();
    }
  }
  return stack.some((value) =>
    value === 'if' ||
    value === 'case' ||
    value === 'casex' ||
    value === 'casez' ||
    value === 'for' ||
    value === 'while' ||
    value === 'repeat'
  );
}

export function statementStart(tokens: VerilogToken[], index: number): number {
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let cursor = 0; cursor < index; cursor++) {
    const token = tokens[cursor];
    if (isStatementStartBoundary(token.value) && paren === 0 && bracket === 0 && brace === 0) {
      start = cursor + 1;
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
  return start;
}

export function statementEnd(tokens: VerilogToken[], index: number): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let cursor = index + 1; cursor < tokens.length; cursor++) {
    const token = tokens[cursor];
    if ((token.value === ';' || token.value === 'end' || token.value === 'else' || token.value === 'endcase') && paren === 0 && bracket === 0 && brace === 0) {
      return cursor;
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
  return tokens.length;
}

export function previousToken(tokens: VerilogToken[], index: number): VerilogToken | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (tokens[cursor].kind !== 'eof') {
      return tokens[cursor];
    }
  }
  return undefined;
}

export function tokenRange(document: TextDocument, token: VerilogToken): Range {
  return Range.create(document.positionAt(token.start), document.positionAt(token.end));
}

function isStatementStartBoundary(value: string): boolean {
  return value === ';' ||
    value === 'begin' ||
    value === 'else' ||
    value === 'end' ||
    value === 'endcase' ||
    value === 'endfunction' ||
    value === 'endtask' ||
    value === 'join' ||
    value === 'join_any' ||
    value === 'join_none';
}
