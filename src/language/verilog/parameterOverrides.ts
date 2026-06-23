import { evalExpressionAstConstant, evalExpressionConstant } from './expressions';
import type { VerilogConstantOverrides } from './expressions';
import type { VerilogInstance, VerilogModule, VerilogPortConnection } from './model';

export function parameterOverridesForInstance(
  instance: VerilogInstance,
  parentModule: VerilogModule,
  targetModule: VerilogModule
): VerilogConstantOverrides | undefined {
  if (!instance.parameterConnections.length) {
    return undefined;
  }
  const overrides = new Map<string, bigint>();
  for (const connection of instance.parameterConnections) {
    const target = targetParameterForConnection(targetModule, connection);
    if (!target || !connection.expression.trim()) {
      continue;
    }
    const value = connection.expressionAst
      ? evalExpressionAstConstant(connection.expressionAst, parentModule)
      : evalExpressionConstant(connection.expression, parentModule);
    if (value !== undefined) {
      overrides.set(target.name, value);
    }
  }
  return overrides.size ? overrides : undefined;
}

function targetParameterForConnection(targetModule: VerilogModule, connection: VerilogPortConnection) {
  return connection.name
    ? targetModule.parameters.find((parameter) => parameter.name === connection.name)
    : targetModule.parameters[connection.positionalIndex];
}
