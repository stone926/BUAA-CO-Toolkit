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
  // IEEE 1364-2005 clauses 17 and 18: completion/highlighting coverage must
  // include every radix variant, not only the most common $display/$write.
  it.each(['display', 'write', 'strobe', 'monitor', 'fdisplay', 'fwrite', 'fstrobe', 'fmonitor', 'swrite'])(
    'contains every radix variant of $%s', (name) => {
      for (const radix of ['', 'b', 'h', 'o']) {
        expect(systemTasks.has(`${name}${radix}`), `$${name}${radix}`).toBe(true);
      }
    },
  );

  it.each([
    ['file I/O', [
      'fopen', 'fclose', 'fgetc', 'ungetc', 'fgets', 'fscanf', 'sscanf', 'fread',
      'rewind', 'fseek', 'ftell', 'fflush', 'ferror', 'feof', 'sformat',
      'readmemb', 'readmemh', 'sdf_annotate',
    ]],
    ['simulation control and time', [
      'monitoroff', 'monitoron', 'finish', 'stop', 'printtimescale', 'timeformat',
      'time', 'stime', 'realtime',
    ]],
    ['conversion and math', [
      'bitstoreal', 'realtobits', 'itor', 'rtoi', 'signed', 'unsigned',
      'clog2', 'ln', 'log10', 'exp', 'sqrt', 'pow', 'floor', 'ceil',
      'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'hypot',
      'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
    ]],
    ['random distributions, queues, and plusargs', [
      'random', 'dist_uniform', 'dist_normal', 'dist_exponential', 'dist_poisson',
      'dist_chi_square', 'dist_t', 'dist_erlang',
      'q_initialize', 'q_add', 'q_remove', 'q_full', 'q_exam',
      'test$plusargs', 'value$plusargs',
    ]],
    ['value change dumps', [
      'dumpfile', 'dumpvars', 'dumpoff', 'dumpon', 'dumpall', 'dumplimit', 'dumpflush',
      'dumpports', 'dumpportsoff', 'dumpportson', 'dumpportsall', 'dumpportslimit', 'dumpportsflush',
    ]],
    ['timing checks', [
      'setup', 'hold', 'setuphold', 'recovery', 'removal', 'recrem',
      'skew', 'timeskew', 'fullskew', 'period', 'width', 'nochange',
    ]],
    ['legacy simulator calls and vendor extensions', [
      'countdrivers', 'getpattern', 'input', 'key', 'nokey', 'list', 'log', 'nolog',
      'reset', 'reset_count', 'reset_value', 'save', 'restart', 'incsave', 'scale',
      'scope', 'showscopes', 'showvars', 'sreadmemb', 'sreadmemh',
      'fsdbDumpfile', 'fsdbDumpvars', 'fsdbDumpoff', 'fsdbDumpon',
    ]],
  ])('contains %s names', (_category, names) => {
    for (const name of names) {
      expect(systemTasks.has(name), `$${name}`).toBe(true);
    }
  });

  it('contains all synchronous and asynchronous PLA modeling tasks', () => {
    for (const mode of ['sync', 'async']) {
      for (const operation of ['and', 'nand', 'or', 'nor']) {
        for (const format of ['array', 'plane']) {
          const name = `${mode}$${operation}$${format}`;
          expect(systemTasks.has(name), `$${name}`).toBe(true);
        }
      }
    }
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
