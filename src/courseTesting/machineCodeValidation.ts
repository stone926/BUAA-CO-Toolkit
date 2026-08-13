import { ProjectProfile } from '../projectProfile';
import { getLogisimTraceProfileConfig, getVerilogTestbenchConfig } from '../courseConfig';
import { defaultInstructionSets } from './mnemonicSets';
import { p7ExceptionHandlerAddress } from './p7Hardware';

export interface CourseMachineCodeViolation {
  index: number;
  address: number;
  word: string;
  mnemonic: string;
  reason?: string;
}

const rTypeFunct = new Map<number, string>([
  [0x00, 'sll'], [0x02, 'srl'], [0x03, 'sra'], [0x04, 'sllv'],
  [0x06, 'srlv'], [0x07, 'srav'], [0x08, 'jr'], [0x09, 'jalr'],
  [0x0a, 'movz'], [0x0b, 'movn'], [0x0c, 'syscall'],
  [0x10, 'mfhi'], [0x11, 'mthi'], [0x12, 'mflo'], [0x13, 'mtlo'],
  [0x18, 'mult'], [0x19, 'multu'], [0x1a, 'div'], [0x1b, 'divu'],
  [0x20, 'add'], [0x21, 'addu'], [0x22, 'sub'], [0x23, 'subu'],
  [0x24, 'and'], [0x25, 'or'], [0x26, 'xor'], [0x27, 'nor'],
  [0x2a, 'slt'], [0x2b, 'sltu'], [0x30, 'tge'], [0x31, 'tgeu'],
  [0x32, 'tlt'], [0x33, 'tltu'], [0x34, 'teq'], [0x36, 'tne']
]);

const special2Funct = new Map<number, string>([
  [0x00, 'madd'], [0x01, 'maddu'], [0x02, 'mul'], [0x04, 'msub'],
  [0x05, 'msubu'], [0x20, 'clz'], [0x21, 'clo']
]);

const regimmRt = new Map<number, string>([
  [0x00, 'bltz'], [0x01, 'bgez'], [0x08, 'tgei'], [0x09, 'tgeiu'],
  [0x0a, 'tlti'], [0x0b, 'tltiu'], [0x0c, 'teqi'], [0x0e, 'tnei'],
  [0x10, 'bltzal'], [0x11, 'bgezal']
]);

const opcodeMnemonics = new Map<number, string>([
  [0x02, 'j'], [0x03, 'jal'], [0x04, 'beq'], [0x05, 'bne'],
  [0x06, 'blez'], [0x07, 'bgtz'], [0x08, 'addi'], [0x09, 'addiu'],
  [0x0a, 'slti'], [0x0b, 'sltiu'], [0x0c, 'andi'], [0x0d, 'ori'],
  [0x0e, 'xori'], [0x0f, 'lui'], [0x20, 'lb'], [0x21, 'lh'],
  [0x22, 'lwl'], [0x23, 'lw'], [0x24, 'lbu'], [0x25, 'lhu'],
  [0x26, 'lwr'], [0x28, 'sb'], [0x29, 'sh'], [0x2a, 'swl'],
  [0x2b, 'sw'], [0x2e, 'swr']
]);

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
  const opcode = (word >>> 26) & 0x3f;
  if (opcode === 0) {
    if (word === 0) {
      return 'nop';
    }
    return decodeCanonicalSpecialInstruction(word);
  }
  if (opcode === 0x01) {
    return regimmRt.get((word >>> 16) & 0x1f);
  }
  if (opcode === 0x10) {
    if ((word >>> 0) === 0x42000018) {
      return 'eret';
    }
    const rs = (word >>> 21) & 0x1f;
    // The course only exposes the select-0 form of mfc0/mtc0. Accepting non-zero reserved/select
    // bits here would let a hand-written `.word` bypass the profile check and depend on RI or
    // implementation-specific COP0 decoding.
    if ((word & 0x7ff) !== 0) {
      return undefined;
    }
    const rd = (word >>> 11) & 0x1f;
    if (rs === 0) {
      return rd === 12 || rd === 13 || rd === 14 ? 'mfc0' : undefined;
    }
    if (rs === 4) {
      // The tutorial guarantees test programs never write Cause; only SR and EPC are writable
      // course inputs. Other CP0 registers are outside the required implementation surface.
      return rd === 12 || rd === 14 ? 'mtc0' : undefined;
    }
    return undefined;
  }
  if (opcode === 0x1c) {
    return decodeCanonicalSpecial2Instruction(word);
  }
  const mnemonic = opcodeMnemonics.get(opcode);
  if (!mnemonic) {
    return undefined;
  }
  // These encodings contain architecturally fixed zero fields. MARS-generated instructions are
  // canonical; checking them prevents arbitrary machine words from being accepted merely because
  // their opcode happens to name a course instruction.
  if ((mnemonic === 'blez' || mnemonic === 'bgtz') && ((word >>> 16) & 0x1f) !== 0) {
    return undefined;
  }
  if (mnemonic === 'lui' && ((word >>> 21) & 0x1f) !== 0) {
    return undefined;
  }
  return mnemonic;
}

