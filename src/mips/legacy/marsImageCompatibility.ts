// @index stable-mars-image-compatibility — 用最终硬件 HexText 约束稳定版 MARS 的动态取指与 P7 IG 应答
import { ProjectProfile } from '../../projectProfile';
import { p7ExceptionHandlerAddress, p7UserTextBaseAddress } from '../../courseTesting/p7Hardware';

const detailedMarsInstructionPattern = /^@PC(?:0x)?([0-9a-f]{1,8})\s*->.*\(([0-9a-f]{8})\)\s*$/i;
const detailedMarsRegisterWritePattern = /^\s*\$\s*(\d{1,2})\s*<=\s*(?:0x)?([0-9a-f]{1,8})\s*$/i;
const p7InterruptGeneratorStart = 0x00007f20;
const p7InterruptGeneratorEnd = 0x00007f23;
const exactP7InterruptAcknowledgeWord = 0xa0007f20;
const stableMarsGlobalPointer = 0x00001800;
const stableMarsStackPointer = 0x00002ffc;

interface ParsedMachineCode {
  words?: number[];
  error?: string;
}

interface MemoryAccess {
  effectiveAddress: number;
  byteAddresses: number[];
  alignment: number;
}

/**
 * Stable Mars v0.6.3 has no notion of the final HexText image loaded into the course CPU. Check
 * every successfully executed coL2 instruction against that image, including P7's zero padding
 * and merged handler. P7 additionally restricts a dynamically observed interrupt-generator
 * access to the tutorial's exact handler acknowledgement instruction.
 */
export function stableMarsImageCompatibilityError(
  profile: ProjectProfile,
  machineCodeText: string,
  marsTraceText: string
): string | undefined {
  const parsed = parseMachineCode(machineCodeText);
  if (parsed.error) {
    return parsed.error;
  }
  const words = parsed.words!;
  if (!words.length) {
    return '最终 hardware code image 为空，无法验证稳定版 MARS 的动态取指';
  }

  const registers = stableMarsResetRegisters();
  let currentHeaderSeen = false;
  for (const rawLine of marsTraceText.split(/\r?\n/)) {
    const header = detailedMarsInstructionPattern.exec(rawLine.trim());
    if (header) {
      currentHeaderSeen = true;
      const pc = Number.parseInt(header[1], 16) >>> 0;
      const word = Number.parseInt(header[2], 16) >>> 0;
      const imageError = dynamicFetchImageError(words, pc, word);
      if (imageError) {
        return imageError;
      }
      if (profile === 'P7') {
        const access = decodedMemoryAccess(word, registers);
        if (access && touchesP7InterruptGenerator(access)
          && !isExactP7InterruptAcknowledge(pc, word)) {
          return `P7 稳定版 MARS 在 PC 0x${hex(pc)} 动态执行机器码 0x${hex(word)}，其有效地址 0x${hex(access.effectiveAddress)} 触及中断发生器 0x7f20..0x7f23；仅允许最终 hardware image 的 handler（PC >= 0x${hex(p7ExceptionHandlerAddress)}）执行精确机器码 0x${hex(exactP7InterruptAcknowledgeWord)}（sb $0, 0x7f20($0)）`;
        }
      }
      continue;
    }

    if (!currentHeaderSeen || !rawLine.startsWith('\t\t')) {
      continue;
    }
    const registerWrite = detailedMarsRegisterWritePattern.exec(rawLine.trim());
    if (!registerWrite) {
      continue;
    }
    const register = Number.parseInt(registerWrite[1], 10);
    if (register > 0 && register < registers.length) {
      registers[register] = Number.parseInt(registerWrite[2], 16) >>> 0;
    }
  }

  return profile === 'P7'
    ? unobservableP7InterruptGeneratorError(words)
    : undefined;
}

function parseMachineCode(text: string): ParsedMachineCode {
  const words: number[] = [];
  let lineNumber = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    lineNumber++;
    const token = rawLine.trim().replace(/^0x/i, '');
    if (!token) {
      continue;
    }
    if (!/^[0-9a-f]{8}$/i.test(token)) {
      return {
        error: `最终 hardware code image 第 ${lineNumber} 行不是 8 位 HexText 机器码：${JSON.stringify(rawLine.trim())}`
      };
    }
    words.push(Number.parseInt(token, 16) >>> 0);
  }
  return { words };
}

