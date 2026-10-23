import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { resolveParameterOverrides } from '../../../language/verilog/parameterOverrides';
import { parseModules } from '../../../language/verilog/moduleParser';
import { parseVerilogCore } from '../../../language/verilog/parseCore';
import { evalVerilogIntegerConstant, parseVerilogExpression, verilogExpressionHasError } from '../../../language/verilog/exprAst';
import { classifyExpressionConstant, evalExpressionAstConstant, evalExpressionAstWithin, evalExpressionConstant, evalExpressionAstTypedConstant, resolveDeclarationAt, shouldReportWidthMismatch, typeOfExpressionAst, widthOfDecl, widthOfExpressionAst } from '../../../language/verilog/expressions';

function model(body: string) { const text = `module m; ${body} endmodule`; const document = TextDocument.create('test://typed-values.v', 'verilog', 1, text); return { module: parseModules(document, text)[0], document }; }

describe('typed Verilog integral constants', () => {
  it('interprets signed literals, arithmetic shifts, logical shifts and mixed comparisons', () => {
    const { module } = model("localparam signed [7:0] S=8'shff; localparam NEG=S<0; localparam SHIFT=S>>>1;");
    expect(module.declarations.get('S')?.constantValue).toBe(-1n);
    expect(module.declarations.get('NEG')?.constantValue).toBe(1n);
    expect(module.declarations.get('SHIFT')?.constantValue).toBe(-1n);
    expect(evalExpressionConstant("8'shff < 16'sd0")).toBe(1n);
    expect(evalExpressionConstant("8'shff < 16'd0")).toBe(0n);
    expect(evalExpressionConstant("8'shff + 16'd1")).toBe(256n);
    expect(evalExpressionConstant("8'shff >> 1")).toBe(127n);
    expect(evalExpressionConstant("8'hff >>> 1")).toBe(127n);
    expect(evalExpressionConstant("$signed(8'hff) >>> 1")).toBe(-1n);
    expect(evalExpressionConstant("$unsigned(8'shff) >>> 1")).toBe(127n);
    expect(evalVerilogIntegerConstant(parseVerilogExpression("8'shff")!)).toBe(-1n);
  });
  it('propagates common width and unsigned context through nested expressions', () => {
    expect(evalExpressionConstant("(4'hf+4'h1)==8'h10")).toBe(1n);
    expect(evalExpressionConstant("1'b1 ? 4'hf+4'h1 : 8'h0")).toBe(16n);
    expect(evalExpressionConstant("(8'sh80 >>> 1) + 8'h0")).toBe(64n);
    expect(evalExpressionConstant("(8'sh80 >>> 1) + 16'h0")).toBe(64n);
    expect(evalExpressionConstant("$unsigned(8'sh80 >>> 1) + 16'h0")).toBe(192n);
    expect(evalExpressionAstConstant(parseVerilogExpression("4'hf+4'h1"), undefined, undefined, undefined, { width: 8 })).toBe(16n);
  });
  it('observes subexpression values after complete enclosing context propagation', () => {
    const root = parseVerilogExpression("(4'hf+4'h1)==8'h10")!;
    if (root.kind !== 'binaryExpression' || root.left.kind !== 'parenthesizedExpression') { throw new Error('unexpected test AST'); }
    expect(evalExpressionAstWithin(root, root.left.expression)?.bits).toBe(16n);
    const assignment = parseVerilogExpression("4'hf+4'h1")!;
    expect(evalExpressionAstWithin(assignment, assignment, undefined, undefined, 8)?.bits).toBe(16n);
    const dynamic = parseVerilogExpression("unknown + 1")!;
    if (dynamic.kind !== 'binaryExpression') { throw new Error('unexpected test AST'); }
    expect(evalExpressionAstWithin(dynamic, dynamic.right)).toBeUndefined();
  });
  it('uses declaration width for truncation, arithmetic context, and time parameters', () => {
    const { module } = model("localparam [3:0] P=4'hf+4'h1; localparam [7:0] W=4'hf+4'h1; parameter time T=1; localparam integer I=64'hffffffff;");
    expect(module.declarations.get('P')?.constantValue).toBe(0n);
    expect(module.declarations.get('W')?.constantValue).toBe(16n);
    expect(module.declarations.get('I')?.constantValue).toBe(-1n);
    expect(widthOfDecl(module.declarations.get('T')!, module).width).toBe(64);
    const overflow = widthOfExpressionAst(parseVerilogExpression("4'd16"), module);
    expect(overflow.minWidth).toBeLessThanOrEqual(4);
    expect(shouldReportWidthMismatch({ width: 4 }, overflow)).toBe(false);
  });
  it('keeps four-state constants distinct from dynamic, unresolved and cyclic expressions', () => {
    const { module } = model("parameter X=4'bx1z0; localparam Z={X,4'hz}; wire a; localparam CYCLE=CYCLE; function integer f; input integer n; begin f=n+1; end endfunction");
    const classify = (text: string) => classifyExpressionConstant(parseVerilogExpression(text), module);
    expect(classify('Z')).toBe('constant');
    expect(evalExpressionConstant('Z', module)).toBeUndefined();
    const value = evalExpressionAstTypedConstant(parseVerilogExpression('X'), module)!;
    expect(value.xMask).toBe(8n); expect(value.zMask).toBe(2n);
    expect(classify('a+1')).toBe('nonConstant'); expect(classify('missing')).toBe('unknown'); expect(classify('CYCLE')).toBe('nonConstant');
    expect(classify('f(2)')).toBe('constant'); expect(classify('f(a)')).toBe('nonConstant');
    expect(evalExpressionConstant("4'bx === 4'bx")).toBe(1n);
    expect(evalExpressionConstant("4'bx == 4'bx")).toBeUndefined();
    expect(evalExpressionConstant("4'bx000 & 4'b0000")).toBe(0n);
    expect(evalExpressionConstant("4'bx000 | 4'b1111")).toBe(15n);
    expect(evalExpressionConstant("&4'bx000")).toBe(0n);
    expect(evalExpressionConstant("|4'bx001")).toBe(1n);
    expect(evalExpressionConstant("!(~4'bx111)")).toBeUndefined();
    expect(evalExpressionConstant("4'bx ? 4'b1010 : 4'b1010")).toBe(10n);
  });
  it('maps declared packed indices in either direction and preserves out-of-range X bits', () => {
    const { module } = model("localparam [8:1] A=8'h80; localparam [0:7] B=8'h80; localparam P=A; localparam Q=B;");
    const value = (source: string) => evalExpressionConstant(source, module);
    expect(value('P[8]')).toBeUndefined(); expect(value('P[7]')).toBe(1n); expect(value('Q[0]')).toBe(0n); expect(value('Q[7]')).toBe(1n);
    expect(value('A[8]')).toBe(1n); expect(value('B[0]')).toBe(1n);
    expect(value('A[9]')).toBeUndefined(); expect(value('B[8]')).toBeUndefined();
    expect(value('A[8:5]')).toBe(8n); expect(value('B[0:3]')).toBe(8n);
    expect(value('A[5+:4]')).toBe(8n); expect(value('A[8-:4]')).toBe(8n);
    expect(value('B[0+:4]')).toBe(8n); expect(value('B[3-:4]')).toBe(8n);
    const partial = evalExpressionAstTypedConstant(parseVerilogExpression('A[9:6]'), module)!;
    expect(partial.bits).toBe(4n); expect(partial.xMask).toBe(8n);
  });
  it('consumes one unpacked dimension per bit select before selecting packed bits', () => {
    const { module } = model('reg signed [7:0] a [0:3][7:0]; integer i,j;');
    expect(widthOfExpressionAst(parseVerilogExpression('a[i][j]'), module).width).toBe(8);
    expect(typeOfExpressionAst(parseVerilogExpression('a[i]'), module).unpackedDimensions).toHaveLength(1);
    expect(typeOfExpressionAst(parseVerilogExpression('a[i][j]'), module).signed).toBe(true);
    expect(widthOfExpressionAst(parseVerilogExpression('a[i][j][0]'), module).width).toBe(1);
  });
  it('uses lexical scope declarations for local widths and constants', () => {
    const text = 'module m; reg [7:0] x; initial begin : b reg [31:0] x; x=0; end endmodule';
    const document = TextDocument.create('test://typed-scope.v', 'verilog', 1, text); const module = parseVerilogCore(document).modules[0];
    const position = document.positionAt(text.indexOf('x=0'));
    expect(resolveDeclarationAt(module, 'x', position)?.width).toBe('[31:0]');
    expect(widthOfExpressionAst(parseVerilogExpression('x'), module, undefined, position).width).toBe(32);
    expect(widthOfExpressionAst(parseVerilogExpression('x'), module).width).toBe(8);
  });
  it('retains override width, signedness and X/Z across parameter environments', () => {
    const text = `module child #(parameter P=4'h0); localparam Q=P>>>1; endmodule
      module parent; child #(.P(8'shff)) signed_value(); child #(.P(64'h100000000)) wide_value(); child #(.P(4'bx1z0)) unknown_value(); endmodule`;
    const document = TextDocument.create('test://typed-overrides.v', 'verilog', 1, text);
    const [child, parent] = parseModules(document, text);
    const signed = resolveParameterOverrides(parent.instances[0], parent, child).overrides;
    expect(signed?.get('P')).toBe(-1n);
    expect(evalExpressionAstTypedConstant(parseVerilogExpression('Q'), child, signed)?.signed).toBe(true);
    expect(evalExpressionAstTypedConstant(parseVerilogExpression('Q'), child, signed)?.bits).toBe(255n);
    expect(widthOfDecl(child.parameters[0], child, signed).width).toBe(8);
    const wide = resolveParameterOverrides(parent.instances[1], parent, child).overrides;
    expect(wide?.get('P')).toBe(0x100000000n);
    expect(widthOfDecl(child.parameters[0], child, wide).width).toBe(64);
    const unknown = resolveParameterOverrides(parent.instances[2], parent, child);
    expect(unknown.unresolved).toEqual([]);
    expect(unknown.overrides).toBeDefined();
    expect(evalExpressionAstTypedConstant(parseVerilogExpression('P'), child, unknown.overrides)?.xMask).toBe(8n);
    expect(classifyExpressionConstant(parseVerilogExpression('P'), child, unknown.overrides)).toBe('constant');
  });
  it('converts overrides with target declaration context and earlier named overrides', () => {
    const text = `module child #(parameter W=4, parameter [W-1:0] P=0, parameter signed [7:0] S=0); endmodule
      module parent; child #(.P(4'hf+4'h1), .W(8), .S(16'h1ff)) u(); endmodule`;
    const document = TextDocument.create('test://typed-target-overrides.v', 'verilog', 1, text);
    const [child, parent] = parseModules(document, text);
    const { overrides } = resolveParameterOverrides(parent.instances[0], parent, child);
    expect(overrides?.get('W')).toBe(8n);
    expect(overrides?.get('P')).toBe(16n);
    expect(overrides?.get('S')).toBe(-1n);
  });
  it('binds object macro values and packed ranges at each original invocation', () => {
    const text = "`define WIDTH 8\nmodule m; wire [`WIDTH-1:0] a; localparam P=`WIDTH;\n`undef WIDTH\n`define WIDTH 16\nwire [`WIDTH-1:0] b; localparam Q=`WIDTH; endmodule";
    const document = TextDocument.create('test://typed-macros.v', 'verilog', 1, text); const module = parseModules(document, text)[0];
    expect(widthOfDecl(module.declarations.get('a')!, module).width).toBe(8);
    expect(widthOfDecl(module.declarations.get('b')!, module).width).toBe(16);
    expect(module.declarations.get('P')?.constantValue).toBe(8n);
    expect(module.declarations.get('Q')?.constantValue).toBe(16n);
  });
  it('bounds all numeric work and recursive expression analysis', () => {
    for (const source of ["~9007199254740991'b0", "{9007199254740991{1'b0}}", "2**9007199254740991", '('.repeat(500) + '1' + ')'.repeat(500), Array.from({length:1000}, () => '1').join('+')]) {
      expect(() => { const ast = parseVerilogExpression(source); evalExpressionAstTypedConstant(ast); widthOfExpressionAst(ast, undefined); verilogExpressionHasError(ast); }).not.toThrow();
    }
    expect(() => model('localparam [A:0] A=1;')).not.toThrow();
    expect(() => model('localparam A=B; localparam B=A;')).not.toThrow();
    expect(evalExpressionConstant("~9007199254740991'b0")).toBeUndefined();
    expect(evalExpressionConstant('2**9007199254740991')).toBeUndefined();
    expect(evalExpressionConstant("8'hff << 9007199254740991")).toBe(0n);
    expect(evalExpressionConstant("{2{8'hff}}")).toBe(65535n);
  });
});
