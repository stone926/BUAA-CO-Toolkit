import { describe, expect, it } from 'vitest';
import { selectVerilogBackend } from '../../verilog/verilogBackend';

describe('Verilog backend selector', () => {
  it('defaults generic Verilog operations to bundled Icarus', () => {
    expect(selectVerilogBackend(undefined)).toBe('iverilog');
    expect(selectVerilogBackend(null)).toBe('iverilog');
    expect(selectVerilogBackend('iverilog')).toBe('iverilog');
  });

  it('selects ISim only for an explicit backend request', () => {
    expect(selectVerilogBackend('isim')).toBe('isim');
    expect(selectVerilogBackend('D:/ISE/14.7/ISE_DS/ISE' as never)).toBe('iverilog');
  });
});
