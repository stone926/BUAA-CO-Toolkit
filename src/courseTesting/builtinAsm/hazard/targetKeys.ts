// @index hazard-target-keys — Generator-specific concrete operand coverage, separate from course scoring tuples.
import type { SourceRole } from '../../../hazardAnalysis/hazardTiming';

/** Course scoring tuples omit operand ports; a concrete target must retain both port and gap. */
export function forwardOperandKey(producer: string, consumer: string, role: SourceRole, gap: number): string {
  return `operand:${producer}>${consumer}.${role}+${gap}`;
}
