import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
import { parseVerilog } from '../../../language/verilog/parser';
import { parseVerilogExpression } from '../../../language/verilog/exprAst';
import { resolveVerilogSemanticAtPosition } from '../../../language/verilog/semanticModel';
import { classifyExpressionConstant, widthOfDecl, resolveDeclarationAt } from '../../../language/verilog/expressions';

function parse(text: string) {
  const document = TextDocument.create('test://parser-recovery.v', 'verilog', 1, text);
  return { document, result: parseVerilog(document, defaultCoSettings, true) };
}
function syntax(text: string) {
  return parse(text).result.diagnostics.filter((diagnostic) => String(diagnostic.code).startsWith('syntax-'));
}

describe('Verilog preprocessing and recoverable syntax', () => {
  it('selects nested ifndef/ifdef/elsif/else branches and applies undef only when active', () => {
    const text = [
      '`define ON 1', 'module m;', '`ifdef MISSING', 'assign ghost = 1;', '`define BAD 1',
      '`elsif ON', 'wire selected;', '`ifndef BAD', 'wire nested;', '`else', 'wire hidden;', '`endif',
      '`else', 'wire hidden2;', '`endif', '`undef ON', '`ifdef ON', 'wire hidden3;',
      '`elsif BAD', 'wire hidden4;', '`else', 'wire after_undef;', '`endif', 'endmodule'
    ].join('\n');
    const { result } = parse(text);
    expect([...result.modules[0].declarations.keys()]).toEqual(['selected', 'nested', 'after_undef']);
    expect(result.macros.map((macro) => macro.name)).toEqual(['ON']);
    expect(result.semantic.references.some((reference) => reference.name === 'ghost')).toBe(false);
    expect(syntax(text)).toEqual([]);
  });

  it('suppresses inactive character and string errors but retains unterminated-comment errors like Icarus', () => {
    const inactive = (body: string) => `module m;\n\`ifdef MISSING\n${body}\n\`endif\nendmodule`;
    expect(syntax(inactive('\u00a7'))).toEqual([]);
    expect(syntax(inactive('"unfinished'))).toEqual([]);
    expect(syntax(inactive('/* unfinished')).map((item) => item.code)).toContain('syntax-unclosed-comment');
    expect(syntax('module m; \u00a7 endmodule').map((item) => item.code)).toContain('syntax-unexpected-character');
  });

  it('retains continued macro definitions and function-like argument navigation at original offsets', () => {
    const text = ['`define ADD(x,y) ((x) + \\', '  (y))', 'module m(input [7:0] a, output [7:0] b);',
      'assign b = `ADD(a, 1);', 'endmodule'].join('\r\n');
    const { document, result } = parse(text);
    const macro = result.macros[0];
    expect(macro.body).toBe('(x,y) ((x) +    (y))');
    expect(macro.range.end.line).toBe(1);
    const use = result.macroUses.find((item) => item.name === 'ADD')!;
    expect(document.getText(use.selectionRange)).toBe('ADD');
    expect(resolveVerilogSemanticAtPosition(result.semantic, use.selectionRange.start)?.symbol?.macro).toBe(macro);
    const argument = document.positionAt(text.lastIndexOf('a, 1'));
    expect(resolveVerilogSemanticAtPosition(result.semantic, argument)?.symbol?.decl?.name).toBe('a');
    expect(result.semantic.unresolvedReferences.some((reference) => reference.name === '`ADD')).toBe(false);
    expect(syntax(text)).toEqual([]);
  });

  it('binds object macro constants to the define/undef snapshot without moving invocation ranges', () => {
    const text = ['`define W 4', 'module m;', "localparam [`W-1:0] P = 4'hf + 4'h1;",
      '`undef W', '`define W 8', "localparam [`W-1:0] Q = 4'hf + 4'h1;",
      '`undef W', 'localparam R = `W;', 'endmodule'].join('\n');
    const { result, document } = parse(text);
    const module = result.modules[0];
    expect(widthOfDecl(module.declarations.get('P')!, module).width).toBe(4);
    expect(widthOfDecl(module.declarations.get('Q')!, module).width).toBe(8);
    expect(module.declarations.get('P')?.constantValue).toBe(0n);
    expect(module.declarations.get('Q')?.constantValue).toBe(16n);
    expect(module.declarations.get('R')?.constantValue).toBeUndefined();
    for (const use of result.macroUses) expect(document.getText(use.range)).toBe('`W');
  });

  it('preserves every default_nettype transition at its source position', () => {
    const text = '`default_nettype none\nmodule a; endmodule\n`default_nettype wire\nmodule b; endmodule';
    const { result, document } = parse(text);
    const directives = result.ast.preprocessor.filter((node) => node.kind === 'directive' && node.name === 'default_nettype');
    expect(directives.map((node) => node.kind === 'directive' ? [node.argument, node.range.start.line] : [])).toEqual([['none', 0], ['wire', 2]]);
    expect(directives.map((node) => node.kind === 'directive' ? document.getText(node.selectionRange) : '')).toEqual(['default_nettype', 'default_nettype']);
  });

  it('accepts attributes, implicit and unnamed generate blocks, and grouped instance arrays', () => {
    const text = `module sub(input a); endmodule
module m(input a);
(* keep="true" *) wire preserved;
genvar i;
if (1) begin (* keep="true" *) sub u[3:0](a), v[1:0](a); end
for (i=0; i<2; i=i+1) begin wire local_wire; end
always @(*) begin (* keep="true" *) preserved = a; end
endmodule`;
    const { result } = parse(text);
    expect(syntax(text)).toEqual([]);
    expect(result.modules[1].declarations.has('preserved')).toBe(true);
    expect(result.modules[1].instances.map((instance) => instance.instanceName)).toEqual(['u', 'v']);
    expect(result.modules[1].generateBlocks.some((block) => block.declarations.some((decl) => decl.name === 'local_wire'))).toBe(true);
  });

  it('models implicit generate-case branches, local declarations, instances and mutual exclusion', () => {
    const text = `module sub(input a); endmodule
module m(input a, output y); localparam MODE=0;
case (MODE)
0: begin : first wire local_net; sub u(a); assign y=a; end
default: begin : second wire local_net; sub v(a); assign y=~a; end
endcase
endmodule`;
    const { result } = parse(text);
    expect(syntax(text)).toEqual([]);
    const module = result.modules[1];
    expect(module.instances.map((instance) => instance.instanceName)).toEqual(['u', 'v']);
    expect(module.generateBlocks.map((block) => block.name)).toEqual(['first', 'second']);
    expect(module.generateBlocks[0].branches[0].construct).toBe(module.generateBlocks[1].branches[0].construct);
    expect(module.generateBlocks[0].branches[0].branch).not.toBe(module.generateBlocks[1].branches[0].branch);
    expect(result.diagnostics.filter((item) => item.code === 'multi-driver')).toEqual([]);
  });

  it('distinguishes expression validity from assignment-target validity and keeps macro lvalues', () => {
    expect(syntax('module m; wire a,b,c; assign a+b=c; endmodule').map((item) => item.code)).toContain('syntax-malformed-assignment');
    expect(syntax('module m; function; endfunction endmodule').map((item) => item.code)).toContain('syntax-malformed-function');
    expect(syntax('`define SR_IM SR[15:10]\nmodule m; reg [31:0] SR; initial `SR_IM <= 0; endmodule')).toEqual([]);
    expect(syntax('module m; reg a,b; initial {a,b} = 0; endmodule')).toEqual([]);
    expect(syntax('module m; parameter N=8; function [N-1:0]; endfunction endmodule').map((item) => item.code)).toContain('syntax-malformed-function');
    expect(syntax('`define BITS(v) v[3:0]\nmodule m; reg [7:0] r; initial `BITS(r)=0; endmodule')).toEqual([]);
  });

  it('retains ports, body declarations and later modules after a missing header closing parenthesis', () => {
    const { result } = parse('module broken(input [7:0] a;\nwire body; assign body=a[0]; endmodule\nmodule good; wire ok; endmodule');
    expect(result.modules.map((module) => module.name)).toEqual(['broken', 'good']);
    expect([...result.modules[0].declarations.keys()]).toEqual(['a', 'body']);
    expect(result.modules[0].hasEndmodule).toBe(true);
    expect(result.modules[0].hasCompleteHeader).toBe(false);
    expect(parse('module unfinished(input a\nmodule complete; endmodule').result.modules.map((module) => module.name)).toEqual(['unfinished', 'complete']);
    expect(result.diagnostics.map((item) => item.code)).toContain('syntax-module-declaration');
  });

  it('distinguishes constant functions from functions that capture runtime signals or call tasks', () => {
    const text = `module child #(parameter P=1); endmodule
module m; wire runtime;
function integer pure(input integer value); pure = value + 1; endfunction
function integer captures(input integer value); captures = value + runtime; endfunction
function integer transitively_bad(input integer value); transitively_bad = captures(value); endfunction
function integer timed(input integer value); #1 timed = value; endfunction
function integer prints(input integer value); $display("%d", value); prints = value; endfunction
localparam GOOD = pure(1), BAD = captures(1);
child #(.P(pure(1))) good(); child #(.P(captures(1))) bad();
endmodule`;
    const { result } = parse(text);
    const module = result.modules.find((item) => item.name === 'm')!;
    expect(module.declarations.get('pure')?.constantFunction).toBe(true);
    for (const name of ['captures', 'transitively_bad', 'timed', 'prints']) {
      expect(module.declarations.get(name)?.constantFunction).toBe(false);
      expect(classifyExpressionConstant(parseVerilogExpression(`${name}(1)`), module)).toBe('nonConstant');
    }
    expect(classifyExpressionConstant(parseVerilogExpression('pure(1)'), module)).toBe('constant');
    expect(result.diagnostics.filter((item) => item.code === 'parameter-not-constant').map((item) => item.message).some((message) => message.includes("'P'"))).toBe(true);
  });

  it('shares packed types, signedness, initializers and unpacked dimensions for local declarations', () => {
    const text = `module m; reg [7:0] x; initial begin : local_scope
reg signed [31:0] x, y [0:3][0:7];
localparam time T = 1;
x = 1;
end endmodule`;
    const { result, document } = parse(text);
    const module = result.modules[0];
    const position = document.positionAt(text.indexOf('x = 1'));
    const x = resolveDeclarationAt(module, 'x', position)!;
    const y = resolveDeclarationAt(module, 'y', position)!;
    expect(widthOfDecl(x, module).width).toBe(32);
    expect(x.signed).toBe(true);
    expect(y.width).toBe('[31:0]');
    expect(y.unpackedDimensions).toHaveLength(2);
    expect(resolveDeclarationAt(module, 'T', position)?.valueType).toBe('time');
    expect(syntax("module m; initial begin : b localparam N=4; reg[N-1:0]x; x=4'hf; end endmodule")).toEqual([]);
  });
});
