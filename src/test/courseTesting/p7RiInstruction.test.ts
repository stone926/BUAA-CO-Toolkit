import { describe, expect, it } from 'vitest';

import {
  p7InternalUnknownInstructionMnemonic,
  sourceUnitsUseP7RiInstruction
} from '../../courseTesting/p7RiInstruction';

const unit = (text: string) => ({ id: 'root', text });

describe('P7 RI source detection', () => {
  it('recognizes the actual generator mnemonic, including a labelled instruction', () => {
    expect(sourceUnitsUseP7RiInstruction('P7', [unit(
      `\uFEFF.text\r\nri_victim: ${p7InternalUnknownInstructionMnemonic} # raise RI\r\n`
    )])).toBe(true);
  });

  it('ignores comments, strings, operands, and same-named labels', () => {
    expect(sourceUnitsUseP7RiInstruction('P7', [unit([
      `# ${p7InternalUnknownInstructionMnemonic}`,
      `.asciiz "${p7InternalUnknownInstructionMnemonic}"`,
      `label: ori $t0, $0, ${p7InternalUnknownInstructionMnemonic}`,
      `${p7InternalUnknownInstructionMnemonic}:`
    ].join('\n'))])).toBe(false);
  });

  it('never enables the P7-only custom instruction class for another profile', () => {
    expect(sourceUnitsUseP7RiInstruction('P6', [unit(p7InternalUnknownInstructionMnemonic)]))
      .toBe(false);
  });
});
