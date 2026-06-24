import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { VerilogToken } from './lexer';

export interface VerilogStatementSource {
  tokens: VerilogToken[];
  start: number;
  end: number;
  range: Range;
}

const blockOpeners = new Map([
  ['begin', 'begin'],
  ['case', 'case'],
  ['casex', 'case'],
  ['casez', 'case'],
  ['fork', 'fork'],
  ['function', 'function'],
  ['generate', 'generate'],
  ['primitive', 'primitive'],
  ['specify', 'specify'],
  ['table', 'table'],
  ['task', 'task']
]);

const blockClosers = new Map([
  ['end', 'begin'],
  ['endcase', 'case'],
  ['join', 'fork'],
  ['join_any', 'fork'],
  ['join_none', 'fork'],
  ['endfunction', 'function'],
  ['endgenerate', 'generate'],
  ['endprimitive', 'primitive'],
  ['endspecify', 'specify'],
  ['endtable', 'table'],
  ['endtask', 'task']
]);

const proceduralBlocks = new Set(['begin', 'case', 'fork']);

export function collectVerilogStatementSources(document: TextDocument, tokens: VerilogToken[]): VerilogStatementSource[] {
  const statements: VerilogStatementSource[] = [];
  let current: VerilogToken[] = [];
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  const blockStack: string[] = [];

  function flush(): void {
    if (current.length) {
      statements.push(makeStatement(document, current));
      current = [];
    }
  }

  function isProceduralContext(): boolean {
    return blockStack.length > 0 && proceduralBlocks.has(blockStack[blockStack.length - 1]);
  }

  for (const token of tokens) {
    if (token.kind === 'eof') {
      break;
    }
    if (!current.length) {
      current = [token];
    } else {
      current.push(token);
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

    if (paren !== 0 || bracket !== 0 || brace !== 0) {
      continue;
    }

    const opener = blockOpeners.get(token.value);
    const closer = blockClosers.get(token.value);

    if (opener) {
      if (current.length > 1) {
        statements.push(makeStatement(document, current.slice(0, -1)));
        current = [token];
      }
      flush();
      blockStack.push(opener);
    } else if (closer) {
      closeBlockStack(blockStack, closer);
      if (current.length > 1) {
        statements.push(makeStatement(document, current.slice(0, -1)));
        current = [token];
      }
      flush();
    } else if (token.value === ';') {
      if (blockStack.length === 0 || isProceduralContext()) {
        flush();
      }
    }
  }

  flush();
  return statements;
}

function closeBlockStack(stack: string[], expected: string): void {
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index] !== expected) {
      continue;
    }
    stack.length = index;
    return;
  }
}

function makeStatement(document: TextDocument, tokens: VerilogToken[]): VerilogStatementSource {
  const start = tokens[0]?.start ?? 0;
  const end = tokens[tokens.length - 1]?.end ?? start;
  return {
    tokens,
    start,
    end,
    range: Range.create(document.positionAt(start), document.positionAt(end))
  };
}
