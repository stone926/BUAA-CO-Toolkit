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
  if (width !== undefined && decl.kind !== 'task') {
    parts.push(`${decl.kind === 'function' ? '返回位宽' : '位宽'}：\`${width}\` 位`);
  } else if (decl.width) {
    parts.push(`范围：\`${decl.width}\``);
  }
  if (decl.constantValue !== undefined) {
    parts.push(`常量值：\`${formatBigInt(decl.constantValue)}\``);
  }
  if (decl.unpackedDimensions?.length) {
    parts.push(`数组维度：\`${decl.unpackedDimensions.map((dimension) => dimension.text).join('')}\``);
  }
  return parts.join(' · ');
}

export function instanceMarkdown(instance: VerilogInstance, parentModule: VerilogModule, targetModule: VerilogModule | undefined): string {
  const lines = [`模块 \`${instance.moduleName}\` 的实例 \`${instance.instanceName}\``];
  if (!targetModule) {
    return lines.join('\n');
  }
  const overrides = parameterOverridesForInstance(instance, parentModule, targetModule);
  const parameterLines = effectiveParameterLines(targetModule, overrides);
  if (parameterLines.length) {
    lines.push('', '生效参数：', '```verilog', ...parameterLines, '```');
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
  const lines = [`模块 \`${targetModule.name}\` 的端口 \`${port.name}\` · **${port.direction ?? port.kind}**`];
  const overrides = parameterOverridesForInstance(instance, parentModule, targetModule);
  const expected = widthOfDecl(port, targetModule, overrides);
  const actual = connection.expressionAst ? widthOfExpressionAst(connection.expressionAst, parentModule) : undefined;
  if (expected.width !== undefined) {
    lines.push('', `端口位宽：\`${expected.width}\` 位`);
  }
  if (actual?.width !== undefined && actual.width !== expected.width) {
    lines.push('', `连接位宽：\`${actual.width}\` 位`);
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
  const lines = [`模块 \`${targetModule.name}\` 的参数 \`${parameter.name}\` · **${parameter.kind}**`];
  const overrides = parameterOverridesForInstance(instance, parentModule, targetModule);
  const effective = effectiveParameterValue(parameter, targetModule, overrides);
  if (effective !== undefined) {
    lines.push('', `生效值：\`${formatBigInt(effective)}\``);
  }
  const supplied = connection.expressionAst
    ? evalExpressionAstConstant(connection.expressionAst, parentModule)
    : undefined;
  if (supplied !== undefined && supplied !== effective) {
    lines.push('', `传入值：\`${formatBigInt(supplied)}\``);
  }
  const width = widthOfDecl(parameter, targetModule, overrides);
  lines.push(...widthMarkdownLines('参数位宽', width));
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
      const source = overrides?.has(parameter.name) ? ' // 已覆盖' : '';
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
  return ['', `${label}：\`${info.width}\` 位`];
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
  const sections = [`**模块 ${module.name}**`];
  if (ports.length) {
    sections.push('', '端口：', '```verilog', ...ports, '```');
  }
  if (params.length) {
    sections.push('', '参数：', '```verilog', ...params, '```');
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


