// @index course-testing — provider-neutral course execution instruction budget
import { ProjectProfile } from '../projectProfile';

const builtinRandomAsmMarker = /^#\s*Built-in BUAA CO random ASM test\s*$/im;
const instructionCountMarker = /^#\s*instruction_count:\s*(\d+)\s*$/im;

/**
 * Deterministic architectural-instruction budget shared by all oracle providers. The budget is
 * part of the case input; adapters map it to their own cancellation/step mechanism.
 */
export function courseExecutionInstructionBudget(
  profile: ProjectProfile,
  asmText: string,
  trustedBuiltinSource: boolean,
  machineCodeText: string
): number {
  if (trustedBuiltinSource && builtinRandomAsmMarker.test(asmText)) {
    const match = instructionCountMarker.exec(asmText);
    const instructionCount = match ? Number(match[1]) : Number.NaN;
    if (Number.isSafeInteger(instructionCount) && instructionCount > 0) {
      return profile === 'P7'
        ? Math.max(512, instructionCount * 16 + 256)
        : Math.max(256, instructionCount * 2 + 64);
    }
  }

  const machineCodeWords = machineCodeText
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^0x/i, ''))
    .filter((line) => /^[0-9a-f]{8}$/i.test(line))
    .length;
  return Math.max(65_536, machineCodeWords * 64);
}
