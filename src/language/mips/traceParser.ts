export type CpuTraceKind = 'grf' | 'dm';

export interface CpuTraceEvent {
  cycle?: number;
  pc: string;
  kind: CpuTraceKind;
  target: string;
  value: string;
  raw: string;
  lineNumber: number;
}

const tracePattern = /^(?:(\d+)@|@)(?:0x)?([0-9a-fxz]{1,8}):\s*(\$|\*)\s*(?:0x)?([0-9a-fxz]+)\s*<=\s*(?:0x)?([0-9a-fxz]{1,8})$/i;
const detailedMarsInstructionPattern = /^@PC(?:0x)?([0-9a-f]{1,8})\s*->.*\(([0-9a-f]{8})\)\s*$/i;
const partialWordStoreOpcodes = new Set([0x2a, 0x2e]);
const divideFuncts = new Set([0x1a, 0x1b]);
type HiLoEffect = 'read-hi' | 'read-lo' | 'write-hi' | 'write-lo' | 'write-both' | 'read-write-both' | 'invalidate-both';

export function parseMarsOutput(text: string): CpuTraceEvent[] {
  return parseCpuTraceOutput(text);
}

export function parseMarsDetailedOutput(text: string): CpuTraceEvent[] {
  return Array.from(iterMarsDetailedTraceEvents(text));
}

export function parseCpuTraceOutput(text: string): CpuTraceEvent[] {
  const events: CpuTraceEvent[] = [];
  for (const event of iterCpuTraceEvents(text)) {
    if (event) {
      events.push(event);
    }
  }
  return events;
}

export function* iterCpuTraceEvents(text: string): IterableIterator<CpuTraceEvent> {
  let lineStart = 0;
  let lineNumber = 1;
  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && text[index] !== '\n') {
      continue;
    }
    const lineEnd = index > lineStart && text[index - 1] === '\r' ? index - 1 : index;
    const event = parseCpuTraceLine(text.slice(lineStart, lineEnd), lineNumber);
    if (event) {
      yield event;
    }
    lineStart = index + 1;
    lineNumber++;
  }
}

/**
 * Parse modified MARS coL2 output. Each `@PC... ->` header is one dynamic instruction, so
 * repeated execution of the same PC remains separate. SWL/SWR update one aligned word byte by
 * byte inside that block; retain only the final value for each DM word to match the course TB's
 * single architectural write event. Modified MARS incorrectly omits the architectural $31 write
 * for a not-taken BGEZAL/BLTZAL, so repair that block to the unconditional MIPS PC+8 link.
 */
export function* iterMarsDetailedTraceEvents(text: string): IterableIterator<CpuTraceEvent> {
  let currentPc: string | undefined;
  let currentWord: number | undefined;
  let currentHeaderLine = 1;
  let blockEvents: Array<CpuTraceEvent | undefined> = [];
  let latestDmEvent = new Map<string, number>();
  let lineStart = 0;
  let lineNumber = 1;

  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && text[index] !== '\n') {
      continue;
    }
    const lineEnd = index > lineStart && text[index - 1] === '\r' ? index - 1 : index;
    const rawLine = text.slice(lineStart, lineEnd);
    const line = rawLine.trim();
    const header = detailedMarsInstructionPattern.exec(line);
    if (header) {
      for (const event of finalizedMarsInstructionBlock(currentPc, currentWord, currentHeaderLine, blockEvents)) {
        yield event;
      }
      currentPc = normalizeHexToken(header[1], 8);
      currentWord = Number.parseInt(header[2], 16) >>> 0;
      currentHeaderLine = lineNumber;
      blockEvents = [];
      latestDmEvent = new Map<string, number>();
    } else if (currentPc && rawLine.startsWith('\t\t')) {
      const event = parseCpuTraceLine(`@${currentPc}: ${line}`, lineNumber);
      if (event) {
        if (event.kind === 'dm') {
          const previousIndex = latestDmEvent.get(event.target);
          if (previousIndex !== undefined) {
            blockEvents[previousIndex] = undefined;
          }
          latestDmEvent.set(event.target, blockEvents.length);
        }
        blockEvents.push(event);
      }
    }
    lineStart = index + 1;
    lineNumber++;
  }

  for (const event of finalizedMarsInstructionBlock(currentPc, currentWord, currentHeaderLine, blockEvents)) {
    yield event;
  }
}

