import { convertTypedConstantForDecl, evalExpressionAstTypedConstant, hasDeclaredIntegralWidth, widthOfDecl } from './expressions';
import { integerConstantValue, VerilogIntegralConstant } from './typedConstants';
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
  const typedValues = new Map<string, VerilogIntegralConstant>();
  const overrides = Object.assign(new Map<string, bigint>(), { typedValues });
  const unresolved: string[] = [];
  // Declaration order makes a later parameter's declared range see earlier overrides,
  // regardless of the order of named connections at the call site.
  for (const target of overridableParameters(targetModule)) {
    const connection = instance.parameterConnections.find((candidate) => targetParameterForConnection(targetModule, candidate) === target);
    if (!connection?.expression.trim()) { continue; }
    const expectedWidth = hasDeclaredIntegralWidth(target) ? widthOfDecl(target, targetModule, overrides).width : undefined;
    const evaluated = evalExpressionAstTypedConstant(
      connection.expressionAst ?? parseVerilogExpression(connection.expression),
      parentModule,
      parentOverrides,
      connection.expressionRange.start,
      expectedWidth
    );
    const value = evaluated && convertTypedConstantForDecl(evaluated, target, targetModule, overrides);
    if (!value) {
      unresolved.push(target.name);
      continue;
    }
    typedValues.set(target.name, value);
    const integer = integerConstantValue(value);
    if (integer !== undefined) { overrides.set(target.name, integer); }
  }
  return { overrides: typedValues.size ? overrides : undefined, unresolved };
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
