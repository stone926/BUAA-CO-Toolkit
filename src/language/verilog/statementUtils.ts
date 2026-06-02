import { VerilogToken } from './lexer';

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

export function splitVerilogModuleItems(tokens: VerilogToken[]): VerilogToken[][] {
  const statements: VerilogToken[][] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  const blockStack: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === 'eof') {
      break;
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

    if (paren === 0 && bracket === 0 && brace === 0) {
      const opener = blockOpeners.get(token.value);
      const closer = blockClosers.get(token.value);
      if (opener) {
        blockStack.push(opener);
      } else if (closer) {
        closeBlockStack(blockStack, closer);
      }
    }

    if (paren !== 0 || bracket !== 0 || brace !== 0) {
      continue;
    }
    if (blockStack.length > 0) {
      continue;
    }
    if (token.value === ';' || (blockClosers.has(token.value) && nextCodeToken(tokens, index + 1)?.value !== 'else')) {
      pushTokenSlice(statements, tokens, start, index + 1);
      start = index + 1;
    }
  }

  pushTokenSlice(statements, tokens, start, firstEofIndex(tokens));
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

function pushTokenSlice(result: VerilogToken[][], tokens: VerilogToken[], start: number, end: number): void {
  const slice = tokens.slice(start, end).filter((token) => token.kind !== 'eof');
  if (slice.length > 0) {
    result.push(slice);
  }
}

function firstEofIndex(tokens: VerilogToken[]): number {
  const index = tokens.findIndex((token) => token.kind === 'eof');
  return index >= 0 ? index : tokens.length;
}

function nextCodeToken(tokens: VerilogToken[], start: number): VerilogToken | undefined {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].kind !== 'eof') {
      return tokens[index];
    }
  }
  return undefined;
}
