import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { VerilogCstDocument } from './cst';
import { isIdentifierLike, VerilogToken } from './lexer';
import { VerilogModule, verilogKeywords } from './model';
import { splitVerilogModuleItems } from './statementUtils';
import { validateContinuousAssign } from './syntaxAssignmentValidation';
import { declarationKeywords } from './syntaxDeclarationKeywords';
import { validateDeclarationLikeStatement } from './syntaxDeclarationValidation';
import {
  isExpressionOperandToken,
  validateExpressionSyntax
} from './syntaxExpressionValidation';
import { validateInstanceStatement } from './syntaxInstanceValidation';
import { collectModuleHeaderDiagnostics } from './syntaxModuleHeaderValidation';
import {
  validateProceduralBlock,
  validateSubroutine
} from './syntaxProceduralValidation';
import { tokenRange } from './syntaxParserUtils';

export type VerilogSyntaxNodeKind =
  | 'sourceFile'
  | 'module'
  | 'declaration'
  | 'continuousAssign'
  | 'proceduralBlock'
  | 'blockStatement'
  | 'if'
  | 'case'
  | 'for'
  | 'task'
  | 'instance'
  | 'expression';

export interface VerilogSyntaxNode {
  kind: VerilogSyntaxNodeKind;
  range: Range;
  children: VerilogSyntaxNode[];
}

export interface VerilogSyntaxParseResult {
  root: VerilogSyntaxNode;
  diagnostics: Diagnostic[];
}

const unsupportedConstructs = new Set([
  'generate',
  'specify',
  'primitive',
  'defparam',
  'fork',
  'event'
]);

export function parseVerilogSyntax(
  document: TextDocument,
  cst: VerilogCstDocument,
  modules: VerilogModule[]
): VerilogSyntaxParseResult {
  const diagnostics: Diagnostic[] = [];
  const root: VerilogSyntaxNode = {
    kind: 'sourceFile',
    range: documentRange(document),
    children: []
  };
  collectNumberLiteralDiagnostics(document, cst.codeTokens, diagnostics);
  collectUnsupportedConstructDiagnostics(document, cst.codeTokens, diagnostics);

  for (const module of modules) {
    const moduleNode: VerilogSyntaxNode = {
      kind: 'module',
      range: module.range,
      children: []
    };
    root.children.push(moduleNode);
    collectModuleHeaderDiagnostics(document, cst, module, diagnostics);
    collectModuleItemDiagnostics(document, cst, module, moduleNode, diagnostics);
  }

  collectOrphanControlDiagnostics(document, cst.codeTokens, diagnostics);
  return { root, diagnostics: dedupeDiagnostics(diagnostics) };
}

function collectModuleItemDiagnostics(
  document: TextDocument,
  cst: VerilogCstDocument,
  module: VerilogModule,
  moduleNode: VerilogSyntaxNode,
  diagnostics: Diagnostic[]
): void {
  const bodyStart = document.offsetAt(module.headerEnd);
  const bodyEnd = document.offsetAt(module.endmoduleRange?.start ?? module.range.end);
  const bodyTokens = cst.codeTokens.filter((token) => token.start >= bodyStart && token.start < bodyEnd && token.kind !== 'eof');
  for (const item of splitVerilogModuleItems(bodyTokens)) {
    const first = item[0];
    if (!first) {
      continue;
    }
    if (first.kind === 'directive') {
      continue;
    }
    if (declarationKeywords.has(first.value)) {
      moduleNode.children.push(nodeFromTokens(document, 'declaration', item));
      validateDeclarationLikeStatement(document, item, diagnostics, {
        reportMissingSemicolon,
        validateExpressionSyntax,
        isExpressionOperandToken
      });
      continue;
    }
    if (first.value === 'assign') {
      moduleNode.children.push(nodeFromTokens(document, 'continuousAssign', item));
      validateContinuousAssign(document, item, diagnostics, { reportMissingSemicolon });
      continue;
    }
    if (first.value === 'always' || first.value === 'initial') {
      moduleNode.children.push(nodeFromTokens(document, 'proceduralBlock', item));
      validateProceduralBlock(document, item, diagnostics, { reportMissingSemicolon });
      continue;
    }
    if (first.value === 'task' || first.value === 'function') {
      moduleNode.children.push(nodeFromTokens(document, 'task', item));
      validateSubroutine(document, item, diagnostics, { reportMissingSemicolon });
      continue;
    }
    if (first.value === 'else' || first.value === 'default' || first.value === 'endcase') {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, first),
        `Syntax error: '${first.value}' is not valid at module scope.`,
        DiagnosticSeverity.Error,
        first.value === 'else' ? 'syntax-orphan-else' : `syntax-orphan-${first.value}`
      ));
      continue;
    }
    if (isIdentifierLike(first.kind) && !verilogKeywords.has(first.value)) {
      moduleNode.children.push(nodeFromTokens(document, 'instance', item));
      validateInstanceStatement(document, item, diagnostics, { reportMissingSemicolon });
      continue;
    }
    if (unsupportedConstructs.has(first.value)) {
      continue;
    }
    diagnostics.push(makeDiagnostic(
      tokenRange(document, first),
      `Syntax error: unexpected token '${first.value}' at module scope.`,
      DiagnosticSeverity.Error,
      'syntax-unexpected-token'
    ));
  }
}

