// @index mips-core — Executable instruction availability shared by assembler consumers and language tooling
import { CourseProfile, isaInstructionByMnemonic } from '../generated/isaCatalog';
import { isBuiltinPseudoMnemonic } from './pseudo';
import { isMarsIntegerExtensionMnemonic } from './marsIntegerPseudo';
import { marsInstructionByMnemonic } from './marsInstructionFacts';

export type AssemblerMode = CourseProfile | 'mars';

/** Mnemonic availability; individual operand forms are validated by the shared assembler. */
export function isSupportedAssemblerMnemonic(mnemonic: string, mode: AssemblerMode): boolean {
  const name = mnemonic.toLowerCase();
  const instruction = isaInstructionByMnemonic.get(name);
  if (instruction && (mode === 'mars' || instruction.profiles.includes(mode))) return true;
  if (isBuiltinPseudoMnemonic(name)) return true;
  return mode === 'mars' && (isMarsIntegerExtensionMnemonic(name) || marsInstructionByMnemonic.has(name));
}
