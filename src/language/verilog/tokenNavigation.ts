import { Location, Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { rangesEqual } from '../common/lsp';
import { VerilogCstDocument, verilogTokenRange } from './cst';
import { VerilogToken } from './lexer';
import { VerilogModule } from './model';

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

export function collectIdentifierReferencesInModule(
  document: TextDocument,
  cst: VerilogCstDocument,
  module: VerilogModule,
  name: string,
  declarationRange: Range | undefined,
  includeDeclaration: boolean
): Location[] {
  const locations: Location[] = [];
  if (includeDeclaration && declarationRange) {
    locations.push(Location.create(document.uri, declarationRange));
  }

  const moduleStart = document.offsetAt(module.range.start);
  const moduleEnd = document.offsetAt(module.range.end);
  for (let index = 0; index < cst.codeTokens.length; index++) {
    const token = cst.codeTokens[index];
    if (token.start < moduleStart || token.end > moduleEnd) {
      continue;
    }
    if (token.kind !== 'identifier' || token.value !== name || isNonReferenceIdentifier(cst.codeTokens, index)) {
      continue;
    }
    const range = verilogTokenRange(document, token);
    if (declarationRange && rangesEqual(range, declarationRange)) {
      continue;
    }
    locations.push(Location.create(document.uri, range));
  }

  return locations;
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

function isNonReferenceIdentifier(tokens: VerilogToken[], index: number): boolean {
  const previous = previousSignificantToken(tokens, index);
  if (!previous) {
    return false;
  }
  if (previous.value === '.' || previous.kind === 'directive' || previous.kind === 'systemIdentifier') {
    return true;
  }
  return previous.value === "'" || previous.value === '`';
}

function previousSignificantToken(tokens: VerilogToken[], index: number): VerilogToken | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const token = tokens[cursor];
    if (token.kind !== 'comment') {
      return token;
    }
  }
  return undefined;
}
