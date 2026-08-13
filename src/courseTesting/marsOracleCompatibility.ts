import { ProjectProfile } from '../projectProfile';
import {
  machineCodeNeedsUndefinedBehaviorTrace,
  marsDetailedUndefinedBehaviorError,
  mipsInstructionReadRegisters,
  parseCpuTraceLine
} from '../language/mips/traceParser';
import { decodeCourseMachineInstruction } from './machineCodeValidation';
import { stableMarsImageCompatibilityError } from './marsImageCompatibility';
import {
  p7ExceptionHandlerAddress,
  p7ExternalInterruptAckAddress,
  p7Timer0Count,
  p7Timer0Ctrl,
  p7Timer0Preset,
  p7Timer1Count,
  p7Timer1Ctrl,
  p7Timer1Preset,
  p7UserTextBaseAddress
} from './p7Hardware';

const stableMarsNonzeroResetRegisters = new Set([28, 29]);
const memoryOpcodes = new Set([
  0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26,
  0x28, 0x29, 0x2a, 0x2b, 0x2e
]);
const specialTrapFuncts = new Set([0x30, 0x31, 0x32, 0x33, 0x34, 0x36]);
const immediateTrapRt = new Set([0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0e]);
const detailedMarsInstructionPattern = /^@PC(?:0x)?([0-9a-f]{1,8})\s*->.*\(([0-9a-f]{8})\)\s*$/i;
const courseDataAddressMaximum = 0x00002fff;
const p7TimerRegisterAddresses = new Set([
  p7Timer0Ctrl, p7Timer0Preset, p7Timer0Count,
  p7Timer1Ctrl, p7Timer1Preset, p7Timer1Count
]);

type MemoryAccessShape = 'plain' | 'left' | 'right';

interface MemoryAccess {
  mnemonic: string;
  baseRegister: number;
  signedOffset: number;
  width: number;
  shape: MemoryAccessShape;
}

/**
 * Stable Mars v0.6.3 seeds $gp/$sp from the Compact* memory map while every course CPU resets
 * every GPR to zero. The ordinary coL2 checker handles instructions which complete and emit an
 * instruction header. P7 needs one conservative static fallback because efc-handled AdEL/AdES,
 * Ov, trap, and syscall instructions emit no header at all in that release.
 */
export function courseMarsOracleCompatibilityError(
  profile: ProjectProfile,
  machineCodeText: string,
  marsTraceText: string,
  delayedBranching: boolean
): string | undefined {
  const dynamicError = marsDetailedUndefinedBehaviorError(marsTraceText, delayedBranching);
  if (dynamicError) {
    return dynamicError;
  }
  const imageError = stableMarsImageCompatibilityError(profile, machineCodeText, marsTraceText);
  if (imageError) {
    return imageError;
  }
  const addressError = stableMarsCourseAddressError(profile, marsTraceText);
  if (addressError) {
    return addressError;
  }
  return profile === 'P7'
    ? stableMarsP7UnobservableResetReadError(machineCodeText)
    : undefined;
}

export function machineCodeNeedsMarsOracleCompatibilityTrace(
  machineCodeText: string,
  delayedBranching: boolean
): boolean {
  return machineCodeNeedsUndefinedBehaviorTrace(machineCodeText, delayedBranching)
    || machineCodeWords(machineCodeText).some((word) => decodeMemoryAccess(word) !== undefined);
}

/**
 * Stable Mars v0.6.3 accepts several Compact* memory segments which do not exist in the course
 * CPU. Reconstruct the pre-instruction GPR state from successful coL2 blocks and reject those
 * Mars-only accesses before their values can become golden-model results.
 *
 * P7 faults which stable `efc` handles are absent from coL2, but successful accesses to MARS
 * kernel data (for example 0x8000) are visible and must still be filtered here. The external
 * interrupt generator window is intentionally left to the P7 IG contract checker.
 */
