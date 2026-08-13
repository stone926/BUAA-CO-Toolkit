import { describe, expect, it } from 'vitest';
import { stableMarsImageCompatibilityError } from '../../courseTesting/marsImageCompatibility';

const textBase = 0x3000;
const handlerAddress = 0x4180;
const handlerIndex = (handlerAddress - textBase) / 4;

function imageWith(entries: ReadonlyArray<[number, number]>, length?: number): string {
  const requiredLength = Math.max(1, ...entries.map(([address]) => (address - textBase) / 4 + 1));
  const words = Array<number>(length ?? requiredLength).fill(0);
  for (const [address, word] of entries) {
    words[(address - textBase) / 4] = word >>> 0;
  }
  return `${words.map((word) => word.toString(16).padStart(8, '0')).join('\n')}\n`;
}

function header(pc: number, word: number, assembly = 'instruction'): string {
  return `@PC${pc.toString(16).padStart(8, '0')} -> ${assembly} (${word.toString(16).padStart(8, '0')})`;
}

describe('stable MARS final-image compatibility', () => {
  it('accepts matching P7 user, halt, zero-padding, and handler fetches', () => {
    const machineCode = imageWith([
      [0x3000, 0x34010001],
      [0x3004, 0x1000ffff],
      [0x3008, 0x00000000],
      [0x417c, 0x00000000],
      [0x4180, 0xa0007f20],
      [0x4184, 0x42000018]
    ]);
    const trace = [
      header(0x3000, 0x34010001),
      '\t\t$ 1 <= 00000001',
      header(0x3004, 0x1000ffff),
      header(0x3008, 0x00000000),
      header(0x417c, 0x00000000),
      header(0x4180, 0xa0007f20),
      header(0x4184, 0x42000018)
    ].join('\n');

    expect(stableMarsImageCompatibilityError('P7', machineCode, trace)).toBeUndefined();
  });

  it('rejects an aligned dynamic PC beyond the final loaded image', () => {
    expect(stableMarsImageCompatibilityError(
      'P6',
      '00000000\n',
      header(0x3004, 0x00000000)
    )).toContain('hardware code image');
  });

  it('rejects a sparse MARS statement that differs from P7 hardware padding', () => {
    const machineCode = imageWith([], handlerIndex + 1);
    expect(stableMarsImageCompatibilityError(
      'P7',
      machineCode,
      header(0x417c, 0x34010001, 'ori $1, $0, 1')
    )).toContain('同地址为 0x00000000');
  });

  it('rejects a dynamic header whose machine word differs from the user image', () => {
    expect(stableMarsImageCompatibilityError(
      'P3',
      '34010001\n',
      header(0x3000, 0x34010002)
    )).toContain('同地址为 0x34010001');
  });

  it('allows only the exact interrupt acknowledgement encoding in the loaded handler', () => {
    const exactHandler = imageWith([[handlerAddress, 0xa0007f20]]);
    expect(stableMarsImageCompatibilityError(
      'P7',
      exactHandler,
      header(handlerAddress, 0xa0007f20, 'sb $0, 0x7f20($0)')
    )).toBeUndefined();

    const exactUser = imageWith([[textBase, 0xa0007f20]]);
    expect(stableMarsImageCompatibilityError(
      'P7',
      exactUser,
      header(textBase, 0xa0007f20, 'sb $0, 0x7f20($0)')
    )).toContain('仅允许');
  });

  it('reconstructs prior coL2 GPR writes and rejects an equivalent but non-exact handler encoding', () => {
    const machineCode = imageWith([
      [handlerAddress, 0x341a7f20], // ori $26,$0,0x7f20
      [handlerAddress + 4, 0xa3400000] // sb $0,0($26)
    ]);
    const trace = [
      header(handlerAddress, 0x341a7f20, 'ori $26, $0, 0x7f20'),
      '\t\t$26 <= 00007f20',
      header(handlerAddress + 4, 0xa3400000, 'sb $0, 0($26)')
    ].join('\n');

    expect(stableMarsImageCompatibilityError('P7', machineCode, trace)).toContain('0xa3400000');
  });

  it('uses an actual REGIMM link write before checking a delay-slot IG access', () => {
    const bltzalTaken = 0x04300001;
    const userIgViaLink = 0xa3e04f18; // sb $0,0x4f18($31), with $31=PC+8 => 0x7f20
    const machineCode = imageWith([
      [0x3000, bltzalTaken],
      [0x3004, userIgViaLink]
    ]);
    const trace = [
      header(0x3000, bltzalTaken, 'bltzal $1, 1'),
      '\t\t$31 <= 00003008',
      header(0x3004, userIgViaLink, 'sb $0, 0x4f18($31)')
    ].join('\n');

    expect(stableMarsImageCompatibilityError('P7', machineCode, trace)).toContain('仅允许');
  });

  it('rejects other dynamically executed widths at the interrupt generator', () => {
    const machineCode = imageWith([[handlerAddress, 0xac007f20]]); // sw $0,0x7f20($0)
    expect(stableMarsImageCompatibilityError(
      'P7',
      machineCode,
      header(handlerAddress, 0xac007f20, 'sw $0, 0x7f20($0)')
    )).toContain('精确机器码 0xa0007f20');
  });

  it('statically catches a misaligned IG victim which stable efc can omit from coL2', () => {
    const direct = imageWith([[textBase, 0xac007f21]]); // sw $0,0x7f21($0)
    expect(stableMarsImageCompatibilityError('P7', direct, '')).toContain('输出该 victim');

    const computed = imageWith([
      [handlerAddress, 0x341a7f20], // ori $26,$0,0x7f20
      [handlerAddress + 4, 0xaf400001] // sw $0,1($26)
    ]);
    expect(stableMarsImageCompatibilityError('P7', computed, '')).toContain('0x00007f21');
  });

  it('preserves proven constants across branch control flow for hidden IG victims', () => {
    const afterBranch = imageWith([
      [0x3000, 0x34017f21], // ori $1,$0,0x7f21
      [0x3004, 0x10000002], // beq $0,$0,0x3010
      [0x3008, 0x00000000], // delay slot
      [0x3010, 0xac200000] // sw $0,0($1), misaligned IG victim omitted by stable coL2
    ]);

    expect(stableMarsImageCompatibilityError('P7', afterBranch, '')).toContain('0x00007f21');
  });
});
