// @index waveform-radix — 波形数值显示进制枚举与中文标签（状态契约与格式化共用）

export const radixes = ['hex', 'bin', 'udec', 'sdec', 'ascii', 'instr'] as const;
export type Radix = typeof radixes[number];

export const radixLabels: Readonly<Record<Radix, string>> = {
  hex: '十六进制',
  bin: '二进制',
  udec: '无符号十进制',
  sdec: '有符号十进制',
  ascii: 'ASCII 字符串',
  instr: 'MIPS 指令'
};

export function isRadix(value: unknown): value is Radix {
  return typeof value === 'string' && (radixes as readonly string[]).includes(value);
}
