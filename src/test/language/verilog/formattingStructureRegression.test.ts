import { describe, expect, it } from 'vitest';
import { expectStableFormatting, formattingDocument, formattingSettings } from '../../helpers/verilogFormatting';
import { readSource } from '../../../language/verilog/formatting/source';
import { analyzeStructure } from '../../../language/verilog/formatting/structure';

describe('Verilog formatting structure regressions', () => {
  it('A1 bounds recovery at repeated unfinished module headers', () => {
    const source = readSource(formattingDocument('module m(\n'.repeat(6000)));
    // 直接计数 token 访问，避免依赖共享机器的墙钟性能。
    let reads = 0;
    source.tokens = new Proxy(source.tokens, { get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    } });
    analyzeStructure(source, formattingSettings.verilog.format);
    expect(reads).toBeLessThan(source.tokens.length * 100);
    expectStableFormatting('module m(\n'.repeat(12));
  });
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'])('A2 handles prototype identifier %s', name => {
    expect(expectStableFormatting(`module m;\nwire ${name};\nwire x;\nendmodule`)).toBe(`module m;\n  wire ${name};\n  wire x;\nendmodule`);
  });
  it('A3 tracks blocks inside a verbatim disabled region', () => {
    const region = '// co-format: off\nif(a) begin\n// co-format: on';
    const output = expectStableFormatting(`module m;\ninitial begin\n${region}\nx=1;\nend\ny=2;\nend\nendmodule`);
    expect(output).toContain(region);
    expect(output).toContain('\n      x = 1;\n    end\n    y = 2;\n  end\nendmodule');
  });
  it('A4 treats preprocessor alternatives as one unbraced body', () => {
    const output = expectStableFormatting('module m;\ninitial begin\nif(a)\n`ifdef X\nx=1;\n`else\nx=2;\n`endif\ny=3;\nend\nendmodule');
    expect(output).toContain('`ifdef X\n      x = 1;\n`else\n      x = 2;\n`endif\n    y = 3;');
  });
  it('A5 recognizes the first instance in a named block', () => {
    const output = expectStableFormatting('module m;\ngenerate\nif(P) begin : g\nsub u(\n.a(a)\n);\nend\nendgenerate\nendmodule');
    expect(output).toContain('      sub u (\n          .a(a)\n        );');
  });
  it('A3 tracks closing blocks and loop headers while excluding macro bodies', () => {
    const region = '// co-format: off\nend\nfor(i=0;i<2;i=i+1) begin\n`define HIDDEN end endmodule begin\n// co-format: on';
    const output = expectStableFormatting(`module m;\ninitial begin\nif(a) begin\n${region}\nx=1;\nend\ny=2;\nend\nendmodule`);
    expect(output).toContain(region);
    expect(output).toContain('\n      x = 1;\n    end\n    y = 2;\n  end\nendmodule');
  });
  it('A3 tracks module boundaries in a disabled region', () => {
    const region = '  // co-format: off\nendmodule\nmodule n;\n  // co-format: on';
    const output = expectStableFormatting(`module m;\n${region}\nwire x;\nendmodule`);
    expect(output).toContain(region);
    expect(output).toContain('\n  wire x;\nendmodule');
  });
  it('A4 handles nested conditionals and controlled statements independently', () => {
    const output = expectStableFormatting('module m;\ninitial begin\nif(a)\n`ifdef X\n`ifdef Y\nif(b)\nx=1;\n`else\nx=2;\n`endif\n`else\nx=3;\n`endif\ny=4;\nend\nendmodule');
    expect(output).toContain('`ifdef Y\n      if (b)\n        x = 1;\n`else\n      x = 2;');
    expect(output).toContain('`else\n      x = 3;\n`endif\n    y = 4;');
  });
  it('A4 preserves the ambiguous tail of an implicit empty branch', () => {
    const output = expectStableFormatting('module m;\ninitial begin\nif(a)\n`ifdef X\nx=1;\n`endif\n y=3;\nend\nendmodule');
    expect(output).toContain('`ifdef X\n      x = 1;\n`endif\n y=3;\nend\nendmodule');
  });
  it('A5 recognizes instances after ordinary block names', () => {
    const output = expectStableFormatting('module m;\nbegin : g\nsub u(\n.a(a)\n);\nend : g\nsub v(\n.a(a)\n);\nendmodule');
    expect(output).toContain('    sub u (\n        .a(a)\n      );');
    expect(output).toContain('  sub v (\n      .a(a)\n    );');
  });
  it.each(['parameter', 'localparam'])('A6 keeps %s declaration-name alignment', keyword => {
    const output = expectStableFormatting(`module m;\n${keyword} A=1,\nB=2;\nendmodule`);
    expect(output).toContain(`\n${' '.repeat(2 + keyword.length + 1)}B`);
  });
  it('A6 distinguishes expression continuation from parameter names', () => {
    const output = expectStableFormatting('module m;\nparameter WIDTH =\n8;\nendmodule');
    expect(output).toBe('module m;\n  parameter WIDTH =\n      8;\nendmodule');
  });
});
