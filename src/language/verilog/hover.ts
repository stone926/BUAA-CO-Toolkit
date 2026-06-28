// @index(Verilog hover provider)
import * as fs from 'fs';
import * as path from 'path';
import { Hover, Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { CoSettings } from '../common/settings';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { declDetail, moduleAtPosition } from './parser';
import { getCachedVerilogParse } from './parseCache';
import { formatNumericLiteralHover, numericLiteralAt } from './numericLiterals';
import { evalExpressionAstConstant, widthOfDecl, widthOfExpressionAst } from './expressions';
import { findSmallestVerilogExpressionAtOffset } from './exprAstUtils';
import { connectionMarkdown, formatBigInt, instanceMarkdown, markdownHover, moduleMarkdown } from './display';
import { resolveInstanceTargetModule, resolveVerilogSymbol, resolvedRange } from './resolveSymbol';

export function getVerilogHover(document: TextDocument, position: Position, settings: CoSettings, index: VerilogWorkspaceIndex): Hover | undefined {
  const resolved = resolveVerilogSymbol(document, position, settings, index);
  if (!resolved) {
    const literal = numericLiteralAt(document, position);
    if (literal) {
      return markdownHover(formatNumericLiteralHover(literal), literal.range);
    }
    const expressionHover = getVerilogExpressionHover(document, position, settings);
    if (expressionHover) {
      return expressionHover;
    }
    return undefined;
  }
  const parsed = getCachedVerilogParse(document, settings, false);
  const hoverRange = resolved.kind === 'include'
    ? resolved.include.pathRange
    : resolved.sourceRange ?? resolvedRange(resolved);
  switch (resolved.kind) {
    case 'decl': {
      const detail = declDetail(resolved.decl);
      const widthInfo = widthOfDecl(resolved.decl, resolved.module);
      let widthLine = '';
      if (widthInfo.width !== undefined) {
        widthLine = `\n\nInferred width: \`${widthInfo.width}\``;
        if (widthInfo.minWidth !== undefined && widthInfo.minWidth !== widthInfo.width) {
          widthLine += ` (min: \`${widthInfo.minWidth}\`)`;
        }
        if (widthInfo.flexible) {
          widthLine += ' *(flexible)*';
        }
      }
      const valueLine = resolved.decl.constantValue !== undefined
        ? `\n\nConstant value: \`${formatBigInt(resolved.decl.constantValue)}\``
        : '';
      return markdownHover(`\`${detail}\`${widthLine}${valueLine}`, hoverRange);
    }
    case 'instance': {
      const target = resolveInstanceTargetModule(index, parsed.modules, resolved.instance);
      return markdownHover(instanceMarkdown(resolved.instance, resolved.module, target), hoverRange);
    }
    case 'module':
      return markdownHover(moduleMarkdown(resolved.module), hoverRange);
    case 'portConnection': {
      return markdownHover(connectionMarkdown(resolved), hoverRange);
    }
    case 'macro': {
      const macroDef = resolved.macro ?? index.getMacro(resolved.name);
      const bodyMd = macroDef?.body ? `\n\n\`\`\`verilog\n${macroDef.body}\n\`\`\`` : '';
      return markdownHover(`Verilog macro \`${resolved.name}\`${bodyMd}`, hoverRange);
    }
    case 'include': {
      let status = '';
      if (!document.uri.startsWith('untitled:')) {
        try {
          const currentPath = URI.parse(document.uri).fsPath;
          const resolvedPath = path.resolve(path.dirname(currentPath), resolved.include.path);
          if (fs.existsSync(resolvedPath)) {
            status = `\n\nResolved: \`${resolvedPath}\``;
          } else {
            status = '\n\n**Unresolved**';
          }
        } catch {
          status = '\n\n**Unresolved**';
        }
      }
      return markdownHover(`Included file \`${resolved.include.path}\`${status}`, hoverRange);
    }
  }
}

function getVerilogExpressionHover(document: TextDocument, position: Position, settings: CoSettings): Hover | undefined {
  const parsed = getCachedVerilogParse(document, settings, false);
  const module = moduleAtPosition(parsed.modules, position);
  const moduleAst = module ? parsed.ast.modules.find((item) => item.module === module) : undefined;
  if (!module || !moduleAst) {
    return undefined;
  }
  const expressions = moduleAst.items.flatMap((item) => item.expressions);
  const expression = findSmallestVerilogExpressionAtOffset(expressions, document.offsetAt(position));
  if (!expression) {
    return undefined;
  }
  const range = Range.create(document.positionAt(expression.start), document.positionAt(expression.end));
  const source = document.getText(range).trim();
  if (!source) {
    return undefined;
  }
  const width = widthOfExpressionAst(expression, module);
  const value = evalExpressionAstConstant(expression, module);
  if (width.width === undefined && value === undefined) {
    return undefined;
  }
  const lines = [`Expression \`${source}\``, '', `AST: \`${expression.kind}\``];
  if (width.width !== undefined) {
    let widthText = `Width: \`${width.width}\``;
    if (width.minWidth !== undefined && width.minWidth !== width.width) {
      widthText += ` (min: \`${width.minWidth}\`)`;
    }
    if (width.flexible) {
      widthText += ' *(flexible)*';
    }
    lines.push(widthText);
  }
  if (value !== undefined) {
    lines.push(`Constant value: \`${formatBigInt(value)}\``);
  }
  lines.push('', `Node range: \`${expression.start}..${expression.end}\``);
  return markdownHover(lines.join('\n'), range);
}