function dynamicFetchImageError(words: readonly number[], pc: number, word: number): string | undefined {
  const offset = pc - p7UserTextBaseAddress;
  const lastAddress = p7UserTextBaseAddress + (words.length - 1) * 4;
  if (pc < p7UserTextBaseAddress || (pc & 0x3) !== 0 || offset / 4 >= words.length) {
    return `稳定版 MARS coL2 动态执行 PC 0x${hex(pc)}，但最终 hardware code image 仅装载 0x${hex(p7UserTextBaseAddress)}..0x${hex(lastAddress)} 的对齐指令；拒绝使用 hardware image 之外的 MARS statement 作为 oracle`;
  }
  const expected = words[offset / 4];
  if (expected !== word) {
    return `稳定版 MARS coL2 在 PC 0x${hex(pc)} 报告机器码 0x${hex(word)}，但最终 hardware code image 同地址为 0x${hex(expected)}；拒绝执行未装载或与 P7 padding/handler 合并结果不同的 MARS statement`;
  }
  return undefined;
}

function stableMarsResetRegisters(): Uint32Array {
  const registers = new Uint32Array(32);
  registers[28] = stableMarsGlobalPointer;
  registers[29] = stableMarsStackPointer;
  return registers;
}

function decodedMemoryAccess(word: number, registers: ArrayLike<number | undefined>): MemoryAccess | undefined {
  const opcode = word >>> 26;
  const width = memoryAccessWidth(opcode);
  if (width === undefined) {
    return undefined;
  }
  const baseRegister = (word >>> 21) & 0x1f;
  const base = registers[baseRegister];
  if (base === undefined) {
    return undefined;
  }
  const immediate = signExtend16(word & 0xffff);
  const effectiveAddress = ((base >>> 0) + immediate) >>> 0;
  if (width === 'partial-word') {
    const aligned = effectiveAddress & ~0x3;
    return {
      effectiveAddress,
      byteAddresses: [0, 1, 2, 3].map((delta) => (aligned + delta) >>> 0),
      alignment: 1
    };
  }
  return {
    effectiveAddress,
    byteAddresses: Array.from({ length: width }, (_, delta) => (effectiveAddress + delta) >>> 0),
    alignment: width
  };
}

function memoryAccessWidth(opcode: number): 1 | 2 | 4 | 'partial-word' | undefined {
  switch (opcode) {
    case 0x20: // lb
    case 0x24: // lbu
    case 0x28: // sb
      return 1;
    case 0x21: // lh
    case 0x25: // lhu
    case 0x29: // sh
      return 2;
    case 0x23: // lw
    case 0x2b: // sw
      return 4;
    case 0x22: // lwl
    case 0x26: // lwr
    case 0x2a: // swl
    case 0x2e: // swr
      return 'partial-word';
    default:
      return undefined;
  }
}

function touchesP7InterruptGenerator(access: MemoryAccess): boolean {
  return access.byteAddresses.some((address) =>
    address >= p7InterruptGeneratorStart && address <= p7InterruptGeneratorEnd);
}

function isExactP7InterruptAcknowledge(pc: number, word: number): boolean {
  return pc >= p7ExceptionHandlerAddress && word === exactP7InterruptAcknowledgeWord;
}

/**
 * Misaligned half/word accesses can be dispatched by stable efc before coL2 prints their victim
 * header. Use forward constant dataflow over the final hardware image so values remain provable
 * across branch/jump delay slots and joins; all other accesses remain the responsibility of the
 * path-sensitive dynamic check above.
 */