export function stableMarsCourseAddressError(
  profile: ProjectProfile,
  marsTraceText: string
): string | undefined {
  if (profile !== 'P3' && profile !== 'P4' && profile !== 'P5'
    && profile !== 'P6' && profile !== 'P7') {
    return undefined;
  }

  // Mirror marsDetailedUndefinedBehaviorError's stable-reset seed and its ordering: validate a
  // header against pre-instruction state, then apply that block's GPR writes for the next header.
  const registers = new Uint32Array(32);
  registers[28] = 0x00001800;
  registers[29] = 0x00002ffc;
  let currentPc: number | undefined;
  let lineNumber = 0;

  for (const rawLine of marsTraceText.split(/\r?\n/)) {
    lineNumber++;
    const header = detailedMarsInstructionPattern.exec(rawLine.trim());
    if (header) {
      currentPc = Number.parseInt(header[1], 16) >>> 0;
      const word = Number.parseInt(header[2], 16) >>> 0;
      const access = decodeMemoryAccess(word);
      if (!access) {
        continue;
      }

      const signedBase = toSigned32(registers[access.baseRegister]);
      const mathematicalAddress = signedBase + access.signedOffset;
      if (mathematicalAddress < -0x80000000 || mathematicalAddress > 0x7fffffff) {
        return `${profile} 测试程序在 ${hexAddress(currentPc)} 实际执行 ${access.mnemonic}，有效地址计算发生 32 位有符号溢出（$${access.baseRegister}=${hexAddress(registers[access.baseRegister])}，偏移 ${access.signedOffset}）；不能采用稳定版 MARS 的环绕结果作为课程 oracle`;
      }

      const effectiveAddress = mathematicalAddress >>> 0;
      const [spanStart, spanEnd] = memoryAccessSpan(effectiveAddress, access);
      if (!courseMemoryAccessAllowed(profile, effectiveAddress, spanStart, spanEnd, access)) {
        const allowed = profile === 'P7'
          ? 'P7 仅允许课程 DM 0x00000000..0x00002fff、TC0/TC1 的 word 寄存器访问及另行校验的中断发生器窗口'
          : `${profile} 仅允许课程 DM 0x00000000..0x00002fff`;
        return `${profile} 测试程序在 ${hexAddress(currentPc)} 实际执行 ${access.mnemonic}，有效地址 ${hexAddress(effectiveAddress)} 的完整访问跨度为 ${hexAddress(spanStart)}..${hexAddress(spanEnd)}；${allowed}。稳定版 MARS v0.6.3 还映射了课程硬件不存在的内存段，不能将该结果用作 oracle`;
      }
      continue;
    }

    if (currentPc === undefined || !rawLine.startsWith('\t\t')) {
      continue;
    }
    const event = parseCpuTraceLine(`@${currentPc.toString(16)}: ${rawLine.trim()}`, lineNumber);
    if (event?.kind !== 'grf') {
      continue;
    }
    const register = Number(event.target);
    if (Number.isInteger(register) && register > 0 && register < 32) {
      registers[register] = Number.parseInt(event.value, 16) >>> 0;
    }
  }
  return undefined;
}

function decodeMemoryAccess(word: number): MemoryAccess | undefined {
  const opcode = word >>> 26;
  const baseRegister = (word >>> 21) & 0x1f;
  const signedOffset = (word << 16) >> 16;
  const common = { baseRegister, signedOffset };
  switch (opcode) {
    case 0x20: return { ...common, mnemonic: 'lb', width: 1, shape: 'plain' };
    case 0x21: return { ...common, mnemonic: 'lh', width: 2, shape: 'plain' };
    case 0x22: return { ...common, mnemonic: 'lwl', width: 4, shape: 'left' };
    case 0x23: return { ...common, mnemonic: 'lw', width: 4, shape: 'plain' };
    case 0x24: return { ...common, mnemonic: 'lbu', width: 1, shape: 'plain' };
    case 0x25: return { ...common, mnemonic: 'lhu', width: 2, shape: 'plain' };
    case 0x26: return { ...common, mnemonic: 'lwr', width: 4, shape: 'right' };
    case 0x28: return { ...common, mnemonic: 'sb', width: 1, shape: 'plain' };
    case 0x29: return { ...common, mnemonic: 'sh', width: 2, shape: 'plain' };
    case 0x2a: return { ...common, mnemonic: 'swl', width: 4, shape: 'left' };
    case 0x2b: return { ...common, mnemonic: 'sw', width: 4, shape: 'plain' };
    case 0x2e: return { ...common, mnemonic: 'swr', width: 4, shape: 'right' };
    default: return undefined;
  }
}

function memoryAccessSpan(effectiveAddress: number, access: MemoryAccess): [number, number] {
  if (access.shape === 'left') {
    return [(effectiveAddress & 0xfffffffc) >>> 0, effectiveAddress];
  }
  if (access.shape === 'right') {
    return [effectiveAddress, (effectiveAddress | 0x3) >>> 0];
  }
  return [effectiveAddress, effectiveAddress + access.width - 1];
}

function courseMemoryAccessAllowed(
  profile: ProjectProfile,
  effectiveAddress: number,
  spanStart: number,
  spanEnd: number,
  access: MemoryAccess
): boolean {
  if (spanStart >= 0 && spanEnd <= courseDataAddressMaximum) {
    return true;
  }
  if (profile !== 'P7') {
    return false;
  }
  if (access.shape === 'plain' && access.width === 4 && p7TimerRegisterAddresses.has(effectiveAddress)) {
    return true;
  }
  // Exact IG semantics (read/write direction and width) are enforced by the dedicated P7
  // fetch/device contract. Do not reject it here merely because it is outside DM.
  return spanStart >= p7ExternalInterruptAckAddress
    && spanEnd < p7ExternalInterruptAckAddress + 4;
}

