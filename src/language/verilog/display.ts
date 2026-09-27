// @index(render Verilog language-service hover and hint text)
import { Hover, MarkupKind, Range } from 'vscode-languageserver/node';
import { VerilogConstantOverrides, WidthInfo, evalExpressionAstConstant, widthOfDecl, widthOfExpressionAst } from './expressions';
import { overridableParameters, parameterOverridesForInstance } from './parameterOverrides';
import { VerilogDecl, VerilogInstance, VerilogModule, VerilogPortConnection } from './model';
import { declDetail } from './parser';
import { ResolvedPortConnection } from './resolveSymbol';
export function markdownHover(value: string, range?: Range): Hover {
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value
    },
    range
  };
}

/** Hover text for a resolved declaration, without echoing the source declaration. */
export function declarationMarkdown(decl: VerilogDecl, module: VerilogModule): string {
  const kind = decl.direction && decl.kind !== decl.direction
    ? `${decl.direction} ${decl.kind}`
    : decl.kind;
  const parts = [`**${kind}**`];
  const width = widthOfDecl(decl, module).width;
  if (width !== undefined && decl.kind !== 'task' && decl.kind !== 'function') {
    parts.push(`Width: \`${width}\` bits`);
  } else if (decl.width) {
    parts.push(`Range: \`${decl.width}\``);
  }
  if (decl.constantValue !== undefined) {
    parts.push(`Constant value: \`${formatBigInt(decl.constantValue)}\``);
  }
  if (decl.unpackedDimensions?.length) {
    parts.push(`Array: \`${decl.unpackedDimensions.map((dimension) => dimension.text).join('')}\``);
  }
  return parts.join(' · ');
}

export function instanceMarkdown(instance: VerilogInstance, parentModule: VerilogModule, targetModule: VerilogModule | undefined): string {
  const lines = [`Instance \`${instance.instanceName}\` of module \`${instance.moduleName}\`.`];
  if (!targetModule) {
    return lines.join('\n');
  }
  const overrides = parameterOverridesForInstance(instance, parentModule, targetModule);
  const parameterLines = effectiveParameterLines(targetModule, overrides);
  if (parameterLines.length) {
    lines.push('', 'Effective parameters:', '```verilog', ...limitedLines(parameterLines, 8), '```');
  }
  return lines.join('\n');
}

export function connectionMarkdown(resolved: ResolvedPortConnection): string {
  return resolved.listKind === 'parameters'
    ? parameterConnectionMarkdown(resolved.module, resolved.instance, resolved.targetModule, resolved.targetPort, resolved.connection)
    : portConnectionMarkdown(resolved.module, resolved.instance, resolved.targetModule, resolved.targetPort, resolved.connection);
}

export function portConnectionMarkdown(
  parentModule: VerilogModule,
  instance: VerilogInstance,
  targetModule: VerilogModule,
  port: VerilogDecl,
  connection: VerilogPortConnection
): string {
  const lines = [`Port \`${port.name}\` on module \`${targetModule.name}\` · **${port.direction ?? port.kind}**`];
  const overrides = parameterOverridesForInstance(instance, parentModule, targetModule);
  const expected = widthOfDecl(port, targetModule, overrides);
  const actual = connection.expressionAst ? widthOfExpressionAst(connection.expressionAst, parentModule) : undefined;
  if (expected.width !== undefined) {
    lines.push('', `Effective width: \`${expected.width}\` bits`);
  }
  if (actual?.width !== undefined && actual.width !== expected.width) {
    lines.push('', `Connection width: \`${actual.width}\` bits`);
  }
  return lines.join('\n');
}

export function parameterConnectionMarkdown(
  parentModule: VerilogModule,
  instance: VerilogInstance,
  targetModule: VerilogModule,
  parameter: VerilogDecl,
  connection: VerilogPortConnection
): string {
  const lines = [`Parameter \`${parameter.name}\` on module \`${targetModule.name}\` · **${parameter.kind}**`];
  const overrides = parameterOverridesForInstance(instance, parentModule, targetModule);
  const effective = effectiveParameterValue(parameter, targetModule, overrides);
  if (effective !== undefined) {
    lines.push('', `Effective value: \`${formatBigInt(effective)}\``);
  }
  const supplied = connection.expressionAst
    ? evalExpressionAstConstant(connection.expressionAst, parentModule)
    : undefined;
  if (supplied !== undefined && supplied !== effective) {
    lines.push('', `Connection value: \`${formatBigInt(supplied)}\``);
  }
  const width = widthOfDecl(parameter, targetModule, overrides);
  lines.push(...widthMarkdownLines('Parameter width', width));
  return lines.join('\n');
}

export function portConnectionTooltip(
  parentModule: VerilogModule,
  instance: VerilogInstance,
  targetModule: VerilogModule,
  port: VerilogDecl,
  connection: VerilogPortConnection
): string {
  return portConnectionMarkdown(parentModule, instance, targetModule, port, connection);
}

export function parameterConnectionTooltip(
  parentModule: VerilogModule,
  instance: VerilogInstance,
  targetModule: VerilogModule,
  parameter: VerilogDecl,
  connection: VerilogPortConnection
): string {
  return parameterConnectionMarkdown(parentModule, instance, targetModule, parameter, connection);
}

export function effectiveParameterLines(module: VerilogModule, overrides?: VerilogConstantOverrides): string[] {
  return overridableParameters(module)
    .map((parameter) => {
      const value = effectiveParameterValue(parameter, module, overrides);
      if (value === undefined) {
        return undefined;
      }
      const source = overrides?.has(parameter.name) ? ' // override' : '';
      return `${parameter.name} = ${formatBigInt(value)}${source}`;
    })
    .filter((line): line is string => Boolean(line));
}

export function effectiveParameterValue(
  parameter: VerilogDecl,
  module: VerilogModule,
  overrides?: VerilogConstantOverrides
): bigint | undefined {
  const override = overrides?.get(parameter.name);
  if (override !== undefined) {
    return override;
  }
  if (parameter.initializerAst) {
    return evalExpressionAstConstant(parameter.initializerAst, module, overrides);
  }
  return parameter.constantValue;
}

export function widthMarkdownLines(label: string, info: WidthInfo): string[] {
  if (info.width === undefined) {
    return [];
  }
  return ['', `${label}: \`${info.width}\` bits`];
}

export function formatBigInt(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const hex = `0x${magnitude.toString(16)}`;
  return negative ? `${value.toString()} (-${hex})` : `${value.toString()} (${hex})`;
}

export function moduleMarkdown(module: VerilogModule): string {
  const params = overridableParameters(module).map((param) => declDetail(param));
  const ports = module.ports.map((port) => declDetail(port));
  const sections = [`**module ${module.name}**`];
  if (params.length) {
    sections.push('', 'Parameters:', '```verilog', ...limitedLines(params, 8), '```');
  }
  if (ports.length) {
    sections.push('', 'Ports:', '```verilog', ...limitedLines(ports, 12), '```');
  }
  return sections.join('\n');
}

function limitedLines(lines: string[], limit: number): string[] {
  return lines.length > limit ? [...lines.slice(0, limit), `// … ${lines.length - limit} more`] : lines;
}

export function portDirectionLabel(port: VerilogDecl): 'in' | 'out' | 'inout' {
  if (port.direction === 'output') {
    return 'out';
  }
  if (port.direction === 'inout') {
    return 'inout';
  }
  return 'in';
}

export function lineInRange(line: number, range: Range): boolean {
  return line >= range.start.line && line <= range.end.line;
}


