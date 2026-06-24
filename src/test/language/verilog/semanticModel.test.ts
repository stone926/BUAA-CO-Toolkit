import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
import { parseVerilog } from '../../../language/verilog/parser';
import { resolveVerilogSemanticAtPosition, verilogSemanticReferenceRanges, verilogSemanticTargetFromSymbol } from '../../../language/verilog/semanticModel';

function doc(text: string): TextDocument {
  return TextDocument.create('test://semantic.v', 'verilog', 1, text);
}

describe('Verilog AST and semantic model', () => {
  it('builds a document AST with module items and procedural blocks', () => {
    const text = [
      '`define WIDTH 4',
      'module child(input [`WIDTH-1:0] a, output y);',
      '    assign y = a[0];',
      'endmodule',
      'module top(input clk);',
      '    reg state;',
      '    always @(posedge clk) begin',
      '        state <= ~state;',
      '    end',
      'endmodule'
    ].join('\n');
    const result = parseVerilog(doc(text), defaultCoSettings, false);

    expect(result.ast.kind).toBe('sourceFile');
    expect(result.ast.preprocessor.some((item) => item.kind === 'macroDefinition' && item.name === 'WIDTH')).toBe(true);
    expect(result.ast.modules).toHaveLength(2);
    expect(result.ast.modules[0].items.some((item) => item.kind === 'continuousAssign')).toBe(true);
    expect(result.ast.modules[1].alwaysBlocks).toHaveLength(1);
  });

  it('binds module, declaration, port connection, macro, and unresolved references', () => {
    const text = [
      '`define WIDTH 4',
      'module child(input [`WIDTH-1:0] a, output y);',
      '    assign y = a[0];',
      'endmodule',
      'module top(input clk);',
      '    wire [`WIDTH-1:0] sig;',
      '    child u_child(.a(sig), .y(missing));',
      'endmodule'
    ].join('\n');
    const document = doc(text);
    const result = parseVerilog(document, defaultCoSettings, false);

    expect(result.semantic.fileScope.symbols.get('child')?.[0].kind).toBe('module');
    expect(result.semantic.moduleScopes.find((scope) => scope.name === 'top')?.symbols.get('sig')?.[0].kind).toBe('signal');
    expect(result.semantic.references.some((reference) => reference.name === 'child' && reference.kind === 'module')).toBe(true);
    expect(result.semantic.references.some((reference) => reference.name === 'a' && reference.kind === 'portConnection')).toBe(true);
    expect(result.semantic.references.some((reference) => reference.name === 'WIDTH' && reference.kind === 'macro')).toBe(true);
    expect(result.semantic.unresolvedReferences.some((reference) => reference.name === 'missing')).toBe(true);

    const sigOffset = text.indexOf('sig),');
    const resolved = resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(sigOffset));
    expect(resolved?.symbol?.name).toBe('sig');
    expect(resolved?.symbol?.kind).toBe('signal');
  });

  it('does not treat an instance port name as a reference to a same-named signal', () => {
    const text = [
      'module sub(input clk);',
      'endmodule',
      'module top(input clk);',
      '    sub u(.clk(clk));',
      'endmodule'
    ].join('\n');
    const document = doc(text);
    const result = parseVerilog(document, defaultCoSettings, false);
    const clkSymbol = result.semantic.symbols.find((symbol) => symbol.name === 'clk' && symbol.module?.name === 'top');
    expect(clkSymbol).toBeDefined();

    const ranges = verilogSemanticReferenceRanges(result.semantic, verilogSemanticTargetFromSymbol(clkSymbol!), false);
    const has = (offset: number): boolean => {
      const pos = document.positionAt(offset);
      return ranges.some((range) => range.start.line === pos.line && range.start.character === pos.character);
    };

    // `.clk` (the instantiated module's port name) must NOT count as a use of top's signal clk.
    expect(has(text.indexOf('.clk(') + 1)).toBe(false);
    // the connected expression `(clk)` IS a use of top's signal clk.
    expect(has(text.indexOf('(clk)') + 1)).toBe(true);
  });

  it('keeps block-local declarations in the nearest scope', () => {
    const text = [
      'module scoped(input clk);',
      '    reg i;',
      '    always @(posedge clk) begin',
      '        integer i;',
      '        i = 1;',
      '    end',
      '    assign i = 0;',
      'endmodule'
    ].join('\n');
    const document = doc(text);
    const result = parseVerilog(document, defaultCoSettings, false);
    const moduleSymbol = result.semantic.symbols.find((symbol) => symbol.name === 'i' && symbol.scope.kind === 'module');
    const blockSymbol = result.semantic.symbols.find((symbol) => symbol.name === 'i' && symbol.scope.kind === 'block');
    const declaration = result.ast.modules[0].proceduralBlocks[0].statementTree.statements.find((statement) => statement.kind === 'declaration');
    expect(declaration?.kind).toBe('declaration');
    if (declaration?.kind === 'declaration') {
      expect(declaration.declarations.map((item) => item.declaration.name)).toEqual(['i']);
    }
    expect(moduleSymbol).toBeDefined();
    expect(blockSymbol).toBeDefined();

    const blockUse = resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('i = 1')));
    const moduleUse = resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('i = 0')));
    expect(blockUse?.symbol).toBe(blockSymbol);
    expect(moduleUse?.symbol).toBe(moduleSymbol);
  });

  it('binds for-loop declarations without leaking them to module scope', () => {
    const text = [
      'module loop(input clk);',
      '    always @(posedge clk) begin',
      '        for (integer i = 0; i < 4; i = i + 1) begin',
      '        end',
      '    end',
      'endmodule'
    ].join('\n');
    const document = doc(text);
    const result = parseVerilog(document, defaultCoSettings, false);
    const loopIndexSymbol = result.semantic.symbols.find((symbol) => symbol.name === 'i' && symbol.scope.kind === 'block');
    const loop = result.ast.modules[0].proceduralBlocks[0].statementTree.statements.find((statement) => statement.kind === 'loop');
    expect(loop?.kind).toBe('loop');
    if (loop?.kind === 'loop') {
      expect(loop.initDeclarations.map((item) => item.declaration.name)).toEqual(['i']);
    }
    expect(loopIndexSymbol).toBeDefined();
    expect(result.semantic.moduleScopes[0].symbols.get('i')).toBeUndefined();
    const use = resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('i < 4')));
    expect(use?.symbol).toBe(loopIndexSymbol);
  });

  it('models subroutine bodies as AST-backed semantic scopes', () => {
    const text = [
      'module subroutines(input [7:0] src, output reg [7:0] out);',
      '    task do_write(input [7:0] value);',
      '        integer i;',
      '        begin',
      '            i = value;',
      '            out = value;',
      '        end',
      '    endtask',
      '    function [7:0] add_one(input [7:0] arg);',
      '        begin',
      '            add_one = arg + 1;',
      '        end',
      '    endfunction',
      '    initial begin',
      '        do_write(src);',
      '        out = add_one(src);',
      '    end',
      'endmodule'
    ].join('\n');
    const document = doc(text);
    const result = parseVerilog(document, defaultCoSettings, false);
    const moduleAst = result.ast.modules[0];

    expect(moduleAst.subroutines.map((subroutine) => subroutine.name)).toEqual(['do_write', 'add_one']);
    expect(moduleAst.subroutines[0].statementTree.statements.map((statement) => statement.kind)).toEqual(['declaration', 'block']);

    const taskLocal = result.semantic.symbols.find((symbol) => symbol.name === 'i' && symbol.scope.name === 'task');
    const taskArgument = result.semantic.symbols.find((symbol) => symbol.name === 'value' && symbol.scope.name === 'task');
    expect(resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('i = value')))?.symbol).toBe(taskLocal);
    expect(resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('i = value') + 'i = '.length))?.symbol).toBe(taskArgument);
    expect(resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('out = value')))?.symbol?.name).toBe('out');
    expect(resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('add_one = arg')))?.symbol?.kind).toBe('task');
  });

  it('collects expression AST references without duplicating token fallback references', () => {
    const text = [
      'module expr_refs(input [7:0] a, output [7:0] y);',
      "    assign y = {$signed(a[3:0]), a[7:4]};",
      'endmodule'
    ].join('\n');
    const document = doc(text);
    const result = parseVerilog(document, defaultCoSettings, false);
    const aReferences = result.semantic.references.filter((reference) => reference.name === 'a');

    expect(aReferences).toHaveLength(2);
    expect(result.semantic.unresolvedReferences.some((reference) => reference.name === '$signed')).toBe(false);
    expect(resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('a[3:0]')))?.symbol?.name).toBe('a');
  });

  it('collects expression AST references in declaration initializers and instance connections', () => {
    const text = [
      'module child #(parameter W = 1)(input [W-1:0] din);',
      'endmodule',
      'module top(input [3:0] a);',
      '    localparam W2 = 4;',
      '    wire [3:0] tmp = a;',
      '    child #(.W(W2)) u_child(.din(tmp));',
      'endmodule'
    ].join('\n');
    const document = doc(text);
    const result = parseVerilog(document, defaultCoSettings, false);
    const initializerUse = resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('= a') + 2));
    const parameterConnectionUse = resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('W2))')));
    const portConnectionUse = resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('tmp))')));

    expect(initializerUse?.symbol?.name).toBe('a');
    expect(parameterConnectionUse?.symbol?.name).toBe('W2');
    expect(portConnectionUse?.symbol?.name).toBe('tmp');
  });

  it('collects references from malformed expression ASTs without token fallback', () => {
    const text = [
      'module child(input a);',
      'endmodule',
      'module top(input src);',
      '    wire tmp = src + ;',
      '    child u_child(.a(tmp + ));',
      'endmodule'
    ].join('\n');
    const document = doc(text);
    const result = parseVerilog(document, defaultCoSettings, false);
    const initializerUse = resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('src +')));
    const connectionUse = resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('tmp +')));

    expect(initializerUse?.symbol?.name).toBe('src');
    expect(connectionUse?.symbol?.name).toBe('tmp');
  });

  it('collects declaration width AST references in ports and body declarations', () => {
    const text = [
      'module widths #(parameter W = 4)(input [W-1:0] in, output out);',
      '    localparam LAST = W - 1;',
      '    wire [LAST:0] bus = in;',
      '    assign out = bus[LAST];',
      'endmodule'
    ].join('\n');
    const document = doc(text);
    const result = parseVerilog(document, defaultCoSettings, false);
    const module = result.modules[0];
    const inDecl = module.declarations.get('in');
    const busDecl = module.declarations.get('bus');

    expect(inDecl?.widthAst).toHaveLength(2);
    expect(busDecl?.widthAst).toHaveLength(2);
    expect(resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('[W-1:0]') + 1))?.symbol?.kind).toBe('parameter');
    expect(resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('[LAST:0]') + 1))?.symbol?.name).toBe('LAST');
  });

  it('collects procedural AST references in controls, conditions, and assignments', () => {
    const text = [
      'module proc(input clk, input a, input [1:0] sel, output reg y);',
      '    always @(posedge clk) begin',
      '        if (a) begin',
      '            y <= sel[0];',
      '        end else begin',
      '            y <= clk;',
      '        end',
      '    end',
      'endmodule'
    ].join('\n');
    const document = doc(text);
    const result = parseVerilog(document, defaultCoSettings, false);

    const clockUse = resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('clk) begin')));
    const conditionUse = resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('if (a)') + 4));
    const rhsUse = resolveVerilogSemanticAtPosition(result.semantic, document.positionAt(text.indexOf('sel[0]')));

    expect(clockUse?.symbol?.name).toBe('clk');
    expect(conditionUse?.symbol?.name).toBe('a');
    expect(rhsUse?.symbol?.name).toBe('sel');
  });
});
