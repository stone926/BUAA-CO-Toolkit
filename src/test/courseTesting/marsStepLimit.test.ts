import { describe, expect, it } from 'vitest';
import { courseTraceMarsHaltError, generatedCourseTraceMarsStepLimit } from '../../courseTesting/marsStepLimit';

describe('generated course-trace MARS step limit', () => {
  it('derives a bounded native MARS limit from built-in random ASM metadata', () => {
    const asm = [
      '# Built-in BUAA CO random ASM test',
      '# profile: P6',
      '# instruction_count: 4000',
      '.text'
    ].join('\n');

    for (const profile of ['P3', 'P4', 'P5', 'P6'] as const) {
      expect(generatedCourseTraceMarsStepLimit(profile, asm, true, '1000ffff\n00000000\n')).toBe(8064);
    }
    expect(generatedCourseTraceMarsStepLimit('P7', asm, true, '1000ffff\n00000000\n')).toBe(64256);
  });

  it('uses a conservative final-machine-code limit for selected/external ASM', () => {
    const shortDump = '24010001\n1000ffff\n00000000\n';
    const fullDump = `${'00000000\n'.repeat(4094)}1000ffff\n00000000\n`;
    expect(generatedCourseTraceMarsStepLimit('P6', '# instruction_count: 4000\n.text', true, shortDump)).toBe(65_536);
    expect(generatedCourseTraceMarsStepLimit('P6', '# Built-in BUAA CO random ASM test\n.text', true, fullDump)).toBe(262_144);
  });

  it('keeps short generated programs alive long enough to reach their halt loop', () => {
    const asm = '# Built-in BUAA CO random ASM test\n# instruction_count: 1\n';

    expect(generatedCourseTraceMarsStepLimit('P3', asm, true, '')).toBe(256);
    expect(generatedCourseTraceMarsStepLimit('P7', asm, true, '')).toBe(512);
  });

  it('does not trust spoofed built-in metadata without manifest provenance', () => {
    const spoofed = '# Built-in BUAA CO random ASM test\n# instruction_count: 1\n';

    expect(generatedCourseTraceMarsStepLimit('P6', spoofed, false, '1000ffff\n00000000\n')).toBe(65_536);
  });

  it('accepts stable coL2 proof of the validated halt branch and the newer marker', () => {
    expect(courseTraceMarsHaltError([
      '@PC0000303c -> ori $1, $0, 1 (34010001)',
      '@PC00003040 -> beq $0, $0, -1 (1000ffff)',
      'Program terminated when maximum step limit 256 reached.'
    ].join('\n'), 0x3040)).toBeUndefined();
    expect(courseTraceMarsHaltError(
      '@PC0x00003040 -> beq $0, $0, -1 (1000FFFF)\n',
      0x3040
    )).toBeUndefined();
    expect(courseTraceMarsHaltError('Program reached course halt loop at 0x00003040.\n', 0x3040)).toBeUndefined();
    expect(courseTraceMarsHaltError('Program reached course halt loop at 0x00003044.\n', 0x3040)).toContain('不一致');
    expect(courseTraceMarsHaltError('@PC00003040 -> nop (00000000)\n', 0x3040)).toContain('1000ffff');
    expect(courseTraceMarsHaltError('@PC00003044 -> beq $0, $0, -1 (1000ffff)\n', 0x3040)).toContain('1000ffff');
    expect(courseTraceMarsHaltError('Program terminated when maximum step limit 256 reached.\n', 0x3040)).toContain('执行预算');
    expect(courseTraceMarsHaltError('@00003000: $ 1 <= 1\n', 0x3040)).toContain('跳出已装载文本');
  });
});
