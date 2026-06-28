// @index(render Verilog language-service hover and hint text)
import { Hover, MarkupKind, Range } from 'vscode-languageserver/node';
import { VerilogConstantOverrides, WidthInfo, evalExpressionAstConstant, widthOfDecl, widthOfExpressionAst } from './expressions';
import { parameterOverridesForInstance } from './parameterOverrides';
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

export function instanceMarkdown(instance: VerilogInstance, parentModule: VerilogModule, targetModule: VerilogModule | undefined): string {
  const lines = [`Instance \`${instance.instanceName}\` of module \`${instance.moduleName}\`.`];
  if (!targetModule) {
    return lines.join('\n');
  }
  const overrides = parameterOverridesForInstance(instance, parentModule, targetModule);
  const parameterLines = effectiveParameterLines(targetModule, overrides);
  if (parameterLines.length) {
    lines.push('', 'Effective parameters:', '```verilog', ...parameterLines, '```');
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
  const lines = [
    `Port \`${port.name}\` on module \`${targetModule.name}\``,
    '',
    `\`${declDetail(port)}\``
  ];
  const overrides = parameterOverridesForInstance(instance, parentModule, targetModule);
  const expected = widthOfDecl(port, targetModule, overrides);
  const actual = connection.expressionAst ? widthOfExpressionAst(connection.expressionAst, parentModule) : undefined;
  lines.push(...widthMarkdownLines('Effective width', expected));
  if (actual) {
    lines.push(...widthMarkdownLines('Connection width', actual));
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
  const lines = [
    `Parameter \`${parameter.name}\` on module \`${targetModule.name}\``,
    '',
    `\`${declDetail(parameter)}\``
  ];
  const overrides = parameterOverridesForInstance(instance, parentModule, targetModule);
  const effective = effectiveParameterValue(parameter, targetModule, overrides);
  if (effective !== undefined) {
    lines.push('', `Effective value: \`${formatBigInt(effective)}\``);
  }
  const supplied = connection.expressionAst
    ? evalExpressionAstConstant(connection.expressionAst, parentModule)
    : undefined;
  if (supplied !== undefined) {
    lines.push(`Connection value: \`${formatBigInt(supplied)}\``);
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
  return module.parameters
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
  let text = `${label}: \`${info.width}\``;
  if (info.minWidth !== undefined && info.minWidth !== info.width) {
    text += ` (min: \`${info.minWidth}\`)`;
  }
  if (info.flexible) {
    text += ' *(flexible)*';
  }
  return ['', text];
}

export function formatBigInt(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const hex = `0x${magnitude.toString(16)}`;
  return negative ? `${value.toString()} (-${hex})` : `${value.toString()} (${hex})`;
}

export function moduleMarkdown(module: VerilogModule): string {
  const params = module.parameters.map((param) => declDetail(param));
  const ports = module.ports.map((port) => declDetail(port));
  const sections = [`**module ${module.name}**`];
  if (params.length) {
    sections.push('', 'Parameters:', '```verilog', ...params, '```');
  }
  if (ports.length) {
    sections.push('', 'Ports:', '```verilog', ...ports, '```');
  }
  return sections.join('\n');
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


