import { describe, it, expect } from 'vitest';
import { verilogKeywords, systemTasks, expectedPorts } from '../../../language/verilog/model';

describe('verilogKeywords', () => {
  it('contains common Verilog keywords', () => {
    expect(verilogKeywords.has('module')).toBe(true);
    expect(verilogKeywords.has('endmodule')).toBe(true);
    expect(verilogKeywords.has('input')).toBe(true);
    expect(verilogKeywords.has('output')).toBe(true);
    expect(verilogKeywords.has('wire')).toBe(true);
    expect(verilogKeywords.has('reg')).toBe(true);
    expect(verilogKeywords.has('always')).toBe(true);
    expect(verilogKeywords.has('assign')).toBe(true);
    expect(verilogKeywords.has('begin')).toBe(true);
    expect(verilogKeywords.has('end')).toBe(true);
    expect(verilogKeywords.has('if')).toBe(true);
    expect(verilogKeywords.has('else')).toBe(true);
    expect(verilogKeywords.has('case')).toBe(true);
    expect(verilogKeywords.has('endcase')).toBe(true);
    expect(verilogKeywords.has('for')).toBe(true);
    expect(verilogKeywords.has('generate')).toBe(true);
    expect(verilogKeywords.has('endgenerate')).toBe(true);
    expect(verilogKeywords.has('parameter')).toBe(true);
    expect(verilogKeywords.has('localparam')).toBe(true);
  });

  it('contains SystemVerilog keywords used in the course', () => {
    expect(verilogKeywords.has('logic')).toBe(true);
  });

  it('does not contain common identifiers', () => {
    expect(verilogKeywords.has('data')).toBe(false);
    expect(verilogKeywords.has('clk')).toBe(false);
    expect(verilogKeywords.has('reset')).toBe(false);
    expect(verilogKeywords.has('myModule')).toBe(false);
  });

  it('is a Set (has O(1) lookup)', () => {
    expect(verilogKeywords.size).toBeGreaterThan(100);
  });
});

describe('systemTasks', () => {
  it('contains common system tasks', () => {
    expect(systemTasks.has('display')).toBe(true);
    expect(systemTasks.has('write')).toBe(true);
    expect(systemTasks.has('monitor')).toBe(true);
    expect(systemTasks.has('finish')).toBe(true);
    expect(systemTasks.has('stop')).toBe(true);
    expect(systemTasks.has('readmemh')).toBe(true);
    expect(systemTasks.has('readmemb')).toBe(true);
    expect(systemTasks.has('dumpfile')).toBe(true);
    expect(systemTasks.has('dumpvars')).toBe(true);
    expect(systemTasks.has('time')).toBe(true);
  });

  it('contains utility system functions', () => {
    expect(systemTasks.has('clog2')).toBe(true);
    expect(systemTasks.has('random')).toBe(true);
    expect(systemTasks.has('signed')).toBe(true);
    expect(systemTasks.has('unsigned')).toBe(true);
  });

  it('does not contain task names that require $ prefix', () => {
    // systemTasks stores names without the $ prefix
    expect(systemTasks.has('$display')).toBe(false);
  });
});

describe('expectedPorts', () => {
  it('has entries for P4 through P7', () => {
    expect(expectedPorts).toHaveProperty('P4');
    expect(expectedPorts).toHaveProperty('P5');
    expect(expectedPorts).toHaveProperty('P6');
    expect(expectedPorts).toHaveProperty('P7');
  });

  it('P4 expects clk and reset', () => {
    expect(expectedPorts.P4).toHaveProperty('clk');
    expect(expectedPorts.P4).toHaveProperty('reset');
  });

  it('P5 expects clk and reset', () => {
    expect(expectedPorts.P5).toHaveProperty('clk');
    expect(expectedPorts.P5).toHaveProperty('reset');
  });

  it('P6 has more ports than P5', () => {
    expect(Object.keys(expectedPorts.P6).length).toBeGreaterThan(Object.keys(expectedPorts.P5).length);
  });

  it('P7 has more ports than P6', () => {
    expect(Object.keys(expectedPorts.P7).length).toBeGreaterThan(Object.keys(expectedPorts.P6).length);
  });

  it('P7 includes interrupt-related ports', () => {
    expect(expectedPorts.P7).toHaveProperty('interrupt');
    expect(expectedPorts.P7).toHaveProperty('m_int_addr');
    expect(expectedPorts.P7).toHaveProperty('m_int_byteen');
  });

  it('P6 includes memory bus ports', () => {
    expect(expectedPorts.P6).toHaveProperty('i_inst_rdata');
    expect(expectedPorts.P6).toHaveProperty('m_data_rdata');
    expect(expectedPorts.P6).toHaveProperty('m_data_addr');
    expect(expectedPorts.P6).toHaveProperty('m_data_wdata');
    expect(expectedPorts.P6).toHaveProperty('m_data_byteen');
  });

  it('P7 includes CP0-related ports', () => {
    expect(expectedPorts.P7).toHaveProperty('macroscopic_pc');
    expect(expectedPorts.P7).toHaveProperty('w_grf_we');
    expect(expectedPorts.P7).toHaveProperty('w_grf_addr');
    expect(expectedPorts.P7).toHaveProperty('w_grf_wdata');
  });
});
