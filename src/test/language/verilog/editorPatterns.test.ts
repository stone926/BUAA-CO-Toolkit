import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity, DiagnosticTag } from 'vscode-languageserver/node';
import { defaultCoSettings, mergeCoSettings } from '../../../language/common/settings';
import { parseVerilog, widthOfDecl, widthOfExpression } from '../../../language/verilog/parser';
import { getVerilogDefinition, getVerilogDiagnostics, getVerilogHover, getVerilogSignatureHelp, getVerilogCodeActions } from '../../../language/verilog/service';
import { collectContinuousAssignmentUsesFromAst } from '../../../language/verilog/assignmentAst';
import { numericLiteralAt } from '../../../language/verilog/numericLiterals';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';
import { positionOf, rangeOf, verilogDoc } from '../../helpers/textDocument';

const settings = defaultCoSettings;

describe('Verilog editing patterns', () => {
  it('keeps grouped instances and empty positional connections aligned with the target interface', () => {
    const document = verilogDoc(`
module child #(parameter W = 8)(input unused, input [W-1:0] data, output [W-1:0] result);
  assign result = data;
endmodule
module top(input [7:0] data, output [7:0] y, z);
  child #(.W(8)) left(, data, y), right(.unused(), .data(data), .result(z));
endmodule`);
    const parsed = parseVerilog(document, settings, true);
    const instances = parsed.modules[1].instances;
    expect(instances.map((instance) => instance.instanceName)).toEqual(['left', 'right']);
    expect(instances[0].portConnections.map((connection) => [connection.positionalIndex, connection.expression])).toEqual([[0, ''], [1, 'data'], [2, 'y']]);
    expect(parsed.diagnostics).toEqual([]);
    const index = new VerilogWorkspaceIndex();
    const definition = getVerilogDefinition(document, positionOf(document, '.result(z)', 2), settings, index);
    expect(definition?.range).toEqual(parsed.modules[0].ports[2].selectionRange);
    const signature = getVerilogSignatureHelp(document, positionOf(document, 'data, y'), settings, index);
    expect(signature?.activeParameter).toBe(1);
  });

  it('validates later instances and preserves earlier instances while the last one is unfinished', () => {
    const document = verilogDoc('module top; child first(), second(.a(1 +)); endmodule');
    expect(getVerilogDiagnostics(document, settings).some((item) => item.code === 'syntax-malformed-instance')).toBe(true);
    const partial = parseVerilog(verilogDoc('module top; child first(), second(.a('), settings, false);
    expect(partial.modules[0].instances.map((instance) => instance.instanceName)).toEqual(['first']);
  });

  it('models every assignment in a continuous list for widths, navigation and refactoring', () => {
    const document = verilogDoc(`module top(input [7:0] data, output [7:0] y, output [3:0] z);
  assign y = data, z = data + 1;
endmodule`);
    const parsed = parseVerilog(document, settings, true);
    expect(parsed.diagnostics.filter((item) => String(item.code).startsWith('syntax-'))).toEqual([]);
    expect(collectContinuousAssignmentUsesFromAst(document, parsed.ast.modules[0]).map((use) => use.name)).toEqual(['y', 'z']);
    expect(parsed.diagnostics.filter((item) => item.code === 'width-mismatch').map((item) => document.getText(item.range))).toEqual(['data + 1']);
    const index = new VerilogWorkspaceIndex();
    const definition = getVerilogDefinition(document, positionOf(document, 'data +'), settings, index);
    expect(definition?.range).toEqual(parsed.modules[0].ports[0].selectionRange);
    const actions = getVerilogCodeActions(document, rangeOf(document, '+'), [], settings, index);
    expect(actions.some((action) => action.title === 'Extract expression to wire EXPR_WIRE')).toBe(true);
  });

  it('does not absorb a healthy module after a missing endmodule or closing delimiter', () => {
    const document = verilogDoc(`module broken(input a); assign a = (1 +
module healthy(input [7:0] data, output [7:0] y);
  assign y = data;
endmodule`);
    const parsed = parseVerilog(document, settings, true);
    expect(parsed.modules.map((module) => [module.name, module.hasEndmodule])).toEqual([['broken', false], ['healthy', true]]);
    expect(parsed.ast.modules[1].items.some((item) => item.kind === 'continuousAssign')).toBe(true);
    const definition = getVerilogDefinition(document, positionOf(document, 'y = data', 4), settings, new VerilogWorkspaceIndex());
    expect(definition?.range).toEqual(parsed.modules[1].ports[0].selectionRange);
  });

  it('inherits parameter ranges, distinguishes array dimensions, and leaves macro widths unknown', () => {
    const document = verilogDoc(`module top #(parameter [7:0] A=1, B=2, parameter C=3);
  reg words [0:31];
  wire [\`WIDTH-1:0] bus;
  wire [31:0] source;
  assign bus = source;
endmodule`);
    const parsed = parseVerilog(document, settings, true);
    const module = parsed.modules[0];
    expect(module.parameters.map((decl) => decl.width)).toEqual(['[7:0]', '[7:0]', undefined]);
    expect(widthOfDecl(module.declarations.get('bus')!, module)).toEqual({});
    expect(widthOfExpression('words[5]', module).width).toBe(1);
    expect(parsed.diagnostics.filter((item) => item.code === 'width-mismatch')).toEqual([]);
  });

  it('accepts testbench real delays and spaced based literals without integer folding real values', () => {
    const document = verilogDoc(`module sample;
  parameter HALF = 2.5, PERIOD = 1e+3;
  reg clk;
  reg [31:0] value;
  initial begin clk = 0; value = 32 'h ff; end
  always #2.5 clk = ~clk;
endmodule`);
    const parsed = parseVerilog(document, settings, true);
    expect(parsed.diagnostics.filter((item) => String(item.code).startsWith('syntax-'))).toEqual([]);
    expect(parsed.modules[0].parameters.map((decl) => decl.constantValue)).toEqual([undefined, undefined]);
    expect(numericLiteralAt(document, positionOf(document, '2.5'))).toBeUndefined();
    expect(numericLiteralAt(document, positionOf(document, "32 'h ff"))?.value).toBe(255n);
  });

  it('does not offer numeric conversions inside strings, comments or identifiers', () => {
    const document = verilogDoc(`module sample;
  // constant 123
  /* block 456 */
  initial $display("789");
  wire signal123;
endmodule`);
    for (const value of ['123', '456', '789', 'signal123']) {
      expect(numericLiteralAt(document, positionOf(document, value))).toBeUndefined();
    }
  });

  it('keeps diagnostics quiet for legal style choices', () => {
    const document = verilogDoc(`module sample(input clock, input rst, input [7:0] a, b, output reg [7:0] y);
  initial y = 0;
  always @(negedge clock or posedge rst) begin
    if (rst) y <= 0; else y <= a * b;
  end
endmodule`);
    expect(getVerilogDiagnostics(document, settings)).toEqual([]);
    const nonblocking = verilogDoc('module sample(input a, output reg y); always @* y <= a; endmodule');
    expect(getVerilogDiagnostics(nonblocking, settings)).toEqual([]);
  });

  it('shows expression facts without echoing a long source expression or parser metadata', () => {
    const document = verilogDoc(`module sample(input [7:0] a, output [7:0] y); assign y = ${Array(70).fill('a').join(' + ')}; endmodule`);
    const hover = getVerilogHover(document, document.positionAt(document.getText().lastIndexOf('+')), settings, new VerilogWorkspaceIndex());
    const text = typeof hover?.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
    expect(text.length).toBeLessThan(230);
    expect(text).toContain('**Expression**');
    expect(text).not.toContain('a + a + a');
    expect(text).not.toMatch(/AST|Node range|flexible|min:/);
  });

  it('tracks case labels containing ternaries and a default without a colon', () => {
    const document = verilogDoc(`module sample(input [1:0] sel, input a, b, output reg y);
  parameter CHOICE = 1;
  always @* case (sel)
    CHOICE ? 1 : 2: y = a;
    default y = b;
  endcase
endmodule`);
    const parsed = parseVerilog(document, settings, true);
    const statement = parsed.ast.modules[0].alwaysBlocks[0].statementTree.statements[0];
    expect(statement.kind).toBe('case');
    if (statement.kind !== 'case') return;
    expect(statement.items).toHaveLength(2);
    expect(statement.items[0].labels[0].kind).toBe('conditionalExpression');
    expect(statement.items[1].defaultItem).toBe(true);
    const index = new VerilogWorkspaceIndex();
    expect(getVerilogDefinition(document, positionOf(document, 'y = b', 4), settings, index)?.range).toEqual(parsed.modules[0].ports[2].selectionRange);
    expect(parsed.diagnostics).toEqual([]);
  });

  it('retains symbols in strength-qualified net declarations and assignments', () => {
    const document = verilogDoc(`module sample(input a, output y);
  tri (weak1, strong0) ready = a;
  assign (weak1, weak0) y = ready;
endmodule`);
    const parsed = parseVerilog(document, settings, true);
    expect(parsed.modules[0].declarations.has('ready')).toBe(true);
    expect(parsed.diagnostics).toEqual([]);
    expect(getVerilogDefinition(document, positionOf(document, 'y = ready', 4), settings, new VerilogWorkspaceIndex())?.range).toEqual(parsed.modules[0].declarations.get('ready')?.selectionRange);
  });

  it('keeps unused declarations as dimming hints, without hierarchy reminders', () => {
    const document = verilogDoc('module standalone; localparam UNUSED = 1; wire spare; endmodule');
    const index = new VerilogWorkspaceIndex();
    index.updateDocument(document, settings);
    const diagnostics = getVerilogDiagnostics(document, settings, index);
    expect(diagnostics.map((item) => item.code)).toEqual(['unused-parameter', 'unused-signal']);
    expect(diagnostics.every((item) => item.severity === DiagnosticSeverity.Hint && item.tags?.includes(DiagnosticTag.Unnecessary))).toBe(true);
  });

  it('reports empty continuous assignments instead of accepting a dropped list element', () => {
    for (const body of ['assign a = 1, , b = 0;', 'assign a = 1,;']) {
      const document = verilogDoc(`module sample(output a, b); ${body} endmodule`);
      expect(getVerilogDiagnostics(document, settings).some((item) => item.code === 'syntax-malformed-assignment')).toBe(true);
    }
  });

  it('preserves signedness when converting integer literals', () => {
    const document = verilogDoc("module sample; localparam VALUE = 8'shff; endmodule");
    const actions = getVerilogCodeActions(document, rangeOf(document, "8'shff"), [], settings, new VerilogWorkspaceIndex());
    const action = actions.find((item) => item.title === 'Convert literal to decimal');
    expect(action?.edit?.changes?.[document.uri]?.[0].newText).toBe("8'sd255");
  });

  it('keeps an unwrapped if/else body intact and parses declarations that follow it', () => {
    const document = verilogDoc(`module sample(input sel, a, b, output reg y);
  always @* if (sel) y = a; else y = b;
  wire after_block = y;
endmodule`);
    const parsed = parseVerilog(document, settings, true);
    const statement = parsed.ast.modules[0].alwaysBlocks[0].statementTree.statements[0];
    expect(statement.kind === 'if' && statement.alternate?.kind).toBe('assignment');
    expect(parsed.modules[0].declarations.has('after_block')).toBe(true);
    expect(parsed.diagnostics).toEqual([]);
  });

  it('reports a shared parameter-list error once for a group of instances', () => {
    const document = verilogDoc('module child; endmodule\nmodule top; child #(.BAD(1)) a(), b(); endmodule');
    expect(getVerilogDiagnostics(document, settings).filter((item) => item.code === 'unknown-parameter')).toHaveLength(1);
  });
});
