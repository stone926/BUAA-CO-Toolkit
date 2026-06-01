import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexVerilogCst, VerilogLexDiagnostic, VerilogToken } from './lexer';

export interface VerilogCstStatement {
  tokens: VerilogToken[];
  start: number;
  end: number;
  range: Range;
}

export interface VerilogCstDocument {
  tokens: VerilogToken[];
  codeTokens: VerilogToken[];
  diagnostics: VerilogLexDiagnostic[];
  statements: VerilogCstStatement[];
}

export function parseVerilogCst(document: TextDocument, text = document.getText()): VerilogCstDocument {
  const lexed = lexVerilogCst(text);
  const codeTokens = lexed.tokens.filter((token) => token.kind !== 'comment');
  return {
    tokens: lexed.tokens,
    codeTokens,
    diagnostics: lexed.diagnostics,
    statements: collectStatements(document, codeTokens)
  };
}

export function verilogTokenRange(document: TextDocument, token: VerilogToken): Range {
  return Range.create(document.positionAt(token.start), document.positionAt(token.end));
}

function collectStatements(document: TextDocument, tokens: VerilogToken[]): VerilogCstStatement[] {
  const statements: VerilogCstStatement[] = [];
  let current: VerilogToken[] = [];
  let paren = 0;
  let bracket = 0;
  let brace = 0;

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

    if (token.value === ';' && paren === 0 && bracket === 0 && brace === 0) {
      statements.push(makeStatement(document, current));
      current = [];
    }
  }

  if (current.length) {
    statements.push(makeStatement(document, current));
  }
  return statements;
}

function makeStatement(document: TextDocument, tokens: VerilogToken[]): VerilogCstStatement {
  const start = tokens[0]?.start ?? 0;
  const end = tokens[tokens.length - 1]?.end ?? start;
  return {
    tokens,
    start,
    end,
    range: Range.create(document.positionAt(start), document.positionAt(end))
  };
}
