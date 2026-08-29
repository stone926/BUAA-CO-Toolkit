import { describe, expect, it } from 'vitest';
import {
  courseHardwareMachineCodeCapacityPolicy,
  courseMachineCodeCapacityError,
  courseMachineCodeValidationError,
  decodeCourseMachineInstruction,
  stableMarsCourseInstructionMemoryWords,
  stableMarsMachineCodeCapacityPolicy,
  validateCourseMachineCode
} from '../../courseTesting/machineCodeValidation';

describe('course machine-code validation', () => {
  it.each(['P3', 'P4', 'P5', 'P6', 'P7'] as const)(
    'separates the %s hardware capacity from the stable MARS boundary',
    (profile) => {
      expect(courseMachineCodeCapacityError(profile, stableMarsCourseInstructionMemoryWords)).toBeUndefined();
      expect(courseMachineCodeCapacityError(
        profile, 4096, courseHardwareMachineCodeCapacityPolicy
      )).toBeUndefined();
      expect(courseMachineCodeCapacityError(
        profile, 4096, stableMarsMachineCodeCapacityPolicy
      )).toContain('稳定版 MARS v0.6.3');
      expect(courseMachineCodeCapacityError(
        profile, 4096, stableMarsMachineCodeCapacityPolicy
      )).toContain('4095 words');
    }
  );

  it.each(['P3', 'P4', 'P5', 'P6', 'P7'] as const)(
    'rejects a %s image one word beyond the tutorial instruction memory',
    (profile) => {
      expect(courseMachineCodeCapacityError(profile, 4097)).toBe(
        `${profile} 最终机器码共有 4097 words，超过教程 IM 4096 words 容量（0x3000..0x6ffc），课程硬件无法装载。`
      );
    }
  );

  it('applies the capacity guard through the final course machine-code preflight', () => {
    const withinCapacity = `${'00000000\n'.repeat(4094)}1000ffff\n`;
    const beyondStableMars = `${withinCapacity}00000000\n`;
    const beyondCapacity = `${beyondStableMars}00000000\n`;

    expect(courseMachineCodeValidationError('P4', withinCapacity)).toBeUndefined();
    expect(courseMachineCodeValidationError('P4', beyondStableMars)).toBeUndefined();
    expect(courseMachineCodeValidationError(
      'P4', beyondStableMars, '', false, stableMarsMachineCodeCapacityPolicy
    )).toContain('稳定版 MARS v0.6.3');
    expect(courseMachineCodeValidationError('P4', beyondCapacity)).toContain('最终机器码共有 4097 words');
  });

  it('does not impose the CPU instruction-memory limit on pre-CPU profiles', () => {
    expect(courseMachineCodeCapacityError('P2', 4097)).toBeUndefined();
  });

  it('decodes course and extended real instruction encodings', () => {
    expect(decodeCourseMachineInstruction(0x00000000)).toBe('nop');
    expect(decodeCourseMachineInstruction(0x00430820)).toBe('add');
    expect(decodeCourseMachineInstruction(0x24010001)).toBe('addiu');
    expect(decodeCourseMachineInstruction(0x40016000)).toBe('mfc0');
    expect(decodeCourseMachineInstruction(0x40816000)).toBe('mtc0');
    expect(decodeCourseMachineInstruction(0x42000018)).toBe('eret');
  });

  it('rejects non-canonical encodings whose reserved fields are non-zero', () => {
    expect(decodeCourseMachineInstruction(0x00200020)).toBe('add'); // non-zero rs is an operand, not a reserved field
    expect(decodeCourseMachineInstruction(0x00430860)).toBeUndefined(); // add with shamt=1
    expect(decodeCourseMachineInstruction(0x03e10008)).toBeUndefined(); // jr with rt=1
    expect(decodeCourseMachineInstruction(0x03e00808)).toBeUndefined(); // jr with rd=1
    expect(decodeCourseMachineInstruction(0x03e00048)).toBeUndefined(); // jr with shamt=1
    expect(decodeCourseMachineInstruction(0x00400810)).toBeUndefined(); // mfhi with rs=2
    expect(decodeCourseMachineInstruction(0x00010810)).toBeUndefined(); // mfhi with rt=1
    expect(decodeCourseMachineInstruction(0x00000850)).toBeUndefined(); // mfhi with shamt=1
    expect(decodeCourseMachineInstruction(0x00400818)).toBeUndefined(); // mult with rd=1
    expect(decodeCourseMachineInstruction(0x00430058)).toBeUndefined(); // mult with shamt=1
    expect(decodeCourseMachineInstruction(0x00210011)).toBeUndefined(); // mthi with rt=1
    expect(decodeCourseMachineInstruction(0x00200811)).toBeUndefined(); // mthi with rd=1
    expect(decodeCourseMachineInstruction(0x00200051)).toBeUndefined(); // mthi with shamt=1
    expect(decodeCourseMachineInstruction(0x1c010001)).toBeUndefined(); // bgtz with rt=1
    expect(decodeCourseMachineInstruction(0x3c410001)).toBeUndefined(); // lui with rs=2
    expect(decodeCourseMachineInstruction(0x40016001)).toBeUndefined(); // mfc0 with non-zero select
    expect(decodeCourseMachineInstruction(0x70430800)).toBeUndefined(); // madd with rd=1
    expect(decodeCourseMachineInstruction(0x70411820)).toBeUndefined(); // clz with rt=1
  });

  it('keeps architecturally defined syscall and trap code fields legal', () => {
    expect(decodeCourseMachineInstruction(0x03ffffcc)).toBe('syscall');
    expect(decodeCourseMachineInstruction(0x0043fff4)).toBe('teq');
  });

  it('restricts P7 CP0 accesses to the registers and directions guaranteed by the tutorial', () => {
    expect(decodeCourseMachineInstruction(0x40016000)).toBe('mfc0'); // SR
    expect(decodeCourseMachineInstruction(0x40016800)).toBe('mfc0'); // Cause
    expect(decodeCourseMachineInstruction(0x40017000)).toBe('mfc0'); // EPC
    expect(decodeCourseMachineInstruction(0x40816000)).toBe('mtc0'); // SR
    expect(decodeCourseMachineInstruction(0x40817000)).toBe('mtc0'); // EPC
    expect(decodeCourseMachineInstruction(0x40010800)).toBeUndefined(); // unrequired CP0 register 1
    expect(decodeCourseMachineInstruction(0x40816800)).toBeUndefined(); // tutorial forbids writing Cause
  });

  it('accepts final machine instructions in the selected tutorial profile', () => {
    expect(validateCourseMachineCode('P3', [
      '00430820', // add
      '34010001', // ori
      '8c010000', // lw
      '00000000' // nop
    ].join('\n'))).toEqual([]);
  });

  it('rejects a pseudo-instruction expansion that introduces an unsupported opcode', () => {
    const error = courseMachineCodeValidationError('P3', '24010001\n');

    expect(error).toContain('0x3000=24010001(addiu)');
  });

  it('honors an explicit built-in extended instruction set declaration', () => {
    const asm = '# Built-in BUAA CO random ASM test\n# instruction_set: addu nop\n.text\n';

    expect(validateCourseMachineCode('P3', '00430821\n', asm, true)).toEqual([]);
  });

  it('does not trust an instruction-set comment without the built-in generator marker', () => {
    const asm = '# instruction_set: addu nop\n.text\n';

    expect(validateCourseMachineCode('P3', '00430821\n', asm)).toEqual([
      expect.objectContaining({ mnemonic: 'addu', address: 0x3000 })
    ]);
  });

  it('does not trust a spoofed built-in marker without manifest provenance', () => {
    const asm = '# Built-in BUAA CO random ASM test\n# instruction_set: addu nop\n.text\n';

    expect(validateCourseMachineCode('P3', '00430821\n', asm, false)).toHaveLength(1);
  });

  it('allows only the plugin-owned P7 RI marker encoding when it is declared', () => {
    expect(validateCourseMachineCode('P7', '0000003f\n', '_co_internal_unknown_instruction\n', true)).toEqual([]);
    expect(validateCourseMachineCode('P7', '0000003f\n')).toHaveLength(1);
    expect(validateCourseMachineCode('P7', '0000003e\n', '_co_internal_unknown_instruction\n')).toHaveLength(1);
  });

  it('rejects eret in P7 user text but accepts it at the tutorial exception entry', () => {
    expect(courseMachineCodeValidationError('P7', '42000018\n')).toContain('eret 只会出现在 0x4180 起的异常处理程序');
    const handlerIndex = (0x4180 - 0x3000) / 4;
    const image = `${'00000000\n'.repeat(handlerIndex)}42000018\n`;

    expect(validateCourseMachineCode('P7', image)).toEqual([]);
  });
});
