export function signed32(value: number): number {
  return value | 0;
}

export function unsigned32(value: number): number {
  return value >>> 0;
}

export function signExtend8(value: number): number {
  return (value << 24) >> 24;
}

export function signExtend16(value: number): number {
  return (value << 16) >> 16;
}

export function clz32(value: number): number {
  return Math.clz32(value);
}

export function clo32(value: number): number {
  return Math.clz32(~value >>> 0);
}

export function formatImmediate(value: number): string {
  if (value < 0) {
    return String(value);
  }
  return value > 9 ? `0x${value.toString(16)}` : String(value);
}

export function formatUnsignedImmediate(value: number): string {
  return value > 9 ? `0x${(value & 0xffff).toString(16)}` : String(value);
}

export function alignDown(value: number, alignment: number): number {
  return Math.floor(value / alignment) * alignment;
}

/** nop（sll $0, $0, 0）的机器码十六进制。 */
export const MIPS_NOP_HEX = '00000000';
/** 停机自环 `beq $0, $0, -1`（分支到自身）的机器码十六进制。 */
export const MIPS_SELF_BRANCH_HEX = '1000ffff';

/** 课程测试 ASM 使用的停机自环标签。 */
export const COURSE_HALT_LABEL = '_co_test_end';

/**
 * 课程测试程序的标准终止尾巴。
 *
 * P5/P6 教程明确要求测试程序以自分支和其延迟槽 NOP 结束；同一序列对没有延迟槽的
 * P3/P4 也安全，并让所有自动生成的 CPU 测试具有一致的取指边界。P7 教程示例采用
 * 相同尾巴，且必须将它放在 0x4180 异常入口之前。
 */
export function courseAsmHaltLoop(label = COURSE_HALT_LABEL): string[] {
  return [
    `${label}:`,
    `    beq $0, $0, ${label}`,
    '    nop'
  ];
}

/**
 * 课程约定：测试程序应以"停机自环"结尾，否则流水线 CPU / hazard 对拍工具会在执行完
 * 最后一条指令后继续向指令存储器末尾之外取指，触发取指地址错（AdEL，ExcCode 4）。
 *
 * 给一段 HexText 机器码追加 `beq $0,$0,-1` + nop（延迟槽）。若已经以"自环 + nop"结尾则原样返回。
 * 仅处理机器码文本，不改动源 ASM —— 因此 MARS 黄金 trace 直接运行 ASM 时不受影响（自然在末尾停机）。
 */
export function appendHaltLoop(machineCodeText: string): string {
  const lines = machineCodeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    return machineCodeText;
  }
  if (machineCodeHasHaltLoop(lines)) {
    return `${lines.join('\n')}\n`;
  }
  return `${[...lines, MIPS_SELF_BRANCH_HEX, MIPS_NOP_HEX].join('\n')}\n`;
}

export function machineCodeHasHaltLoop(lines: readonly string[]): boolean {
  const last = lines.length - 1;
  return last >= 1
    && lines[last - 1].toLowerCase() === MIPS_SELF_BRANCH_HEX
    && lines[last].toLowerCase() === MIPS_NOP_HEX;
}

/**
 * The course CPU test contract requires the source program itself to end its user text with the
 * standard self-branch and delay-slot NOP. Appending only to code.txt would make MARS and the
 * hardware execute different programs and can even create a control transfer in a delay slot.
 */
export function courseTraceHaltLoopError(machineCodeText: string): string | undefined {
  const lines = machineCodeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (machineCodeHasHaltLoop(lines)) {
    return undefined;
  }
  return '课程 Trace 用例的用户 .text 必须以 `beq $0,$0,test_end` 和其延迟槽 `nop` 结束；插件不会只修改机器码来制造与 MARS 源程序不同的停机尾。';
}

/** Return the byte PC of the validated self-branch at the end of the user-text dump. */
export function courseTraceHaltPc(machineCodeText: string, textBase = 0x3000): number | undefined {
  const lines = machineCodeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!machineCodeHasHaltLoop(lines)) {
    return undefined;
  }
  return (textBase + (lines.length - 2) * 4) >>> 0;
}

