// @index course-testing — P7 generator RI mnemonic detection over parsed source code

import type { ProjectProfile } from '../projectProfile';
import type { SourceUnit } from '../mips/core/api';
import { parseAssemblerLine } from '../mips/core/assembler/syntax';

export const p7InternalUnknownInstructionMnemonic = '_co_internal_unknown_instruction';

/**
 * Detect the generator-only P7 RI instruction from executable source syntax.
 * Comments, string operands and labels with the same spelling are deliberately
 * ignored; the legacy custom instruction class must never leak into P3-P6.
 */
export function sourceUnitsUseP7RiInstruction(
  profile: ProjectProfile,
  sources: readonly Pick<SourceUnit, 'id' | 'text'>[]
): boolean {
  if (profile !== 'P7') return false;

  return sources.some((source) => source.text.split(/\r\n|\r|\n/).some((rawLine, line) => {
    const text = line === 0 ? rawLine.replace(/^\uFEFF/, '') : rawLine;
    const parsed = parseAssemblerLine({
      sourceId: source.id,
      line,
      startOffset: 0,
      endOffset: text.length,
      text,
      expansionStack: []
    });
    return parsed.kind === 'statement'
      && parsed.mnemonic?.toLowerCase() === p7InternalUnknownInstructionMnemonic;
  }));
}