function finalizedMarsInstructionBlock(
  pc: string | undefined,
  word: number | undefined,
  headerLine: number,
  blockEvents: ReadonlyArray<CpuTraceEvent | undefined>
): CpuTraceEvent[] {
  const events = blockEvents.filter((event): event is CpuTraceEvent => event !== undefined);
  if (pc === undefined || word === undefined || !isRegimmLinkBranch(word)
    || events.some((event) => event.kind === 'grf' && event.target === '31')) {
    return events;
  }
  const value = normalizeHexToken((((Number.parseInt(pc, 16) >>> 0) + 8) >>> 0).toString(16), 8);
  const raw = `@${pc}: $31 <= ${value}`;
  events.push({
    pc,
    kind: 'grf',
    target: '31',
    value,
    raw,
    lineNumber: headerLine
  });
  return events;
}

export function machineCodeNeedsDetailedMarsTrace(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const token = line.trim().replace(/^0x/i, '');
    if (!/^[0-9a-f]{8}$/i.test(token)) {
      continue;
    }
    const opcode = (Number.parseInt(token, 16) >>> 26) & 0x3f;
    if (partialWordStoreOpcodes.has(opcode)) {
      return true;
    }
  }
  return false;
}

/** Select coL2 so not-taken REGIMM link writes can be repaired to MIPS semantics. */
export function machineCodeNeedsLinkBranchOracleRepairTrace(text: string): boolean {
  return machineCodeWords(text).some(isRegimmLinkBranch);
}

/**
 * A coL2 run is also needed when the final program could execute undefined behavior forbidden by
 * the tutorial/MIPS contract. Candidate detection is deliberately conservative; the dynamic
 * checker below rejects only a candidate that was actually executed.
 */
export function machineCodeNeedsUndefinedBehaviorTrace(text: string, delayedBranching: boolean): boolean {
  const words = machineCodeWords(text);
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const hiLoEffect = instructionHiLoEffect(word);
    if (mipsInstructionReadRegisters(word).some(isStableMarsNonzeroResetRegister)
      || isDivideInstruction(word)
      || isJalrSameInstruction(word)
      || isRegimmLinkWithLinkRegisterSource(word)
      || hiLoEffect === 'read-hi'
      || hiLoEffect === 'read-lo'
      || hiLoEffect === 'read-write-both') {
      return true;
    }
    if (delayedBranching
      && index + 1 < words.length
      && hasDelaySlot(word)
      && isControlTransfer(words[index + 1])) {
      return true;
    }
  }
  return false;
}

/**
 * Reconstruct the architectural GPR state at each modified-MARS coL2 instruction header and
 * reject only undefined behavior that occurred on the executed path. This avoids both using
 * MARS-specific results as an oracle and rejecting unreachable instruction sequences.
 */
