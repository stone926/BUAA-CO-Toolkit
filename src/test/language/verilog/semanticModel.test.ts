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
});
