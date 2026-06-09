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
  const last = lines.length - 1;
  const alreadyHalted = last >= 1
    && lines[last - 1].toLowerCase() === MIPS_SELF_BRANCH_HEX
    && lines[last].toLowerCase() === MIPS_NOP_HEX;
  if (alreadyHalted) {
    return `${lines.join('\n')}\n`;
  }
  return `${[...lines, MIPS_SELF_BRANCH_HEX, MIPS_NOP_HEX].join('\n')}\n`;
}