function decodeCanonicalSpecialInstruction(word: number): string | undefined {
  const mnemonic = rTypeFunct.get(word & 0x3f);
  if (!mnemonic) {
    return undefined;
  }
  const rs = (word >>> 21) & 0x1f;
  const rt = (word >>> 16) & 0x1f;
  const rd = (word >>> 11) & 0x1f;
  const shamt = (word >>> 6) & 0x1f;

  switch (mnemonic) {
    case 'sll':
    case 'srl':
    case 'sra':
      return rs === 0 ? mnemonic : undefined;
    case 'sllv':
    case 'srlv':
    case 'srav':
    case 'movz':
    case 'movn':
    case 'add':
    case 'addu':
    case 'sub':
    case 'subu':
    case 'and':
    case 'or':
    case 'xor':
    case 'nor':
    case 'slt':
    case 'sltu':
      return shamt === 0 ? mnemonic : undefined;
    case 'jr':
      return rt === 0 && rd === 0 && shamt === 0 ? mnemonic : undefined;
    case 'jalr':
      return rt === 0 && shamt === 0 ? mnemonic : undefined;
    case 'mfhi':
    case 'mflo':
      return rs === 0 && rt === 0 && shamt === 0 ? mnemonic : undefined;
    case 'mthi':
    case 'mtlo':
      return rt === 0 && rd === 0 && shamt === 0 ? mnemonic : undefined;
    case 'mult':
    case 'multu':
    case 'div':
    case 'divu':
      return rd === 0 && shamt === 0 ? mnemonic : undefined;
    case 'tge':
    case 'tgeu':
    case 'tlt':
    case 'tltu':
    case 'teq':
    case 'tne':
      // Bits 15..6 form the architecturally valid trap code field.
      return mnemonic;
    case 'syscall':
      // Bits 25..6 form the architecturally valid syscall code field.
      return mnemonic;
    default:
      return undefined;
  }
}

function decodeCanonicalSpecial2Instruction(word: number): string | undefined {
  const mnemonic = special2Funct.get(word & 0x3f);
  if (!mnemonic) {
    return undefined;
  }
  const rt = (word >>> 16) & 0x1f;
  const rd = (word >>> 11) & 0x1f;
  const shamt = (word >>> 6) & 0x1f;
  switch (mnemonic) {
    case 'madd':
    case 'maddu':
    case 'msub':
    case 'msubu':
      return rd === 0 && shamt === 0 ? mnemonic : undefined;
    case 'mul':
      return shamt === 0 ? mnemonic : undefined;
    case 'clz':
    case 'clo':
      return rt === 0 && shamt === 0 ? mnemonic : undefined;
    default:
      return undefined;
  }
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
