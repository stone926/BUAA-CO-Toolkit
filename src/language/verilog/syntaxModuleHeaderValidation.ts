import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { VerilogCstDocument } from './cst';
import { VerilogToken } from './lexer';
import { VerilogModule } from './model';
import {
  declarationModifiers,
  declarationPrefixKeywords,
  firstIdentifierIndex,
  isAllowedDeclarationType,
  portDirectionKeywords
} from './syntaxDeclarationKeywords';
import {
  findMatchingToken,
  nextSignificantTokenIndex,
  splitTopLevel,
  tokenRange,
  topLevelIndexes
} from './syntaxParserUtils';

export function collectModuleHeaderDiagnostics(
  document: TextDocument,
  cst: VerilogCstDocument,
  module: VerilogModule,
  diagnostics: Diagnostic[]
): void {
  const moduleStart = document.offsetAt(module.range.start);
  const headerEnd = document.offsetAt(module.headerEnd);
  const headerTokens = cst.codeTokens.filter((token) =>
    token.start >= moduleStart &&
    token.end <= headerEnd &&
    token.kind !== 'eof'
  );
  const portListOpen = moduleHeaderPortListOpen(headerTokens);
  if (portListOpen < 0) {
    return;
  }
  const portListClose = findMatchingToken(headerTokens, portListOpen, '(', ')');
  if (portListClose < 0) {
    return;
  }
  validateModulePortList(document, headerTokens.slice(portListOpen + 1, portListClose), diagnostics);
}

function moduleHeaderPortListOpen(tokens: VerilogToken[]): number {
  const moduleIndex = tokens.findIndex((token) => token.value === 'module');
  if (moduleIndex < 0) {
    return -1;
  }
  const nameIndex = nextSignificantTokenIndex(tokens, moduleIndex + 1);
  if (nameIndex < 0 || tokens[nameIndex].kind !== 'identifier') {
    return -1;
  }
  let index = nextSignificantTokenIndex(tokens, nameIndex + 1);
  if (index < 0) {
    return -1;
  }
  if (tokens[index].value === '#') {
    const parameterListOpen = nextSignificantTokenIndex(tokens, index + 1);
    if (parameterListOpen < 0 || tokens[parameterListOpen].value !== '(') {
      return -1;
    }
    const parameterListClose = findMatchingToken(tokens, parameterListOpen, '(', ')');
    if (parameterListClose < 0) {
      return -1;
    }
    index = nextSignificantTokenIndex(tokens, parameterListClose + 1);
  }
  return tokens[index]?.value === '(' ? index : -1;
}

function validateModulePortList(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  let inheritsDeclarationPrefix = false;
  for (const part of splitTopLevel(tokens, ',')) {
    const directionIndexes = topLevelPortDirectionIndexes(part);
    if (directionIndexes.length > 1) {
      const direction = part[directionIndexes[1]];
      diagnostics.push(makeDiagnostic(
        tokenRange(document, direction),
        `Syntax error: unexpected port direction '${direction.value}' in the same module port declaration. Did you forget a comma?`,
        DiagnosticSeverity.Error,
        'syntax-malformed-port-list'
      ));
      continue;
    }
    if (directionIndexes.length === 1) {
      if (directionIndexes[0] !== 0) {
        const direction = part[directionIndexes[0]];
        diagnostics.push(makeDiagnostic(
          tokenRange(document, direction),
          `Syntax error: port direction '${direction.value}' must start a module port declaration.`,
          DiagnosticSeverity.Error,
          'syntax-malformed-port-list'
        ));
        continue;
      }
      inheritsDeclarationPrefix = true;
      validateModulePortDeclaration(document, part, diagnostics);
      continue;
    }
    if (inheritsDeclarationPrefix && looksLikeInheritedPortDeclarator(part)) {
      validateModulePortDeclarator(document, part, diagnostics);
    }
  }
}

function validateModulePortDeclaration(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  const declaratorStart = modulePortDeclaratorStart(document, tokens, diagnostics);
  if (declaratorStart < 0) {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, tokens[tokens.length - 1] ?? tokens[0]),
      `Syntax error: '${tokens[0].value}' port declaration is missing a port name.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-port-list'
    ));
    return;
  }
  validateModulePortDeclarator(document, tokens.slice(declaratorStart), diagnostics);
}

function modulePortDeclaratorStart(
  document: TextDocument,
  tokens: VerilogToken[],
  diagnostics: Diagnostic[]
): number {
  let index = 1;
  let sawType = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.value === '[') {
      const close = findMatchingToken(tokens, index, '[', ']');
      if (close < 0) {
        return -1;
      }
      index = close + 1;
      continue;
    }
    if (declarationModifiers.has(token.value)) {
      index++;
      continue;
    }
    if (!sawType && isAllowedDeclarationType(tokens[0].value, token.value)) {
      sawType = true;
      index++;
      continue;
    }
    if (token.kind === 'keyword' && declarationPrefixKeywords.has(token.value)) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, token),
        `Syntax error: unexpected declaration keyword '${token.value}' in module port declaration.`,
        DiagnosticSeverity.Error,
        'syntax-malformed-port-list'
      ));
      return firstIdentifierIndex(tokens, index + 1);
    }
    return token.kind === 'identifier' ? index : -1;
  }
  return -1;
}

function validateModulePortDeclarator(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  const name = tokens[0];
  if (!name || name.kind !== 'identifier') {
    diagnostics.push(makeDiagnostic(
      tokenRange(document, name ?? tokens[0]),
      'Syntax error: module port declaration is missing a port name.',
      DiagnosticSeverity.Error,
      'syntax-malformed-port-list'
    ));
    return;
  }
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '[') {
      const close = findMatchingToken(tokens, index, '[', ']');
      if (close < 0) {
        return;
      }
      index = close;
      continue;
    }
    diagnostics.push(makeDiagnostic(
      tokenRange(document, token),
      `Syntax error: unexpected token '${token.value}' after module port '${name.value}'.`,
      DiagnosticSeverity.Error,
      'syntax-malformed-port-list'
    ));
    return;
  }
}

function topLevelPortDirectionIndexes(tokens: VerilogToken[]): number[] {
  return topLevelIndexes(tokens, (token) => portDirectionKeywords.has(token.value));
}

function looksLikeInheritedPortDeclarator(tokens: VerilogToken[]): boolean {
  return tokens[0]?.kind === 'identifier' || tokens[0]?.value === '[';
}
