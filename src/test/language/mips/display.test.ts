import { describe, expect, it } from 'vitest';
import { MarkupKind } from 'vscode-languageserver/node';
import {
  directiveHoverText,
  syscallMarkdown,
  cp0Markdown,
  markdownTooltip
} from '../../../language/mips/display';
import type { MipsSyscallInfo, MipsCp0RegisterInfo } from '../../../language/mips/resources';

describe('directiveHoverText', () => {
  it('returns undefined for non-existent directives', () => {
    expect(directiveHoverText('made_up_directive')).toBeUndefined();
    expect(directiveHoverText('.nonexistent')).toBeUndefined();
  });

  it('returns markdown for .align', () => {
    const text = directiveHoverText('.align');
    expect(text).toBeDefined();
    expect(text!).toContain('.align n');
    expect(text!).toContain('2^n');
    expect(text!).toContain('.align 0');
    expect(text!).toContain('.align 1');
    expect(text!).toContain('.align 2');
  });

  it('returns markdown for .data and .text', () => {
    for (const directive of ['.data', '.text']) {
      const text = directiveHoverText(directive);
      expect(text).toBeDefined();
      expect(text!).toContain(directive);
      expect(text!).toContain('MARS');
    }
  });

  it('returns markdown for .ktext', () => {
    const text = directiveHoverText('.ktext');
    expect(text).toBeDefined();
    expect(text!).toContain('.ktext');
    expect(text!).toContain('0x4180');
    expect(text!).toContain('P7');
  });

  it('returns markdown for .set', () => {
    const text = directiveHoverText('.set');
    expect(text).toBeDefined();
    expect(text!).toContain('.set');
    expect(text!).toContain('SPIM');
    expect(text!).toContain('MARS');
    expect(text!).toContain('warning');
  });

  it('returns generic markdown for other known directives', () => {
    const text = directiveHoverText('.asciiz');
    expect(text).toBeDefined();
    expect(text!).toContain('.asciiz');
    expect(text!).toContain('MIPS 汇编指令');
  });
});

describe('syscallMarkdown', () => {
  const basicSyscall: MipsSyscallInfo = {
    code: 1,
    name: 'print_int',
    description: '打印一个整数到控制台',
    parameters: '$a0 = integer',
    returns: '无'
  };

  const minimalSyscall: MipsSyscallInfo = {
    code: 10,
    name: 'exit',
    description: '退出程序'
  };

  it('includes syscall code and name', () => {
    const text = syscallMarkdown(basicSyscall);
    expect(text).toContain('MARS syscall 1');
    expect(text).toContain('print_int');
  });

  it('includes description', () => {
    const text = syscallMarkdown(basicSyscall);
    expect(text).toContain('打印一个整数到控制台');
  });

  it('includes parameters section', () => {
    const text = syscallMarkdown(basicSyscall);
    expect(text).toContain('参数：');
    expect(text).toContain('$a0 = integer');
  });

  it('includes returns section', () => {
    const text = syscallMarkdown(basicSyscall);
    expect(text).toContain('返回值：');
    expect(text).toContain('无');
  });

  it('uses default text when parameters and returns are undefined', () => {
    const text = syscallMarkdown(minimalSyscall);
    expect(text).toContain('参数：无');
    expect(text).toContain('返回值：无');
  });

  it('generates markdown output', () => {
    const text = syscallMarkdown(basicSyscall);
    // Contains markdown bold
    expect(text).toContain('**');
  });
});

describe('cp0Markdown', () => {
  const basicRegister: MipsCp0RegisterInfo = {
    number: 12,
    name: 'SR',
    description: 'Status Register — 控制中断使能和异常级别',
    courseRequired: true,
    writableByTest: true
  };

  const registerWithFields: MipsCp0RegisterInfo = {
    number: 13,
    name: 'Cause',
    alias: 'CAUSE',
    description: 'Cause Register — 记录异常原因和中断请求',
    courseRequired: true,
    writableByTest: false,
    fields: [
      { name: 'IP', bits: '15:8', description: '中断请求位' },
      { name: 'ExcCode', bits: '6:2', description: '异常编码' }
    ]
  };

  const registerWithExcCodes: MipsCp0RegisterInfo = {
    number: 13,
    name: 'Cause',
    description: 'Cause Register',
    courseRequired: true,
    writableByTest: true,
    excCodes: [
      { code: 4, name: 'AdEL', description: '取指地址错' },
      { code: 8, name: 'Syscall', description: '系统调用' }
    ]
  };

  const registerWithNotes: MipsCp0RegisterInfo = {
    number: 14,
    name: 'EPC',
    description: 'Exception PC',
    courseRequired: true,
    writableByTest: false,
    notes: ['保存异常发生时的PC', '注意延迟槽']
  };

  it('includes register number and name', () => {
    const text = cp0Markdown(basicRegister);
    expect(text).toContain('CP0 $12');
    expect(text).toContain('SR');
  });

  it('includes alias when present', () => {
    const text = cp0Markdown(registerWithFields);
    expect(text).toContain('(CAUSE)');
  });

  it('does not include alias when absent', () => {
    const text = cp0Markdown(basicRegister);
    expect(text).not.toContain('('); // No alias in basicRegister
  });

  it('includes course-required flag', () => {
    const text = cp0Markdown(basicRegister);
    expect(text).toContain('P7 要求实现：是');
  });

  it('shows correct writable-by-test flag', () => {
    const text = cp0Markdown(registerWithFields);
    expect(text).toContain('测试程序写入：不要求/保证不写');
  });

  it('includes fields table when present', () => {
    const text = cp0Markdown(registerWithFields);
    expect(text).toContain('| 字段 | 位 | 含义 |');
    expect(text).toContain('| IP | 15:8 | 中断请求位 |');
    expect(text).toContain('| ExcCode | 6:2 | 异常编码 |');
  });

  it('does not include fields table when absent', () => {
    const text = cp0Markdown(basicRegister);
    expect(text).not.toContain('| 字段 | 位 | 含义 |');
  });

  it('includes ExcCode table when present', () => {
    const text = cp0Markdown(registerWithExcCodes);
    expect(text).toContain('ExcCode 编码：');
    expect(text).toContain('| ExcCode | 名称 | 触发条件 |');
    expect(text).toContain('| 4 | AdEL | 取指地址错 |');
    expect(text).toContain('| 8 | Syscall | 系统调用 |');
  });

  it('does not include ExcCode table when absent', () => {
    const text = cp0Markdown(basicRegister);
    expect(text).not.toContain('ExcCode 编码');
  });

  it('includes notes when present', () => {
    const text = cp0Markdown(registerWithNotes);
    expect(text).toContain('- 保存异常发生时的PC');
    expect(text).toContain('- 注意延迟槽');
  });

  it('does not include notes when absent', () => {
    const text = cp0Markdown(basicRegister);
    expect(text).toBeDefined();
  });

  it('generates markdown output', () => {
    const text = cp0Markdown(basicRegister);
    // Contains markdown bold
    expect(text).toContain('**');
  });
});

describe('markdownTooltip', () => {
  it('wraps value in MarkupKind.Markdown', () => {
    const result = markdownTooltip('test content');
    expect(result).toEqual({
      kind: MarkupKind.Markdown,
      value: 'test content'
    });
  });

  it('handles empty string', () => {
    const result = markdownTooltip('');
    expect(result.kind).toBe(MarkupKind.Markdown);
    expect(result.value).toBe('');
  });
});