function collectNumberLiteralDiagnostics(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  for (const token of tokens) {
    if (token.kind !== 'number') {
      continue;
    }
    const error = numberLiteralError(token.value);
    if (!error) {
      continue;
    }
    diagnostics.push(makeDiagnostic(
      tokenRange(document, token),
      `Syntax error: ${error}`,
      DiagnosticSeverity.Error,
      'syntax-malformed-number'
    ));
  }
}

function collectUnsupportedConstructDiagnostics(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  const reported = new Set<string>();
  for (const token of tokens) {
    if (!unsupportedConstructs.has(token.value) || reported.has(token.value)) {
      continue;
    }
    reported.add(token.value);
    diagnostics.push(makeDiagnostic(
      tokenRange(document, token),
      `Verilog construct '${token.value}' is outside the supported CO course subset; ISE may still accept it.`,
      DiagnosticSeverity.Information,
      'syntax-unsupported-construct'
    ));
  }
}

function collectOrphanControlDiagnostics(document: TextDocument, tokens: VerilogToken[], diagnostics: Diagnostic[]): void {
  let caseDepth = 0;
  for (const token of tokens) {
    if (token.value === 'case' || token.value === 'casex' || token.value === 'casez') {
      caseDepth++;
    } else if (token.value === 'endcase') {
      caseDepth = Math.max(0, caseDepth - 1);
    } else if (token.value === 'default' && caseDepth === 0) {
      diagnostics.push(makeDiagnostic(
        tokenRange(document, token),
        "Syntax error: 'default' appears outside a case statement.",
        DiagnosticSeverity.Error,
        'syntax-orphan-default'
      ));
    }
  }
}

function numberLiteralError(value: string): string | undefined {
  const apostrophe = value.indexOf("'");
  if (apostrophe < 0) {
    return /^[0-9_]+$/.test(value) && /[0-9]/.test(value) ? undefined : `malformed decimal literal '${value}'.`;
  }
  let index = apostrophe + 1;
  if (value[index] === 's' || value[index] === 'S') {
    index++;
  }
  const base = value[index]?.toLowerCase();
  if (base !== 'b' && base !== 'o' && base !== 'd' && base !== 'h') {
    return `based literal '${value}' is missing a valid base.`;
  }
  const digits = value.slice(index + 1).replace(/_/g, '');
  if (!digits) {
    return `based literal '${value}' is missing digits.`;
  }
  const allowed = base === 'b'
    ? /^[01xXzZ?]+$/
    : base === 'o'
      ? /^[0-7xXzZ?]+$/
      : base === 'd'
        ? /^[0-9xXzZ?]+$/
        : /^[0-9a-fA-FxXzZ?]+$/;
  return allowed.test(digits) ? undefined : `literal '${value}' contains digits invalid for base ${base}.`;
}

function reportMissingSemicolon(
  document: TextDocument,
  anchor: VerilogToken,
  statement: VerilogToken[],
  diagnostics: Diagnostic[]
): void {
  diagnostics.push(makeDiagnostic(
    tokenRange(document, anchor),
    `Syntax error: '${anchor.value}' statement is missing a terminating semicolon.`,
    DiagnosticSeverity.Error,
    'syntax-missing-semicolon'
  ));
}

function nodeFromTokens(document: TextDocument, kind: VerilogSyntaxNodeKind, tokens: VerilogToken[]): VerilogSyntaxNode {
  const first = tokens[0];
  const last = tokens[tokens.length - 1] ?? first;
  return {
    kind,
    range: Range.create(document.positionAt(first.start), document.positionAt(last.end)),
    children: []
  };
}

function documentRange(document: TextDocument): Range {
  const text = document.getText();
  const lines = text.split(/\r?\n/);
  const lastLine = Math.max(0, lines.length - 1);
  return Range.create(0, 0, lastLine, lines[lastLine]?.length ?? 0);
}

function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const result: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}