export function marsDetailedUndefinedBehaviorError(
  text: string,
  delayedBranching: boolean
): string | undefined {
  const registers = new Uint32Array(32);
  // Course automation currently targets the released Mars v0.6.3 Compact* configurations.
  // Unlike the hardware reset, that stable oracle seeds $gp/$sp from its memory map.
  registers[28] = 0x00001800;
  registers[29] = 0x00002ffc;
  const resetCompatible = new Uint8Array(32);
  resetCompatible.fill(1);
  resetCompatible[28] = 0;
  resetCompatible[29] = 0;
  let hiInitialized = false;
  let loInitialized = false;
  let currentPc: number | undefined;
  let previous: { pc: number; word: number } | undefined;
  let currentInstructionIsRegimmLink = false;
  let currentInstructionWroteLinkRegister = false;
  let linkRegisterOracleCompatible = true;
  let lineNumber = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    lineNumber++;
    const header = detailedMarsInstructionPattern.exec(rawLine.trim());
    if (header) {
      const pc = Number.parseInt(header[1], 16) >>> 0;
      const word = Number.parseInt(header[2], 16) >>> 0;
      // Stable v0.6.3 implements REGIMM link only on the taken path. The trace iterator can
      // synthesize the missing architectural write for comparison, but it cannot change the
      // value which MARS itself supplies to later instructions. Reject a later read until an
      // actual MARS write makes $31 identical again.
      if (currentInstructionIsRegimmLink && !currentInstructionWroteLinkRegister) {
        linkRegisterOracleCompatible = false;
      }
      const readRegisters = mipsInstructionReadRegisters(word);
      if (!linkRegisterOracleCompatible && readRegisters.includes(31)) {
        return `测试程序在 0x${pc.toString(16)} 读取 $31，但此前未跳转的 BLTZAL/BGEZAL 在稳定版 MARS v0.6.3 中没有实际写入 PC+8；插件只能修复该分支自身的 Trace，无法修复 MARS 后续执行语义。请在读取前显式重写 $31，或避免依赖该未跳转链接值`;
      }
      const incompatibleResetRead = readRegisters.find((register) =>
        isStableMarsNonzeroResetRegister(register) && resetCompatible[register] === 0);
      if (incompatibleResetRead !== undefined) {
        const name = incompatibleResetRead === 28 ? '$gp/$28' : '$sp/$29';
        const marsValue = registers[incompatibleResetRead].toString(16).padStart(8, '0');
        return `测试程序在 0x${pc.toString(16)} 首次写入前读取 ${name}；课程 CPU 复位值为 0，但稳定版 MARS v0.6.3 的初值为 0x${marsValue}。请先用不读取旧值的指令显式初始化该寄存器`;
      }
      if (isRegimmLinkWithLinkRegisterSource(word)) {
        return `测试程序在 0x${pc.toString(16)} 实际执行 ${instructionName(word)} 且源寄存器为 $31；该指令同时写 $31，MIPS 将此输入定义为 UNPREDICTABLE`;
      }
      if (isDivideInstruction(word)) {
        const divisorRegister = (word >>> 16) & 0x1f;
        if (registers[divisorRegister] === 0) {
          return `测试程序在 0x${pc.toString(16)} 实际执行 ${instructionName(word)}，除数寄存器 $${divisorRegister} 为 0（教程未定义行为 DivZero）`;
        }
      }
      if (isJalrSameInstruction(word)) {
        const register = (word >>> 21) & 0x1f;
        return `测试程序在 0x${pc.toString(16)} 实际执行 jalr，目标与链接寄存器同为 $${register}（教程未定义行为 JalrSame）`;
      }
      if (delayedBranching
        && previous
        && pc === ((previous.pc + 4) >>> 0)
        && hasDelaySlot(previous.word)
        && isControlTransfer(word)) {
        return `测试程序在 0x${pc.toString(16)} 的延迟槽中实际执行控制转移指令 ${instructionName(word)}（教程未定义行为 DoubleDelay）`;
      }
      const hiLoEffect = instructionHiLoEffect(word);
      if (hiLoEffect === 'read-hi' && !hiInitialized) {
        return `测试程序在 0x${pc.toString(16)} 实际执行 mfhi，但 HI 尚未由乘除或 mthi 定义（MIPS 未定义初值）`;
      }
      if (hiLoEffect === 'read-lo' && !loInitialized) {
        return `测试程序在 0x${pc.toString(16)} 实际执行 mflo，但 LO 尚未由乘除或 mtlo 定义（MIPS 未定义初值）`;
      }
      if (hiLoEffect === 'read-write-both' && (!hiInitialized || !loInitialized)) {
        return `测试程序在 0x${pc.toString(16)} 实际执行 ${instructionName(word)}，但 HI/LO 尚未全部定义（MIPS 未定义初值）`;
      }
      switch (hiLoEffect) {
        case 'write-hi':
          hiInitialized = true;
          break;
        case 'write-lo':
          loInitialized = true;
          break;
        case 'write-both':
        case 'read-write-both':
          hiInitialized = true;
          loInitialized = true;
          break;
        case 'invalidate-both':
          // MIPS32 MUL writes only its GPR destination and makes the old HI/LO contents
          // UNPREDICTABLE; a later mfhi/mflo must not use MARS' implementation-specific value.
          hiInitialized = false;
          loInitialized = false;
          break;
        default:
          break;
      }
      currentPc = pc;
      previous = { pc, word };
      currentInstructionIsRegimmLink = isRegimmLinkBranch(word);
      currentInstructionWroteLinkRegister = false;
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
      resetCompatible[register] = 1;
      if (register === 31) {
        currentInstructionWroteLinkRegister = true;
        linkRegisterOracleCompatible = true;
      }
    }
  }
  return undefined;
}

