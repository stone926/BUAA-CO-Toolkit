// @index(Verilog hover provider)
import * as fs from 'fs';
import * as path from 'path';
import { Hover, Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { CoSettings } from '../common/settings';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { moduleAtPosition } from './parser';
import { getCachedVerilogParse } from './parseCache';
import { formatNumericLiteralHover, numericLiteralAt } from './numericLiterals';
import { evalExpressionAstConstant, widthOfExpressionAst } from './expressions';
import { findSmallestVerilogExpressionAtOffset } from './exprAstUtils';
import { connectionMarkdown, declarationMarkdown, formatBigInt, instanceMarkdown, markdownHover, moduleMarkdown } from './display';
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
      return markdownHover(declarationMarkdown(resolved.decl, resolved.module), hoverRange);
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
      return markdownHover(`Verilog 宏 \`${resolved.name}\`${bodyMd}`, hoverRange);
    }
    case 'include': {
      let status = '';
      if (!document.uri.startsWith('untitled:')) {
        try {
          const currentPath = URI.parse(document.uri).fsPath;
          const resolvedPath = path.resolve(path.dirname(currentPath), resolved.include.path);
          if (fs.existsSync(resolvedPath)) {
            status = `\n\n实际路径：\`${resolvedPath}\``;
          } else {
            status = '\n\n**未找到文件**';
          }
        } catch {
          status = '\n\n**未找到文件**';
        }
      }
      return markdownHover(`包含文件 \`${resolved.include.path}\`${status}`, hoverRange);
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
  if (!document.getText(range).trim()) {
    return undefined;
  }
  const width = widthOfExpressionAst(expression, module);
  const value = evalExpressionAstConstant(expression, module);
  if (width.width === undefined && value === undefined) {
    return undefined;
  }
  const lines = ['**表达式**'];
  if (width.width !== undefined) {
    lines.push('', `位宽：\`${width.width}\` 位`);
  }
  if (value !== undefined) {
    lines.push('', `常量值：\`${formatBigInt(value)}\``);
  }
  return markdownHover(lines.join('\n'), range);
}