function unobservableP7InterruptGeneratorError(words: readonly number[]): string | undefined {
  const handlerIndex = (p7ExceptionHandlerAddress - p7UserTextBaseAddress) / 4;
  const states = new Map<number, Array<number | undefined>>();
  const pending: number[] = [];
  enqueueConstantState(states, pending, 0, stableMarsResetConstantRegisters(), words.length);
  enqueueConstantState(states, pending, handlerIndex, unknownRegisters(), words.length);

  while (pending.length) {
    const index = pending.shift()!;
    const constants = states.get(index)!;
    const word = words[index];
    const error = unobservableP7InterruptGeneratorInstructionError(index, word, constants);
    if (error) {
      return error;
    }

    const pc = p7UserTextBaseAddress + index * 4;
    const afterInstruction = constants.slice();
    applyConstantWrite(afterInstruction, word, pc);
    if (!hasDelaySlot(word)) {
      if (word !== 0x42000018) { // eret resumes at dynamic EPC, not the following image word.
        enqueueConstantState(states, pending, index + 1, afterInstruction, words.length);
      }
      continue;
    }

    const delayIndex = index + 1;
    let afterDelaySlot = afterInstruction;
    if (delayIndex < words.length) {
      const delayWord = words[delayIndex];
      const delayError = unobservableP7InterruptGeneratorInstructionError(
        delayIndex,
        delayWord,
        afterInstruction
      );
      if (delayError) {
        return delayError;
      }
      afterDelaySlot = afterInstruction.slice();
      applyConstantWrite(afterDelaySlot, delayWord, pc + 4);
    }
    for (const successor of delayedControlSuccessors(index, word, constants)) {
      enqueueConstantState(states, pending, successor, afterDelaySlot, words.length);
    }
  }
  return undefined;
}

function unobservableP7InterruptGeneratorInstructionError(
  index: number,
  word: number,
  constants: ReadonlyArray<number | undefined>
): string | undefined {
  const access = decodedMemoryAccess(word, constants);
  if (!access || !touchesP7InterruptGenerator(access)
    || access.alignment <= 1
    || (access.effectiveAddress & (access.alignment - 1)) === 0) {
    return undefined;
  }
  const pc = p7UserTextBaseAddress + index * 4;
  return `P7 最终 hardware image 在 PC 0x${hex(pc)} 含有可静态确定的非对齐中断发生器访问（机器码 0x${hex(word)}，有效地址 0x${hex(access.effectiveAddress)}）；稳定版 MARS v0.6.3 可能在输出该 victim 的 coL2 指令头前派发 AdEL/AdES，无法证明精确 IG 应答契约。中断发生器只能由 handler 的 0x${hex(exactP7InterruptAcknowledgeWord)}（sb $0, 0x7f20($0)）访问`;
}

function enqueueConstantState(
  states: Map<number, Array<number | undefined>>,
  pending: number[],
  index: number,
  incoming: ReadonlyArray<number | undefined>,
  wordCount: number
): void {
  if (!Number.isInteger(index) || index < 0 || index >= wordCount) {
    return;
  }
  const existing = states.get(index);
  if (!existing) {
    states.set(index, Array.from(incoming));
    pending.push(index);
    return;
  }
  let changed = false;
  for (let register = 1; register < existing.length; register++) {
    const joined = existing[register] === incoming[register] ? existing[register] : undefined;
    if (existing[register] !== joined) {
      existing[register] = joined;
      changed = true;
    }
  }
  if (changed) {
    pending.push(index);
  }
}

function delayedControlSuccessors(
  index: number,
  word: number,
  constants: ReadonlyArray<number | undefined>
): number[] {
  const opcode = word >>> 26;
  const pc = p7UserTextBaseAddress + index * 4;
  if (opcode === 0x02 || opcode === 0x03) {
    return [addressToImageIndex((((pc + 4) & 0xf0000000) | ((word & 0x03ffffff) << 2)) >>> 0)];
  }
  if ((opcode >= 0x04 && opcode <= 0x07) || opcode === 0x01) {
    const target = (pc + 4 + (signExtend16(word & 0xffff) << 2)) >>> 0;
    return [index + 2, addressToImageIndex(target)];
  }
  if (opcode === 0 && ((word & 0x3f) === 0x08 || (word & 0x3f) === 0x09)) {
    const target = constants[(word >>> 21) & 0x1f];
    return target === undefined ? [] : [addressToImageIndex(target)];
  }
  return [];
}

function addressToImageIndex(address: number): number {
  const offset = address - p7UserTextBaseAddress;
  return (address & 0x3) === 0 ? offset / 4 : Number.NaN;
}

function stableMarsResetConstantRegisters(): Array<number | undefined> {
  const registers = Array<number | undefined>(32).fill(0);
  registers[28] = stableMarsGlobalPointer;
  registers[29] = stableMarsStackPointer;
  return registers;
}

function unknownRegisters(): Array<number | undefined> {
  const registers = Array<number | undefined>(32).fill(undefined);
  registers[0] = 0;
  return registers;
}

function applyConstantWrite(registers: Array<number | undefined>, word: number, pc: number): void {
  const destination = writtenRegister(word);
  if (destination === undefined || destination === 0) {
    return;
  }
  registers[destination] = isLinkInstruction(word)
    ? (pc + 8) >>> 0
    : constantInstructionResult(word, registers);
}