export function parseCpuTraceLine(line: string, lineNumber = 1): CpuTraceEvent | undefined {
  const raw = line.trim();
  const match = tracePattern.exec(raw);
  if (!match) {
    return undefined;
  }

  const kind: CpuTraceKind = match[3] === '$' ? 'grf' : 'dm';
  return {
    cycle: match[1] === undefined ? undefined : Number(match[1]),
    pc: normalizeHexToken(match[2], 8),
    kind,
    target: normalizeTarget(match[4], kind),
    value: normalizeHexToken(match[5], 8),
    raw,
    lineNumber
  };
}

export function formatTraceEvent(event: CpuTraceEvent): string {
  const prefix = event.cycle === undefined ? '' : `${event.cycle}`;
  const targetPrefix = event.kind === 'grf' ? '$' : '*';
  return `${prefix}@${event.pc}: ${targetPrefix}${event.target} <= ${event.value}`;
}

function normalizeTarget(value: string, kind: CpuTraceKind): string {
  const token = stripHexPrefix(value).toUpperCase();
  if (kind === 'grf') {
    return /^\d+$/.test(token) ? String(Number(token)) : token;
  }
  return normalizeHexToken(token, 8);
}

function normalizeHexToken(value: string, width: number): string {
  const token = stripHexPrefix(value).toUpperCase();
  if (/^[0-9A-F]+$/.test(token)) {
    return token.padStart(width, '0').slice(-width);
  }
  return token;
}

function stripHexPrefix(value: string): string {
  return value.replace(/^0x/i, '');
}

function machineCodeWords(text: string): number[] {
  return text.split(/\r?\n/)
    .map((line) => line.trim().replace(/^0x/i, ''))
    .filter((line) => /^[0-9a-f]{8}$/i.test(line))
    .map((line) => Number.parseInt(line, 16) >>> 0);
}

function isDivideInstruction(word: number): boolean {
  return (word >>> 26) === 0 && divideFuncts.has(word & 0x3f);
}

function isStableMarsNonzeroResetRegister(register: number): boolean {
  return register === 28 || register === 29;
}

/** Return GPR operands whose current values are consumed by one canonical MIPS instruction. */
export function mipsInstructionReadRegisters(word: number): number[] {
  const opcode = word >>> 26;
  const rs = (word >>> 21) & 0x1f;
  const rt = (word >>> 16) & 0x1f;
  const funct = word & 0x3f;

  if (opcode === 0) {
    switch (funct) {
      case 0x00: // sll
      case 0x02: // srl
      case 0x03: // sra
        return [rt];
      case 0x08: // jr
      case 0x09: // jalr
      case 0x11: // mthi
      case 0x13: // mtlo
        return [rs];
      case 0x10: // mfhi
      case 0x12: // mflo
      case 0x0c: // syscall (used as a P7 exception trigger)
        return [];
      default:
        return [rs, rt];
    }
  }
  if (opcode === 0x01) {
    return [rs]; // REGIMM branches and immediate traps
  }
  if (opcode === 0x02 || opcode === 0x03) {
    return []; // j / jal
  }
  if (opcode >= 0x04 && opcode <= 0x07) {
    return opcode === 0x04 || opcode === 0x05 ? [rs, rt] : [rs];
  }
  if (opcode >= 0x08 && opcode <= 0x0e) {
    return [rs];
  }
  if (opcode === 0x0f) {
    return []; // lui
  }
  if (opcode === 0x10) {
    if (word === 0x42000018) {
      return []; // eret
    }
    return rs === 4 ? [rt] : []; // mtc0 consumes rt; mfc0 produces it
  }
  if (opcode === 0x1c) {
    return funct === 0x20 || funct === 0x21 ? [rs] : [rs, rt]; // clz/clo vs MDU ops
  }
  if (opcode >= 0x20 && opcode <= 0x26) {
    return opcode === 0x22 || opcode === 0x26 ? [rs, rt] : [rs]; // LWL/LWR merge old rt
  }
  if (opcode === 0x28 || opcode === 0x29 || opcode === 0x2a || opcode === 0x2b || opcode === 0x2e) {
    return [rs, rt];
  }
  return [];
}

