import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { VerilogToken } from './lexer';

export function tokenRange(document: TextDocument, token: VerilogToken): Range {
  return Range.create(document.positionAt(token.start), document.positionAt(token.end));
}

export function trimStatementTokens(tokens: VerilogToken[]): VerilogToken[] {
  const result = tokens.filter((token) => token.kind !== 'eof');
  return result[result.length - 1]?.value === ';' ? result.slice(0, -1) : result;
}

export function previousToken(tokens: VerilogToken[], index: number): VerilogToken | undefined {
  for (let current = index - 1; current >= 0; current--) {
    if (tokens[current].kind !== 'eof') {
      return tokens[current];
    }
  }
  return undefined;
}

export function nextToken(tokens: VerilogToken[], index: number): VerilogToken | undefined {
  for (let current = index + 1; current < tokens.length; current++) {
    if (tokens[current].kind !== 'eof') {
      return tokens[current];
    }
  }
  return undefined;
}

export function findTopLevelToken(tokens: VerilogToken[], value: string): number {
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
    } else if (token.value === value && paren === 0 && bracket === 0 && brace === 0) {
      return index;
    }
  }
  return -1;
}
