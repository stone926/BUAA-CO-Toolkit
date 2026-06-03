import { Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { VerilogCstDocument, verilogTokenRange } from './cst';
import { VerilogToken } from './lexer';

export function verilogWordRangeAtPosition(document: TextDocument, cst: VerilogCstDocument, position: Position): Range | undefined {
  const token = verilogCodeTokenAtPosition(document, cst, position);
  if (!token) {
    return undefined;
  }
  if (token.kind === 'identifier') {
    return verilogTokenRange(document, token);
  }
  if (token.kind === 'directive' && token.value.length > 1) {
    const offset = document.offsetAt(position);
    if (offset <= token.start || offset > token.end) {
      return undefined;
    }
    return Range.create(document.positionAt(token.start + 1), document.positionAt(token.end));
  }
  return undefined;
}

function verilogCodeTokenAtPosition(document: TextDocument, cst: VerilogCstDocument, position: Position): VerilogToken | undefined {
  const offset = document.offsetAt(position);
  let low = 0;
  let high = cst.codeTokens.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const token = cst.codeTokens[mid];
    if (offset < token.start) {
      high = mid - 1;
    } else if (offset > token.end) {
      low = mid + 1;
    } else {
      if (offset === token.end && offset !== token.start) {
        const next = cst.codeTokens[mid + 1];
        return next && next.start === offset ? next : token;
      }
      return token;
    }
  }
  return undefined;
}