function isLinkInstruction(word: number): boolean {
  const opcode = word >>> 26;
  const rt = (word >>> 16) & 0x1f;
  return opcode === 0x03
    || (opcode === 0x01 && (rt === 0x10 || rt === 0x11))
    || (opcode === 0 && (word & 0x3f) === 0x09);
}

function constantInstructionResult(
  word: number,
  registers: ReadonlyArray<number | undefined>
): number | undefined {
  const opcode = word >>> 26;
  const rs = (word >>> 21) & 0x1f;
  const rt = (word >>> 16) & 0x1f;
  const shamt = (word >>> 6) & 0x1f;
  const funct = word & 0x3f;
  const left = registers[rs];
  const right = registers[rt];
  const immediate = signExtend16(word & 0xffff);
  if (opcode === 0x0f) {
    return ((word & 0xffff) << 16) >>> 0;
  }
  if (left !== undefined) {
    switch (opcode) {
      case 0x08: // addi
      case 0x09: // addiu
        return (left + immediate) >>> 0;
      case 0x0a: // slti
        return (left | 0) < immediate ? 1 : 0;
      case 0x0b: // sltiu
        return (left >>> 0) < (immediate >>> 0) ? 1 : 0;
      case 0x0c: // andi
        return (left & (word & 0xffff)) >>> 0;
      case 0x0d: // ori
        return (left | (word & 0xffff)) >>> 0;
      case 0x0e: // xori
        return (left ^ (word & 0xffff)) >>> 0;
      default:
        break;
    }
  }
  if (opcode !== 0 || right === undefined) {
    return undefined;
  }
  switch (funct) {
    case 0x00:
      return (right << shamt) >>> 0;
    case 0x02:
      return right >>> shamt;
    case 0x03:
      return (right >> shamt) >>> 0;
    default:
      break;
  }
  if (left === undefined) {
    return undefined;
  }
  switch (funct) {
    case 0x20: // add
    case 0x21: // addu
      return (left + right) >>> 0;
    case 0x22: // sub
    case 0x23: // subu
      return (left - right) >>> 0;
    case 0x24:
      return (left & right) >>> 0;
    case 0x25:
      return (left | right) >>> 0;
    case 0x26:
      return (left ^ right) >>> 0;
    case 0x27:
      return (~(left | right)) >>> 0;
    case 0x2a:
      return (left | 0) < (right | 0) ? 1 : 0;
    case 0x2b:
      return (left >>> 0) < (right >>> 0) ? 1 : 0;
    default:
      return undefined;
  }
}

function writtenRegister(word: number): number | undefined {
  const opcode = word >>> 26;
  const rt = (word >>> 16) & 0x1f;
  const rd = (word >>> 11) & 0x1f;
  const funct = word & 0x3f;
  if (opcode === 0) {
    if (new Set([
      0x00, 0x02, 0x03, 0x04, 0x06, 0x07, 0x09, 0x0a, 0x0b,
      0x10, 0x12, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26,
      0x27, 0x2a, 0x2b
    ]).has(funct)) {
      return rd;
    }
    return undefined;
  }
  if (opcode === 0x03) {
    return 31;
  }
  if (opcode === 0x01 && (rt === 0x10 || rt === 0x11)) {
    return 31;
  }
  if ((opcode >= 0x08 && opcode <= 0x0f)
    || (opcode >= 0x20 && opcode <= 0x26)) {
    return rt;
  }
  if (opcode === 0x10 && ((word >>> 21) & 0x1f) === 0) {
    return rt; // mfc0
  }
  if (opcode === 0x1c && (funct === 0x02 || funct === 0x20 || funct === 0x21)) {
    return rd; // mul/clz/clo
  }
  return undefined;
}

function hasDelaySlot(word: number): boolean {
  const opcode = word >>> 26;
  if (opcode >= 0x02 && opcode <= 0x07) {
    return true;
  }
  if (opcode === 0x01) {
    const rt = (word >>> 16) & 0x1f;
    return rt === 0x00 || rt === 0x01 || rt === 0x10 || rt === 0x11;
  }
  return opcode === 0 && ((word & 0x3f) === 0x08 || (word & 0x3f) === 0x09);
}

function signExtend16(value: number): number {
  return (value << 16) >> 16;
}

function hex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}