function toSigned32(value: number): number {
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

function hexAddress(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Reject only P7 reads which could fault before stable coL2 reports the instruction. To avoid
 * pretending to solve general control-flow dominance here, a $gp/$sp initialization is accepted
 * for this fallback only when it is an explicit constant write in the straight-line, non-faulting
 * entry prefix. Dynamic coL2 validation remains path-sensitive for every observable instruction.
 */
export function stableMarsP7UnobservableResetReadError(machineCodeText: string): string | undefined {
  const words = machineCodeWords(machineCodeText);
  const handlerIndex = (p7ExceptionHandlerAddress - p7UserTextBaseAddress) / 4;
  const userInitializers = entryPrefixConstantInitializers(words, 0, Math.min(words.length, handlerIndex));
  const handlerInitializers = entryPrefixConstantInitializers(words, handlerIndex, words.length);

  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (!mayRaiseBeforeStableMarsDetailedHeader(word)) {
      continue;
    }
    for (const register of mipsInstructionReadRegisters(word)) {
      if (!stableMarsNonzeroResetRegisters.has(register)) {
        continue;
      }
      const initializedInUser = (userInitializers.get(register) ?? Number.POSITIVE_INFINITY) < index;
      const initializedInHandler = index >= handlerIndex
        && (handlerInitializers.get(register) ?? Number.POSITIVE_INFINITY) < index;
      if (initializedInUser || initializedInHandler) {
        continue;
      }
      const pc = (p7UserTextBaseAddress + index * 4) >>> 0;
      const name = register === 28 ? '$gp/$28' : '$sp/$29';
      return `P7 测试程序在 0x${pc.toString(16)} 的异常候选指令中读取 ${name}，但稳定版 MARS v0.6.3 可能在输出 coL2 指令头前处理异常；课程 CPU 将该寄存器复位为 0，而 MARS 初值非零。请在对应入口的首个控制转移或异常候选指令之前用 ori/lui 等不读取旧值的指令显式初始化该寄存器`;
    }
  }
  return undefined;
}

function entryPrefixConstantInitializers(
  words: readonly number[],
  start: number,
  end: number
): Map<number, number> {
  const initialized = new Map<number, number>();
  if (start < 0 || start >= end || start >= words.length) {
    return initialized;
  }
  for (let index = start; index < end; index++) {
    const word = words[index];
    const destination = constantWriteDestination(word);
    if (isControlTransfer(word)
      || (mayRaiseBeforeStableMarsDetailedHeader(word) && destination === undefined)
      || decodeCourseMachineInstruction(word) === undefined) {
      break;
    }
    if (destination !== undefined
      && stableMarsNonzeroResetRegisters.has(destination)
      && !initialized.has(destination)) {
      initialized.set(destination, index);
    }
  }
  return initialized;
}

/** Only accept unambiguous, exception-free writes which do not consume the old destination. */
function constantWriteDestination(word: number): number | undefined {
  const opcode = word >>> 26;
  const rs = (word >>> 21) & 0x1f;
  const rt = (word >>> 16) & 0x1f;
  if (opcode === 0x0f) {
    return rt; // lui
  }
  if (opcode >= 0x08 && opcode <= 0x0e && rs === 0) {
    return rt; // addi(u), slti(u), andi, ori, xori from $zero
  }
  return undefined;
}

function mayRaiseBeforeStableMarsDetailedHeader(word: number): boolean {
  const opcode = word >>> 26;
  const funct = word & 0x3f;
  const rt = (word >>> 16) & 0x1f;
  if (memoryOpcodes.has(opcode) || opcode === 0x08) {
    return true;
  }
  if (opcode === 0) {
    return funct === 0x0c || funct === 0x20 || funct === 0x22 || specialTrapFuncts.has(funct);
  }
  return opcode === 0x01 && immediateTrapRt.has(rt);
}

function isControlTransfer(word: number): boolean {
  const opcode = word >>> 26;
  if (opcode >= 0x02 && opcode <= 0x07) {
    return true;
  }
  if (opcode === 0x01) {
    const rt = (word >>> 16) & 0x1f;
    return rt === 0x00 || rt === 0x01 || rt === 0x10 || rt === 0x11;
  }
  return (opcode === 0 && ((word & 0x3f) === 0x08 || (word & 0x3f) === 0x09))
    || word === 0x42000018;
}

function machineCodeWords(text: string): number[] {
  return text.split(/\r?\n/)
    .map((line) => line.trim().replace(/^0x/i, ''))
    .filter((line) => /^[0-9a-f]{8}$/i.test(line))
    .map((line) => Number.parseInt(line, 16) >>> 0);
}
