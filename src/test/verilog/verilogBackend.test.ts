import { describe, expect, it } from 'vitest';
import { selectVerilogBackend } from '../../verilog/verilogBackend';

describe('Verilog backend selector', () => {
  it('selects bundled Icarus only when the resource-scoped ISE path is blank', () => {
    expect(selectVerilogBackend(undefined)).toBe('iverilog');
    expect(selectVerilogBackend(null)).toBe('iverilog');
    expect(selectVerilogBackend('')).toBe('iverilog');
    expect(selectVerilogBackend('  \r\n ')).toBe('iverilog');
  });

  it('treats every non-empty ISE path as an explicit ISim opt-in', () => {
    expect(selectVerilogBackend('D:/ISE/14.7/ISE_DS/ISE')).toBe('isim');
    expect(selectVerilogBackend('  D:/ISE  ')).toBe('isim');
  });
});
