// @index mips-core — Ordinary integer extension registry and display facts shared with language tooling
import type { MarsInstructionFact } from './marsInstructionFacts';

export const maximumMarsBreakCode = 0xfffff;

export const marsIntegerExtensionMnemonics: readonly string[] = Object.freeze([
  'abs', 'subi', 'subiu', 'mulu', 'mulo', 'mulou', 'div', 'divu', 'rem', 'remu', 'rol', 'ror', 'mul', 'break', 'mfc0', 'mtc0'
]);

const summaries: Readonly<Record<string, string>> = Object.freeze({
  mulu: '无符号乘法结果低 32 位',
  mulo: '有符号乘法并检查溢出',
  mulou: '无符号乘法并检查溢出',
  rol: '循环左移',
  ror: '循环右移'
});

/** Ordinary extensions absent from the legacy editor instruction resource. */
export const marsIntegerInstructionFacts: readonly MarsInstructionFact[] = Object.freeze([...Object.entries(summaries).map(([mnemonic, summary]) => Object.freeze({
  mnemonic, summary,
  formats: Object.freeze([`${mnemonic} $rd, $rs, $rt`, `${mnemonic} $rd, $rs, ${mnemonic === 'rol' || mnemonic === 'ror' ? 'shamt' : 'imm32'}`]),
  operands: Object.freeze([3, 3]) as readonly [number, number],
  type: 'pseudo' as const, pseudo: true, writesFirstOperand: true,
  description: `${summary}；普通 MARS 整数扩展，展开使用 $at。${mnemonic.startsWith('mulo') ? '溢出时触发 break 异常。' : ''}`
})), Object.freeze({
  mnemonic: 'break', summary: 'Breakpoint exception',
  formats: Object.freeze(['break', 'break code20']), operands: Object.freeze([0, 1]) as readonly [number, number],
  type: 'special' as const, pseudo: false, writesFirstOperand: false,
  description: `触发断点异常；可选代码操作数范围为 0..${maximumMarsBreakCode}（20 位）。`
})]);
