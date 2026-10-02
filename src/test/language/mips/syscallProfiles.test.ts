import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getMipsHover } from '../../../language/mips/hover';
import { getMipsInlayHints } from '../../../language/mips/inlayHints';
import { getMipsCompletions } from '../../../language/mips/completions';
import { marsSyscallCatalog, supportedMarsSyscalls } from '../../../mips/core/mars/syscallCatalog';

const state = () => ({ ignoredPseudoInstructionFiles: new Set<string>(), ignoredPseudoInstructionMnemonics: new Set<string>() });
describe('syscall language semantics', () => {
  it('describes the P7 CPU exception without guessing a console service from v0', () => {
    const document = TextDocument.create('test://p7.asm', 'mipsasm', 1, 'li $v0, 1\nsyscall');
    const settings = mergeCoSettings({ project: { profile: 'P7' } });
    const hover = JSON.stringify(getMipsHover(document, { line: 1, character: 2 }, settings, state()));
    expect(hover).toContain('ExcCode=8'); expect(hover).toContain('0x4180'); expect(hover).not.toContain('当前 $v0 服务');
    const hints = getMipsInlayHints(document, { start: { line: 0, character: 0 }, end: { line: 1, character: 7 } }, settings, state());
    expect(hints.map(hint => hint.label)).toEqual([' ExcCode=8 → 0x4180']);
    const input = TextDocument.create('test://p7-completion.asm', 'mipsasm', 1, 'li $v0, ');
    expect(getMipsCompletions(input, { line: 0, character: 8 }, settings, state()).some(item => item.detail?.startsWith('syscall '))).toBe(false);
  });
  it('keeps service hover and hints for P2 console programs', () => {
    const document = TextDocument.create('test://p2.asm', 'mipsasm', 1, 'li $v0, 1\nsyscall');
    const settings = mergeCoSettings({ project: { profile: 'P2' } });
    expect(JSON.stringify(getMipsHover(document, { line: 1, character: 2 }, settings, state()))).toContain('当前 $v0 服务');
    expect(getMipsInlayHints(document, { start: { line: 0, character: 0 }, end: { line: 1, character: 7 } }, settings, state())
      .some(hint => String(hint.label).includes('print integer'))).toBe(true);
  });

  it('offers every implemented service from the shared GUI/runtime catalog and excludes unavailable services', () => {
    const document = TextDocument.create('test://services.asm', 'mipsasm', 1, 'li $2, ');
    const settings = mergeCoSettings({ project: { profile: 'P2' } });
    const completions = getMipsCompletions(document, { line: 0, character: 7 }, settings, state());
    expect(completions.map(item => Number(item.label))).toEqual(supportedMarsSyscalls.map(service => service.code));
    for (const service of marsSyscallCatalog.filter(entry => !entry.supported)) {
      const source = TextDocument.create(`test://service-${service.code}.asm`, 'mipsasm', 1, `li $v0, ${service.code}\nsyscall`);
      expect(JSON.stringify(getMipsHover(source, { line: 1, character: 2 }, settings, state()))).toContain('不支持此服务');
      expect(getMipsInlayHints(source, { start: { line: 0, character: 0 }, end: { line: 1, character: 7 } }, settings, state())
        .every(hint => String(hint.label).includes('不支持'))).toBe(true);
    }
  });

  it('documents file, time and random return registers correctly', () => {
    const settings = mergeCoSettings({ project: { profile: 'P2' } });
    for (const code of [13, 14, 15, 16, 17, 30, 32, 34, 35, 36, 40, 41, 42, 43, 44]) {
      const source = TextDocument.create(`test://implemented-${code}.asm`, 'mipsasm', 1, `li $2, ${code}\nsyscall`);
      const hover = JSON.stringify(getMipsHover(source, { line: 1, character: 2 }, settings, state()));
      expect(hover).toContain(`MARS 系统调用 ${code}`);
      expect(hover).toContain('支持（普通模式）');
      if (code === 41 || code === 42) expect(hover).toContain('$a0 = random integer');
    }
  });

  it('limits course completions to executable integer capabilities', () => {
    const source = TextDocument.create('test://course-completion.asm', 'mipsasm', 1, '');
    const course = getMipsCompletions(source, { line: 0, character: 0 }, mergeCoSettings({ project: { profile: 'P7' } }), state());
    const ordinary = getMipsCompletions(source, { line: 0, character: 0 }, mergeCoSettings({ project: { profile: 'P2' } }), state());
    for (const label of ['abs', 'add.s', 'li.d', '.kdata']) {
      expect(course.some(item => item.label === label)).toBe(false);
      expect(ordinary.some(item => item.label === label)).toBe(true);
    }
    for (const profile of ['P3', 'P4', 'P5', 'P6', 'P7'] as const) {
      const registers = getMipsCompletions(TextDocument.create('test://course-register.asm', 'mipsasm', 1, 'addu $'),
        { line: 0, character: 6 }, mergeCoSettings({ project: { profile } }), state());
      expect(registers.some(item => item.label === '$f0')).toBe(false);
      expect(registers.some(item => item.label === '$s8')).toBe(true);
      const services = getMipsCompletions(TextDocument.create('test://course-service.asm', 'mipsasm', 1, 'li $v0, '),
        { line: 0, character: 8 }, mergeCoSettings({ project: { profile } }), state());
      expect(services.some(item => item.detail?.startsWith('syscall '))).toBe(false);
    }
  });
});
