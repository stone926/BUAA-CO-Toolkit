import { evalExpressionAstConstant } from './expressions';
import type { VerilogConstantOverrides } from './expressions';
import { parseVerilogExpression } from './exprAst';
import type { VerilogDecl, VerilogInstance, VerilogModule, VerilogPortConnection } from './model';

export interface ResolvedParameterOverrides {
  readonly overrides: VerilogConstantOverrides | undefined;
  /** Overridden parameters whose value could not be evaluated statically (macros, functions). */
  readonly unresolved: readonly string[];
}

/**
 * Parameter values an instance passes to its module. `parentOverrides` are the
 * parent's own overridden parameters, so values propagate through several levels
 * of hierarchy (`#(.DEPTH(DEPTH))` inside an overridden parent).
 */
export function parameterOverridesForInstance(
  instance: VerilogInstance,
  parentModule: VerilogModule,
  targetModule: VerilogModule,
  parentOverrides?: VerilogConstantOverrides
): VerilogConstantOverrides | undefined {
  return resolveParameterOverrides(instance, parentModule, targetModule, parentOverrides).overrides;
}

/** Like `parameterOverridesForInstance`, but also reports overrides that could not be evaluated. */
export function resolveParameterOverrides(
  instance: VerilogInstance,
  parentModule: VerilogModule,
  targetModule: VerilogModule,
  parentOverrides?: VerilogConstantOverrides
): ResolvedParameterOverrides {
  const overrides = new Map<string, bigint>();
  const unresolved: string[] = [];
  for (const connection of instance.parameterConnections) {
    const target = targetParameterForConnection(targetModule, connection);
    if (!target || !connection.expression.trim()) {
      continue;
    }
    const value = evalExpressionAstConstant(
      connection.expressionAst ?? parseVerilogExpression(connection.expression),
      parentModule,
      parentOverrides
    );
    if (value === undefined) {
      unresolved.push(target.name);
    } else {
      overrides.set(target.name, value);
    }
  }
  return { overrides: overrides.size ? overrides : undefined, unresolved };
}

/** Parameters an instance can override, in positional order: localparams are skipped (IEEE 1364 §12.2). */
export function overridableParameters(module: VerilogModule): VerilogDecl[] {
  return module.parameters.filter((parameter) => parameter.kind !== 'localparam');
}

function targetParameterForConnection(targetModule: VerilogModule, connection: VerilogPortConnection) {
  const overridable = overridableParameters(targetModule);
  return connection.name
    ? overridable.find((parameter) => parameter.name === connection.name)
    : overridable[connection.positionalIndex];
}
