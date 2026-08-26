// @index course-testing — P7 外部中断 target/trigger 的静态安全锚点契约
import { decodeCourseInstructionWord } from '../mips/core/isa/decoder';

/** Instructions with no control, memory, CP0, trap, or MDU side effects at an IRQ anchor. */
export const p7SafeInterruptAnchorMnemonics: ReadonlySet<string> = new Set([
  'add', 'addu', 'sub', 'subu', 'and', 'or', 'xor', 'nor', 'slt', 'sltu',
  'addi', 'addiu', 'andi', 'ori', 'xori', 'slti', 'sltiu',
  'sll', 'srl', 'sra', 'sllv', 'srlv', 'srav', 'lui'
]);

/**
 * MARS triggers at targetPc-4 while the DUT defers targetPc. Both words must be canonical simple
 * instructions so the precise point cannot hide branch-delay, memory, trap, CP0, or MDU effects.
 */
export function p7InterruptAnchorPairIssue(
  machineWords: readonly number[],
  targetPc: number,
  textBase = 0x3000
): string | undefined {
  const targetIndex = (targetPc - textBase) / 4;
  if (!Number.isSafeInteger(targetIndex) || targetIndex < 1 || targetIndex >= machineWords.length) {
    return `interrupt target 0x${hex(targetPc)} does not identify a loaded trigger/target pair`;
  }
  for (const [label, index] of [['trigger', targetIndex - 1], ['target', targetIndex]] as const) {
    const mnemonic = decodeCourseInstructionWord(machineWords[index]);
    if (!mnemonic || !p7SafeInterruptAnchorMnemonics.has(mnemonic)) {
      return `interrupt ${label} word at 0x${hex(textBase + index * 4)} is not a canonical simple IRQ anchor instruction`;
    }
  }
  return undefined;
}

function hex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}
