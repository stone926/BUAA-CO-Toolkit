// @index instance-array — instance-array element counts and legal broadcast/partition widths
import { evalExpressionAstConstant } from './expressions';
import type { VerilogInstance, VerilogModule } from './model';

export function instanceArrayElementCount(instance: VerilogInstance, parent: VerilogModule): bigint | undefined {
  if (!instance.arrayRange) return 1n;
  if (instance.arrayRange.expressions.length !== 2) return undefined;
  const [left, right] = instance.arrayRange.expressions.map((expression) =>
    evalExpressionAstConstant(expression, parent, undefined, instance.selectionRange.start));
  return left === undefined || right === undefined ? undefined : (left >= right ? left - right : right - left) + 1n;
}

/** Every instance gets one port-width expression, or its slice of an aggregate expression. */
export function instancePortConnectionWidths(instance: VerilogInstance, portWidth: number | undefined, parent: VerilogModule): number[] | undefined {
  if (portWidth === undefined) return undefined;
  const count = instanceArrayElementCount(instance, parent);
  if (count === undefined) return undefined;
  const partitioned = BigInt(portWidth) * count;
  return partitioned > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : [...new Set([portWidth, Number(partitioned)])];
}
