import { describe, expect, it } from 'vitest';
import { expectStableFormatting, formatVerilog, tokenBodies } from '../../helpers/verilogFormatting';

const corpus = [
  ['numbers', "module m;\nreal x;\ninitial x=1e-3+2.5E+7;\nwire [7:0] y=8 'h ff;\nendmodule"],
  ['escaped identifiers', 'module m;\nwire \\a+b ;\nassign \\a+b =1;\nendmodule'],
  ['operators and attributes', '(* keep = "true" *) module m;\nassign y=(a===b)||(a!==c)||(^~a);\nassign z=a**2+(b>>>2)+c[2+:3];\nendmodule'],
  ['comments and strings', 'module m;\n//abc\n////decor////\n/* first\n  中文 <= ? end\n last */\ninitial $display("quote \\" a<=b // 中文"); //tail\nendmodule'],
  ['same line blocks', 'module m;\ninitial begin begin a=1; end end\nwire x;\nendmodule'],
  ['unbraced controls', 'module m;\ninitial\nif(a)\nif(b)\nx=1;\nelse\nx=2;\nelse\nfor(i=0;i<3;i=i+1)\n#1 x=x+1;\nendmodule'],
  ['case and generate', 'module m;\ngenerate\nif(1) begin:g\nalways @(*)\ncasez(a)\n2\'b0?: y=b?c:d;\ndefault: begin y=0; end\nendcase\nend\nendgenerate\nendmodule'],
  ['parameterized multiple instances', 'module m #(parameter A=1, B=2)(input a,output y);\nsub #(.N(A)) u0(\n.a(a),\n.y()\n),u1(a,y);\nendmodule'],
  ['nested conditionals', '`ifdef A\n`ifdef B\nmodule m;\n`else\nmodule m;\n`endif\n`else\nmodule m;\n`endif\nwire a;\nendmodule'],
  ['macro calls', '`define PLUS(a,b) ((a)+(b))\nmodule m;\nassign x=`PLUS(a,b);\nendmodule'],
  ['empty', ''], ['half module', 'module m(\ninput ['],
  ['unfinished comment', 'module m;\n/* keep\n raw  '],
  ['unfinished string', 'module m;\ninitial $display("keep <='],
  ['unfinished escaped identifier', 'module m;\nwire \\unfinished'],
  ['bounded deep structure', `module m;\ninitial ${'begin\n'.repeat(64)}x=1;\n${'end\n'.repeat(64)}endmodule`]
];

describe('Verilog formatting source fidelity', () => {
  it.each(corpus)('preserves tokens and is idempotent: %s', (_name, source) => {
    expectStableFormatting(source);
  });
  it.each(['\n', '\r\n'])('preserves continuation directives verbatim with %j', eol => {
    const directive = ['  `define UPDATE(x) \\', '    begin \\', '      x=x+1; \\', '    end'].join(eol);
    const source = `${directive}${eol}module m;${eol}initial \\a+b =1;${eol}endmodule`;
    expect(expectStableFormatting(source)).toContain(directive);
  });
  it.each(['\n', '\r\n'])('preserves EOL and tab indentation with %j', eol => {
    const source = ['module m;', 'wire a; //中文', 'assign a=1;', 'endmodule', ''].join(eol);
    const result = expectStableFormatting(source, { tabSize: 4, insertSpaces: false });
    expect(result).toContain(`${eol}\twire`);
    if (eol === '\r\n') expect(result.replace(/\r\n/g, '')).not.toContain('\n');
  });
  it('protects off/on marker lines and the disabled body exactly', () => {
    const protectedText = '  // co-format: off\nassign   y=a+b;  \n\t// co-format: on';
    const source = `module m;\n${protectedText}\nassign z=a+b;\nendmodule`;
    const result = expectStableFormatting(source);
    expect(result).toContain(protectedText);
    expect(result).toContain('assign z = a + b;');
  });
  it('protects an unmatched off marker through EOF even with trimming options', () => {
    const suffix = '// co-format: off\nassign   y=a+b;  \n\n';
    const result = formatVerilog(`module m;\n${suffix}`, { tabSize: 2, insertSpaces: true, trimTrailingWhitespace: true, trimFinalNewlines: true });
    expect(result.endsWith(suffix)).toBe(true);
  });
  it.each(['initial $display("// co-format: off");', '/* // co-format: off */', 'wire a; // co-format: off', '// co-format: on', '// co-format: off extra'])('does not treat non-marker tokens as off: %s', line => {
    const result = expectStableFormatting(`module m;\n${line}\nassign y=a+b;\nendmodule`);
    expect(result).toContain('assign y = a + b;');
  });
  it('applies EOF options without stripping escaped identifier terminators', () => {
    expect(formatVerilog('module m;  \nwire a;  \nendmodule\n\n', { tabSize: 2, insertSpaces: true, trimTrailingWhitespace: true, trimFinalNewlines: true, insertFinalNewline: true })).toBe('module m;\n  wire a;\nendmodule\n');
    const source = 'module m;\nwire \\a+b \n';
    const result = formatVerilog(source, { tabSize: 2, insertSpaces: true, trimTrailingWhitespace: true, trimFinalNewlines: true });
    expect(tokenBodies(result)).toEqual(tokenBodies(source));
    expect(result).toMatch(/\\a\+b\s/);
  });
  it.each([0, -1, NaN, Infinity, 1.5, 1000000])('bounds invalid tabSize %s', tabSize => {
    const result = expectStableFormatting('module m;\nwire a;\nendmodule', { tabSize, insertSpaces: true });
    expect(result.length).toBeLessThan(200);
    expect(result).toContain('wire a;');
  });
});