function isJalrSameInstruction(word: number): boolean {
  return (word >>> 26) === 0
    && (word & 0x3f) === 0x09
    && ((word >>> 21) & 0x1f) === ((word >>> 11) & 0x1f);
}

function isRegimmLinkBranch(word: number): boolean {
  return (word >>> 26) === 0x01 && (((word >>> 16) & 0x1f) === 0x10 || ((word >>> 16) & 0x1f) === 0x11);
}

function isRegimmLinkWithLinkRegisterSource(word: number): boolean {
  return isRegimmLinkBranch(word) && ((word >>> 21) & 0x1f) === 31;
}

function instructionHiLoEffect(word: number): HiLoEffect | undefined {
  const opcode = word >>> 26;
  const funct = word & 0x3f;
  if (opcode === 0) {
    switch (funct) {
      case 0x10: return 'read-hi';
      case 0x11: return 'write-hi';
      case 0x12: return 'read-lo';
      case 0x13: return 'write-lo';
      case 0x18:
      case 0x19:
      case 0x1a:
      case 0x1b:
        return 'write-both';
      default:
        return undefined;
    }
  }
  if (opcode === 0x1c) {
    switch (funct) {
      case 0x00:
      case 0x01:
      case 0x04:
      case 0x05:
        return 'read-write-both';
      case 0x02:
        return 'invalidate-both';
      default:
        return undefined;
    }
  }
  return undefined;
}

function hasDelaySlot(word: number): boolean {
  const opcode = word >>> 26;
  if (opcode === 0) {
    const funct = word & 0x3f;
    return funct === 0x08 || funct === 0x09;
  }
  if (opcode === 0x01) {
    // REGIMM shares its opcode with immediate trap instructions. Only the four branch forms
    // supported by the course/plugin own a delay slot; tgei/tlti/teqi/etc. do not.
    const rt = (word >>> 16) & 0x1f;
    return rt === 0x00 || rt === 0x01 || rt === 0x10 || rt === 0x11;
  }
  return opcode === 0x02
    || opcode === 0x03
    || opcode === 0x04
    || opcode === 0x05
    || opcode === 0x06
    || opcode === 0x07;
}

function isControlTransfer(word: number): boolean {
  if (word === 0x42000018) {
    return true; // eret has no own delay slot, but executing it inside another delay slot is control transfer.
  }
  return hasDelaySlot(word);
}

function instructionName(word: number): string {
  const opcode = word >>> 26;
  if (opcode === 0) {
    switch (word & 0x3f) {
      case 0x08: return 'jr';
      case 0x09: return 'jalr';
      case 0x10: return 'mfhi';
      case 0x11: return 'mthi';
      case 0x12: return 'mflo';
      case 0x13: return 'mtlo';
      case 0x18: return 'mult';
      case 0x19: return 'multu';
      case 0x1a: return 'div';
      case 0x1b: return 'divu';
      default: return 'R-type';
    }
  }
  switch (opcode) {
    case 0x01: return 'REGIMM branch';
    case 0x02: return 'j';
    case 0x03: return 'jal';
    case 0x04: return 'beq';
    case 0x05: return 'bne';
    case 0x06: return 'blez';
    case 0x07: return 'bgtz';
    case 0x10: return word === 0x42000018 ? 'eret' : 'COP0';
    case 0x1c:
      switch (word & 0x3f) {
        case 0x00: return 'madd';
        case 0x01: return 'maddu';
        case 0x02: return 'mul';
        case 0x04: return 'msub';
        case 0x05: return 'msubu';
        default: return 'SPECIAL2';
      }
    default: return `0x${word.toString(16).padStart(8, '0')}`;
  }
}
