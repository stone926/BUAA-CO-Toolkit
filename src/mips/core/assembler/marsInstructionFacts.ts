// @index mips-core — Shared ordinary COP1 instruction facts for assembler and language tooling

export const marsFpArithmetic: Readonly<Record<string, number>> = Object.freeze({ add: 0, sub: 1, mul: 2, div: 3 });
export const marsFpUnary: Readonly<Record<string, number>> = Object.freeze({ sqrt: 4, abs: 5, mov: 6, neg: 7 });
export const marsFpRounding: Readonly<Record<string, number>> = Object.freeze({ round: 12, trunc: 13, ceil: 14, floor: 15 });
export const marsFpComparison: Readonly<Record<string, number>> = Object.freeze({ eq: 50, lt: 60, le: 62 });
export const marsFpMemoryOpcodes: Readonly<Record<string, number>> = Object.freeze({ lwc1: 49, ldc1: 53, swc1: 57, sdc1: 61 });
export const marsFpAliases: Readonly<Record<string, string>> = Object.freeze({ 'l.s': 'lwc1', 'l.d': 'ldc1', 's.s': 'swc1', 's.d': 'sdc1' });

export interface MarsInstructionFact {
  readonly mnemonic: string;
  readonly formats: readonly string[];
  readonly operands: readonly [number, number];
  readonly type: 'R-type' | 'I-type' | 'special' | 'pseudo';
  readonly summary: string;
  readonly description: string;
  readonly pseudo: boolean;
  readonly writesFirstOperand: boolean;
  readonly memoryAlignment?: number;
  readonly labelOperand?: 'last';
  readonly delaySlot?: boolean;
}

function buildFacts(): readonly MarsInstructionFact[] {
  const facts: MarsInstructionFact[] = [];
  const add = (mnemonic: string, patterns: readonly string[], options: Partial<MarsInstructionFact> = {}): void => {
    const lengths = patterns.map(pattern => pattern.split(',').length);
    facts.push(Object.freeze({
      mnemonic, formats: Object.freeze(patterns.map(pattern => `${mnemonic} ${pattern}`)),
      operands: Object.freeze([Math.min(...lengths), Math.max(...lengths)]) as readonly [number, number],
      type: 'R-type', summary: 'MARS 浮点指令', description: '普通 MARS COP1 指令；不属于 P3–P7 课程 CPU 指令集。',
      pseudo: false, writesFirstOperand: true, ...options
    }));
  };
  for (const format of ['s', 'd']) {
    const fd = format === 'd' ? '$fd64' : '$fd';
    const fs = format === 'd' ? '$fs64' : '$fs';
    const ft = format === 'd' ? '$ft64' : '$ft';
    for (const operation of Object.keys(marsFpArithmetic)) add(`${operation}.${format}`, [`${fd}, ${fs}, ${ft}`]);
    for (const operation of Object.keys(marsFpUnary)) add(`${operation}.${format}`, [`${fd}, ${fs}`]);
    for (const operation of Object.keys(marsFpRounding)) add(`${operation}.w.${format}`, [`$fd, ${fs}`]);
    for (const operation of Object.keys(marsFpComparison)) add(`c.${operation}.${format}`, [`${fs}, ${ft}`, `cc, ${fs}, ${ft}`], { writesFirstOperand: false });
    for (const operation of ['movf', 'movt']) add(`${operation}.${format}`, [`${fd}, ${fs}`, `${fd}, ${fs}, cc`]);
    for (const operation of ['movn', 'movz']) add(`${operation}.${format}`, [`${fd}, ${fs}, $rt`]);
    add(`li.${format}`, [`${fd}, float`], { type: 'pseudo', pseudo: true, summary: '加载浮点常量（内置扩展）', description: '内置普通引擎便捷形式，使用 $at 和 mtc1 写入 IEEE 754 位模式。' });
  }
  for (const destination of ['s', 'd', 'w']) {
    for (const source of ['s', 'd', 'w']) {
      if (destination !== source) add(`cvt.${destination}.${source}`, [`${destination === 'd' ? '$fd64' : '$fd'}, ${source === 'd' ? '$fs64' : '$fs'}`]);
    }
  }
  for (const mnemonic of ['mfc1', 'mtc1']) add(mnemonic, ['$rt, $fs'], { type: 'special', writesFirstOperand: mnemonic === 'mfc1' });
  for (const mnemonic of ['bc1f', 'bc1t']) add(mnemonic, ['label', 'cc, label'], { type: 'I-type', labelOperand: 'last', delaySlot: true, writesFirstOperand: false });
  for (const mnemonic of [...Object.keys(marsFpMemoryOpcodes), ...Object.keys(marsFpAliases)]) {
    const real = marsFpAliases[mnemonic] ?? mnemonic;
    const double = real === 'ldc1' || real === 'sdc1';
    add(mnemonic, [`${double ? '$ft64' : '$ft'}, address`], {
      type: marsFpAliases[mnemonic] ? 'pseudo' : 'I-type', pseudo: Boolean(marsFpAliases[mnemonic]),
      memoryAlignment: double ? 8 : 4, writesFirstOperand: real.startsWith('l')
    });
  }
  return Object.freeze(facts);
}

export const marsInstructionFacts = buildFacts();
export const marsInstructionByMnemonic: ReadonlyMap<string, MarsInstructionFact> = new Map(marsInstructionFacts.map(fact => [fact.mnemonic, fact]));
