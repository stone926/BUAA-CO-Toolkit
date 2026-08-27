import { ProjectProfile } from '../projectProfile';
import { getLogisimTraceProfileConfig, getVerilogTestbenchConfig } from '../courseConfig';
import { defaultInstructionSets } from './mnemonicSets';
import { p7ExceptionHandlerAddress } from './p7Hardware';
import { decodeCourseInstructionWord } from '../mips/core/isa/decoder';

export interface CourseMachineCodeViolation {
  index: number;
  address: number;
  word: string;
  mnemonic: string;
  reason?: string;
}

const builtinGeneratorMarker = /^#\s*Built-in BUAA CO (?:random|P7 probe) ASM test\s*$/im;
/** Stable Mars v0.6.3 Compact* uses 0x6ffc as an exclusive text limit. */
export const stableMarsCourseInstructionMemoryWords = 4095;

export function validateCourseMachineCode(
  profile: ProjectProfile,
  machineCodeText: string,
  asmText = '',
  trustedBuiltinSource = false
): CourseMachineCodeViolation[] {
  if (!(profile in defaultInstructionSets)) {
    return [];
  }
  const allowed = new Set(defaultInstructionSets[profile as keyof typeof defaultInstructionSets]);
  for (const mnemonic of trustedBuiltinSource ? declaredBuiltinInstructionSet(asmText) : []) {
    allowed.add(mnemonic);
  }
  const allowInternalRi = trustedBuiltinSource
    && profile === 'P7'
    && /\b_co_internal_unknown_instruction\b/.test(asmText);
  const words = machineCodeWords(machineCodeText);
  const violations: CourseMachineCodeViolation[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const value = Number.parseInt(word, 16) >>> 0;
    const mnemonic = decodeCourseMachineInstruction(value);
    const allowedInternalRi = allowInternalRi && value === 0x0000003f;
    const address = 0x3000 + index * 4;
    const placementReason = profile === 'P7' && mnemonic === 'eret' && address < p7ExceptionHandlerAddress
      ? `教程规定 eret 只会出现在 0x${p7ExceptionHandlerAddress.toString(16)} 起的异常处理程序中`
      : undefined;
    if (placementReason || (!allowedInternalRi && (!mnemonic || !allowed.has(mnemonic)))) {
      violations.push({
        index,
        address,
        word,
        mnemonic: mnemonic ?? 'unknown',
        reason: placementReason
      });
    }
  }
  return violations;
}

export function courseMachineCodeValidationError(
  profile: ProjectProfile,
  machineCodeText: string,
  asmText = '',
  trustedBuiltinSource = false
): string | undefined {
  const capacityError = courseMachineCodeCapacityError(profile, machineCodeLineCount(machineCodeText));
  if (capacityError) {
    return capacityError;
  }
  const violations = validateCourseMachineCode(profile, machineCodeText, asmText, trustedBuiltinSource);
  if (!violations.length) {
    return undefined;
  }
  const samples = violations.slice(0, 5).map((item) =>
    `0x${item.address.toString(16)}=${item.word}(${item.mnemonic}${item.reason ? `：${item.reason}` : ''})`
  ).join('、');
  const remaining = violations.length > 5 ? `，另有 ${violations.length - 5} 条` : '';
  return `${profile} 机器码包含课程指令集之外的汇编展开结果：${samples}${remaining}`;
}

/**
 * Validate both the course hardware capacity and the slightly smaller oracle range exposed by
 * stable Mars v0.6.3. Course hardware has 4096 words through 0x6ffc, but that MARS release treats
 * 0x6ffc as an exclusive Compact* text limit, so an automated oracle image can use only the first
 * 4095 words through 0x6ff8.
 */
export function courseMachineCodeCapacityError(
  profile: ProjectProfile,
  wordCount: number
): string | undefined {
  const capacity = courseInstructionMemoryWords(profile);
  if (capacity === undefined) {
    return undefined;
  }
  if (wordCount > capacity) {
    return `${profile} 最终机器码共有 ${wordCount} words，超过教程 IM ${capacity} words 容量（0x3000..0x6ffc）。MARS large-text 内存配置可执行超出部分，但课程硬件无法装载。`;
  }
  if (wordCount > stableMarsCourseInstructionMemoryWords) {
    return `${profile} 最终机器码共有 ${wordCount} words；教程 IM 可容纳 ${capacity} words，但稳定版 MARS v0.6.3 的 Compact* 文本上界 0x6ffc 为排他值，课程 oracle 最多支持 ${stableMarsCourseInstructionMemoryWords} words（末址 0x6ff8）。请缩短 1 word`;
  }
  return undefined;
}

export function decodeCourseMachineInstruction(word: number): string | undefined {
  return decodeCourseInstructionWord(word >>> 0);
}

function machineCodeWords(text: string): string[] {
  return text.split(/\r?\n/)
    .map((line) => line.trim().replace(/^0x/i, '').toLowerCase())
    .filter((line) => /^[0-9a-f]{8}$/.test(line));
}

function machineCodeLineCount(text: string): number {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
}

function courseInstructionMemoryWords(profile: ProjectProfile): number | undefined {
  if (profile === 'P3') {
    return getLogisimTraceProfileConfig(profile)?.romMaxWords;
  }
  if (profile === 'P4' || profile === 'P5' || profile === 'P6' || profile === 'P7') {
    return getVerilogTestbenchConfig().externalInstructionMemoryWords;
  }
  return undefined;
}

function declaredBuiltinInstructionSet(asmText: string): string[] {
  if (!builtinGeneratorMarker.test(asmText)) {
    return [];
  }
  const match = /^#\s*instruction_set:\s*(.*)$/im.exec(asmText);
  return match ? match[1].trim().split(/\s+/).filter(Boolean) : [];
}
