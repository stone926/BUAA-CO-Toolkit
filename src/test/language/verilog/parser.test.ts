import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  stripCommentsAndStrings,
  splitTopLevelCommas,
  splitTopLevelCommaSpans,
  normalizeWidth,
  declDetail,
  widthOfDecl,
  shouldReportWidthMismatch,
  widthOfExpression,
  evalExpressionConstant,
  parseVerilogExpression,
  verilogExpressionHasError,
  parseVerilog,
  parseModules,
  parseMacros,
  parseMacroUses,
  parseIncludes,
  parseDirectives,
  moduleAtPosition,
  buildTestbench,
  walkVerilogExpression
} from '../../../language/verilog/parser';
import { VerilogDecl, VerilogModule } from '../../../language/verilog/model';
import { mergeCoSettings } from '../../../language/common/settings';

function doc(text: string): TextDocument {
  return TextDocument.create('test://test.v', 'verilog', 1, text);
}

function makeModule(overrides: Partial<VerilogModule> = {}): VerilogModule {
  return {
    name: 'test',
    ports: [],
    parameters: [],
    declarations: new Map(),
    instances: [],
    range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
    selectionRange: { start: { line: 0, character: 7 }, end: { line: 0, character: 11 } },
    headerEnd: { line: 0, character: 20 },
    uri: 'test://test.v',
    bodyText: '',
    hasEndmodule: true,
    ...overrides
  };
}

function makeDecl(overrides: Partial<VerilogDecl> = {}): VerilogDecl {
  return {
    name: 'sig',
    kind: 'wire',
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
    selectionRange: { start: { line: 0, character: 5 }, end: { line: 0, character: 8 } },
    ...overrides
  };
}

// ────────────────────────────────────────────────────────────────────────────────
// stripCommentsAndStrings
// ────────────────────────────────────────────────────────────────────────────────
describe('stripCommentsAndStrings', () => {
  it('leaves plain code unchanged', () => {
    expect(stripCommentsAndStrings('wire a;')).toBe('wire a;');
  });

  it('strips single-line comments', () => {
    const input = 'wire a; // comment';
    const result = stripCommentsAndStrings(input);
    expect(result).not.toContain('comment');
    expect(result.length).toBe(input.length);
  });

  it('strips block comments', () => {
    const result = stripCommentsAndStrings('wire a; /* block */ wire b;');
    expect(result).toBe('wire a;             wire b;');
  });

  it('strips multi-line block comments', () => {
    const input = 'wire a;\n/* multi\nline */\nwire b;';
    const result = stripCommentsAndStrings(input);
    expect(result).not.toContain('multi');
    expect(result).not.toContain('line');
    expect(result).toContain('wire a;');
    expect(result).toContain('wire b;');
  });

  it('strips string literals', () => {
    const input = '$display("hello world")';
    const result = stripCommentsAndStrings(input);
    expect(result).not.toContain('hello');
    expect(result.length).toBe(input.length);
  });

  it('handles escaped quotes inside strings', () => {
    const result = stripCommentsAndStrings('$display("hello \\"world\\"")');
    expect(result).not.toContain('world');
  });

  it('preserves # inside strings (not a comment in Verilog)', () => {
    const result = stripCommentsAndStrings('$display("hello # world")');
    expect(result).not.toContain('hello');
  });

  it('handles empty input', () => {
    expect(stripCommentsAndStrings('')).toBe('');
  });

  it('handles consecutive comments', () => {
    const result = stripCommentsAndStrings('/* a *//* b */wire;');
    expect(result).toContain('wire;');
  });

  it('does not strip // inside a block comment', () => {
    const result = stripCommentsAndStrings('/* // not a line comment */wire;');
    expect(result).toContain('wire;');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// splitTopLevelCommas / splitTopLevelCommaSpans
// ────────────────────────────────────────────────────────────────────────────────
describe('splitTopLevelCommas', () => {
  it('splits simple comma-separated values', () => {
    expect(splitTopLevelCommas('a, b, c')).toEqual(['a', ' b', ' c']);
  });

  it('returns single element for no commas', () => {
    expect(splitTopLevelCommas('abc')).toEqual(['abc']);
  });

  it('returns empty array for empty string', () => {
    expect(splitTopLevelCommas('')).toEqual(['']);
  });

  it('does not split commas inside parentheses', () => {
    expect(splitTopLevelCommas('a(b, c), d')).toEqual(['a(b, c)', ' d']);
  });

  it('does not split commas inside square brackets', () => {
    expect(splitTopLevelCommas('a[0, 1], b')).toEqual(['a[0, 1]', ' b']);
  });

  it('does not split commas inside curly braces', () => {
    expect(splitTopLevelCommas('{a, b}, c')).toEqual(['{a, b}', ' c']);
  });

  it('handles nested parentheses', () => {
    expect(splitTopLevelCommas('a((b, c), d), e')).toEqual(['a((b, c), d)', ' e']);
  });

  it('does not split commas inside strings', () => {
    expect(splitTopLevelCommas('"a, b", c')).toEqual(['"a, b"', ' c']);
  });
});

describe('splitTopLevelCommaSpans', () => {
  it('returns spans with correct offsets', () => {
    const spans = splitTopLevelCommaSpans('a, bb, ccc');
    expect(spans).toHaveLength(3);
    expect(spans[0].text).toBe('a');
    expect(spans[0].start).toBe(0);
    expect(spans[0].end).toBe(1);
    expect(spans[1].text).toBe(' bb');
    expect(spans[1].start).toBe(2);
    expect(spans[1].end).toBe(5);
    expect(spans[2].text).toBe(' ccc');
    expect(spans[2].start).toBe(6);
    expect(spans[2].end).toBe(10);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// normalizeWidth
// ────────────────────────────────────────────────────────────────────────────────
describe('normalizeWidth', () => {
  it('returns undefined for undefined input', () => {
    expect(normalizeWidth(undefined)).toBeUndefined();
  });

  it('removes whitespace from width strings', () => {
    expect(normalizeWidth('[ 31 : 0 ]')).toBe('[31:0]');
    expect(normalizeWidth('[7 : 0]')).toBe('[7:0]');
  });

  it('leaves already-normalized widths unchanged', () => {
    expect(normalizeWidth('[31:0]')).toBe('[31:0]');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// declDetail
// ────────────────────────────────────────────────────────────────────────────────
describe('declDetail', () => {
  it('formats a wire declaration', () => {
    expect(declDetail(makeDecl({ name: 'a', kind: 'wire', width: '[7:0]' }))).toBe('wire [7:0] a');
  });

  it('formats an input port', () => {
    expect(declDetail(makeDecl({ name: 'clk', kind: 'input', direction: 'input' }))).toBe('input clk');
  });

  it('formats a parameter', () => {
    expect(declDetail(makeDecl({ name: 'WIDTH', kind: 'parameter', width: '[31:0]' }))).toBe('parameter [31:0] WIDTH');
  });

  it('formats a declaration without width', () => {
    expect(declDetail(makeDecl({ name: 'sig', kind: 'reg' }))).toBe('reg sig');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// widthOfDecl
// ────────────────────────────────────────────────────────────────────────────────
describe('widthOfDecl', () => {
  it('returns 32 for [31:0]', () => {
    expect(widthOfDecl(makeDecl({ width: '[31:0]' }))).toEqual({ width: 32 });
  });

  it('returns 16 for [15:0]', () => {
    expect(widthOfDecl(makeDecl({ width: '[15:0]' }))).toEqual({ width: 16 });
  });

  it('returns 1 for [0:0]', () => {
    expect(widthOfDecl(makeDecl({ width: '[0:0]' }))).toEqual({ width: 1 });
  });

  it('returns 32 for integer kind', () => {
    expect(widthOfDecl(makeDecl({ kind: 'integer' }))).toEqual({ width: 32 });
  });

  it('returns 32 for time kind', () => {
    expect(widthOfDecl(makeDecl({ kind: 'time' }))).toEqual({ width: 32 });
  });

  it('returns inferred width for untyped parameters', () => {
    expect(widthOfDecl(makeDecl({ kind: 'parameter', inferredWidth: 6 }))).toEqual({ width: 6 });
  });

  it('preserves flexible inferred width for unsized parameter literals', () => {
    expect(widthOfDecl(makeDecl({
      kind: 'parameter',
      inferredWidth: 32,
      inferredMinWidth: 1,
      inferredFlexible: true
    }))).toEqual({ width: 32, minWidth: 1, flexible: true });
  });

  it('returns 1 for declarations without width', () => {
    expect(widthOfDecl(makeDecl({ kind: 'wire' }))).toEqual({ width: 1 });
  });

  it('handles reversed bit ranges', () => {
    expect(widthOfDecl(makeDecl({ width: '[0:31]' }))).toEqual({ width: 32 });
  });

  it('evaluates constant expressions in bit ranges', () => {
    expect(widthOfDecl(makeDecl({ width: '[8-1:0]' }))).toEqual({ width: 8 });
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// shouldReportWidthMismatch
// ────────────────────────────────────────────────────────────────────────────────
describe('shouldReportWidthMismatch', () => {
  it('returns false when widths match', () => {
    expect(shouldReportWidthMismatch({ width: 32 }, { width: 32 })).toBe(false);
  });

  it('returns false when expected width is undefined', () => {
    expect(shouldReportWidthMismatch({}, { width: 32 })).toBe(false);
  });

  it('returns false when actual width is undefined', () => {
    expect(shouldReportWidthMismatch({ width: 32 }, {})).toBe(false);
  });

  it('returns false when both widths are undefined', () => {
    expect(shouldReportWidthMismatch({}, {})).toBe(false);
  });

  it('returns true when the value is wider than the target (truncation)', () => {
    expect(shouldReportWidthMismatch({ width: 16 }, { width: 32 })).toBe(true);
  });

  it('returns false when the value is narrower than the target (extension)', () => {
    expect(shouldReportWidthMismatch({ width: 32 }, { width: 16 })).toBe(false);
  });

  it('returns false when actual is flexible and fits', () => {
    expect(shouldReportWidthMismatch({ width: 32 }, { width: 32, minWidth: 1, flexible: true })).toBe(false);
  });

  it('returns true when actual is flexible but does not fit', () => {
    expect(shouldReportWidthMismatch({ width: 16 }, { width: 32, minWidth: 32, flexible: true })).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// widthOfExpression
// ────────────────────────────────────────────────────────────────────────────────
describe('widthOfExpression', () => {
  it('returns width of a declared identifier', () => {
    const module = makeModule({
      declarations: new Map([['sig', makeDecl({ name: 'sig', kind: 'wire', width: '[31:0]' })]])
    });
    expect(widthOfExpression('sig', module)).toEqual({ width: 32 });
  });

  it('returns empty for undeclared identifier', () => {
    expect(widthOfExpression('unknown', makeModule())).toEqual({});
  });

  it('returns width of sized literal', () => {
    expect(widthOfExpression("32'hFF", makeModule())).toEqual({ width: 32 });
  });

  it('returns width of unsized literal (IEEE: ≥32 bits, no flexibility)', () => {
    const result = widthOfExpression('42', makeModule());
    expect(result.width).toBe(32);
    expect(result.flexible).toBeUndefined();
  });

  it('returns width of concatenation', () => {
    const result = widthOfExpression('{a, b}', makeModule({
      declarations: new Map([
        ['a', makeDecl({ name: 'a', kind: 'wire', width: '[7:0]' })],
        ['b', makeDecl({ name: 'b', kind: 'wire', width: '[7:0]' })]
      ])
    }));
    expect(result).toEqual({ width: 16 });
  });

  it('returns width of replicated concatenation', () => {
    const result = widthOfExpression('{4{a}}', makeModule({
      declarations: new Map([['a', makeDecl({ name: 'a', kind: 'wire', width: '[7:0]' })]])
    }));
    expect(result).toEqual({ width: 32 });
  });

  it('returns integer width for clog2', () => {
    expect(widthOfExpression('$clog2(17)', makeModule())).toEqual({ width: 32 });
  });

  it('returns 1 for comparison operators', () => {
    const module = makeModule({
      declarations: new Map([
        ['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })],
        ['b', makeDecl({ name: 'b', kind: 'wire', width: '[31:0]' })]
      ])
    });
    expect(widthOfExpression('a == b', module)).toEqual({ width: 1 });
    expect(widthOfExpression('a != b', module)).toEqual({ width: 1 });
    expect(widthOfExpression('a < b', module)).toEqual({ width: 1 });
    expect(widthOfExpression('a && b', module)).toEqual({ width: 1 });
  });

  it('returns max width for binary arithmetic operators', () => {
    const module = makeModule({
      declarations: new Map([
        ['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })],
        ['b', makeDecl({ name: 'b', kind: 'wire', width: '[7:0]' })]
      ])
    });
    expect(widthOfExpression('a + b', module).width).toBe(32);
    expect(widthOfExpression('a - b', module).width).toBe(32);
    expect(widthOfExpression('a * b', module).width).toBe(32);
  });

  it('returns 1 for negation operator (!)', () => {
    const module = makeModule({
      declarations: new Map([['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })]])
    });
    expect(widthOfExpression('!a', module)).toEqual({ width: 1 });
  });

  it('preserves width for bitwise NOT (~)', () => {
    const module = makeModule({
      declarations: new Map([['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })]])
    });
    expect(widthOfExpression('~a', module)).toEqual({ width: 32 });
  });

  it('returns width of bit select (single bit)', () => {
    expect(widthOfExpression('a[3]', makeModule({
      declarations: new Map([['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })]])
    }))).toEqual({ width: 1 });
  });

  it('returns width of bit range select', () => {
    expect(widthOfExpression('a[7:0]', makeModule({
      declarations: new Map([['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })]])
    }))).toEqual({ width: 8 });
  });

  it('returns empty for empty expression', () => {
    expect(widthOfExpression('', makeModule())).toEqual({});
  });

  it('handles shift operators (flexible, natural width = left operand width)', () => {
    const module = makeModule({
      declarations: new Map([
        ['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })],
        ['b', makeDecl({ name: 'b', kind: 'wire', width: '[4:0]' })]
      ])
    });
    expect(widthOfExpression('a << b', module)).toEqual({ width: 32, minWidth: 32, flexible: true });
    expect(widthOfExpression('a >> b', module)).toEqual({ width: 32, minWidth: 32, flexible: true });
  });

  it('handles ternary operator (max of branches)', () => {
    const module = makeModule({
      declarations: new Map([
        ['cond', makeDecl({ name: 'cond', kind: 'wire', width: '[0:0]' })],
        ['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })],
        ['b', makeDecl({ name: 'b', kind: 'wire', width: '[7:0]' })]
      ])
    });
    expect(widthOfExpression('cond ? a : b', module).width).toBe(32);
  });

  it('handles constant expressions in indexed part-select widths', () => {
    const module = makeModule({
      declarations: new Map([['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })]])
    });
    expect(widthOfExpression('a[3 +: 2 + 2]', module)).toEqual({ width: 4 });
  });
});

describe('evalExpressionConstant', () => {
  it('evaluates system functions, concatenations, selects, and reductions', () => {
    const module = makeModule();
    expect(evalExpressionConstant('$clog2(17)', module)).toBe(5n);
    expect(evalExpressionConstant("{4'hA, 4'h5}", module)).toBe(0xA5n);
    expect(evalExpressionConstant("{2{2'b10}}", module)).toBe(0b1010n);
    expect(evalExpressionConstant("8'hA5[3:0]", module)).toBe(0x5n);
    expect(evalExpressionConstant("8'hA5[7:4]", module)).toBe(0xAn);
    expect(evalExpressionConstant('&4\'b1111', module)).toBe(1n);
    expect(evalExpressionConstant('^4\'b1011', module)).toBe(1n);
  });
});

describe('parseVerilogExpression', () => {
  it('builds an AST that preserves binary operator precedence', () => {
    const ast = parseVerilogExpression('a + b * c');
    expect(ast?.kind).toBe('binaryExpression');
    if (ast?.kind !== 'binaryExpression') {
      return;
    }
    expect(ast.operator).toBe('+');
    expect(ast.right.kind).toBe('binaryExpression');
    if (ast.right.kind === 'binaryExpression') {
      expect(ast.right.operator).toBe('*');
    }
  });

  it('builds right-nested conditional expressions', () => {
    const ast = parseVerilogExpression('add ? ADD : sub ? SUB : NOP');
    expect(ast?.kind).toBe('conditionalExpression');
    if (ast?.kind !== 'conditionalExpression') {
      return;
    }
    expect(ast.whenFalse.kind).toBe('conditionalExpression');
  });

  it('builds concatenation, replication and select nodes', () => {
    const ast = parseVerilogExpression("{{14{imm16[15]}}, imm16, 2'b00}");
    expect(ast?.kind).toBe('concatenation');
    if (ast?.kind !== 'concatenation') {
      return;
    }
    expect(ast.elements[0].kind).toBe('multipleConcatenation');
    if (ast.elements[0].kind === 'multipleConcatenation') {
      expect(ast.elements[0].elements[0].kind).toBe('selectExpression');
    }
  });

  it('keeps recoverable subtrees when an expression is missing the right operand', () => {
    const ast = parseVerilogExpression('a +');
    expect(ast?.kind).toBe('binaryExpression');
    expect(verilogExpressionHasError(ast)).toBe(true);

    if (ast?.kind !== 'binaryExpression') {
      return;
    }
    expect(ast.left.kind).toBe('identifier');
    expect(ast.right.kind).toBe('errorExpression');
    expect(ast.right.missing?.[0]?.kind).toBe('missingToken');

    const identifiers: string[] = [];
    walkVerilogExpression(ast, (expression) => {
      if (expression.kind === 'identifier') {
        identifiers.push(expression.name);
      }
    });
    expect(identifiers).toContain('a');
  });

  it('records missing delimiters without dropping the inner expression tree', () => {
    const ast = parseVerilogExpression('(a + b');
    expect(ast?.kind).toBe('parenthesizedExpression');
    expect(verilogExpressionHasError(ast)).toBe(true);

    if (ast?.kind !== 'parenthesizedExpression') {
      return;
    }
    expect(ast.missing?.[0]?.expected).toBe(')');
    expect(ast.expression.kind).toBe('binaryExpression');
  });

  it('attaches assignment expression ASTs to parsed statements', () => {
    const text = `
module m(input [3:0] a, input [3:0] b, input [3:0] c, output [7:0] y);
    assign y = a + b * c;
endmodule
`.trim();
    const parsed = parseVerilog(doc(text), mergeCoSettings({}), false);
    const statement = parsed.ast.modules[0].items.find((item) => item.kind === 'continuousAssign');
    expect(statement?.assignment?.rhs.kind).toBe('binaryExpression');
    if (statement?.assignment?.rhs.kind === 'binaryExpression') {
      expect(statement.assignment.rhs.operator).toBe('+');
    }
  });

  it('attaches procedural statement trees to parsed blocks', () => {
    const text = `
module m(input sel, input [1:0] op, input a, input b, input c, output reg y);
    integer i;
    always @(*) begin
        if (sel) begin
            y = a;
        end else begin
            case (op)
                2'b00: y = b;
                default: y = c;
            endcase
        end
    end
    initial begin
        for (i = 0; i < 4; i = i + 1) y = y;
    end
endmodule
`.trim();
    const parsed = parseVerilog(doc(text), mergeCoSettings({}), false);
    const moduleAst = parsed.ast.modules[0];
    expect(moduleAst.proceduralBlocks).toHaveLength(2);

    const alwaysTree = moduleAst.alwaysBlocks[0].statementTree;
    expect(alwaysTree.statements[0]?.kind).toBe('if');
    const ifStatement = alwaysTree.statements[0];
    if (ifStatement?.kind !== 'if') {
      return;
    }
    expect(ifStatement.condition?.kind).toBe('identifier');
    expect(ifStatement.consequent.kind).toBe('block');
    expect(ifStatement.alternate?.kind).toBe('block');
    if (ifStatement.alternate?.kind === 'block') {
      const caseStatement = ifStatement.alternate.statements[0];
      expect(caseStatement?.kind).toBe('case');
      if (caseStatement?.kind === 'case') {
        expect(caseStatement.expression?.kind).toBe('identifier');
        expect(caseStatement.items).toHaveLength(2);
        expect(caseStatement.items[0].body.kind).toBe('assignment');
      }
    }

    const initialBlock = moduleAst.proceduralBlocks.find((block) => block.kind === 'initial');
    expect(initialBlock?.statementTree.statements[0]?.kind).toBe('loop');
    if (initialBlock?.statementTree.statements[0]?.kind === 'loop') {
      expect(initialBlock.statementTree.statements[0].loopKind).toBe('for');
      expect(initialBlock.statementTree.statements[0].body.kind).toBe('assignment');
    }
  });

  it('parses procedural assignment lhs after delay controls and statement labels', () => {
    const text = `
module m(output reg clk, output reg y);
    initial begin
        forever #5 clk = ~clk;
        named: y <= clk;
    end
endmodule
`.trim();
    const parsed = parseVerilog(doc(text), mergeCoSettings({}), false);
    const tree = parsed.ast.modules[0].proceduralBlocks[0].statementTree;
    const loop = tree.statements[0];
    expect(loop?.kind).toBe('loop');
    if (loop?.kind === 'loop') {
      expect(loop.body.kind).toBe('assignment');
      if (loop.body.kind === 'assignment') {
        expect(loop.body.targets).toEqual(['clk']);
        expect(loop.body.hasDelayControl).toBe(true);
        expect(loop.body.hasEventControl).toBe(false);
        expect(loop.body.lhs?.kind).toBe('identifier');
        if (loop.body.lhs?.kind === 'identifier') {
          expect(loop.body.lhs.name).toBe('clk');
        }
      }
    }

    const labeled = tree.statements[1];
    expect(labeled?.kind).toBe('assignment');
    if (labeled?.kind === 'assignment') {
      expect(labeled.targets).toEqual(['y']);
      expect(labeled.hasDelayControl).toBe(false);
      expect(labeled.hasEventControl).toBe(false);
      expect(labeled.lhs?.kind).toBe('identifier');
      if (labeled.lhs?.kind === 'identifier') {
        expect(labeled.lhs.name).toBe('y');
      }
    }
  });

  it('attaches expression ASTs to procedural system task statements', () => {
    const text = `
module m(input [31:0] pc);
    initial begin
        $display("@%h", pc);
    end
endmodule
`.trim();
    const parsed = parseVerilog(doc(text), mergeCoSettings({}), false);
    const statement = parsed.ast.modules[0].proceduralBlocks[0].statementTree.statements[0];
    expect(statement?.kind).toBe('other');
    if (statement?.kind === 'other') {
      expect(statement.expression?.kind).toBe('callExpression');
      if (statement.expression?.kind === 'callExpression') {
        expect(statement.expression.callee).toBe('$display');
      }
    }
  });

  it('attaches expression ASTs to declaration initializers and instance connections', () => {
    const text = `
module child #(parameter WIDTH = 8)(input [WIDTH-1:0] din, output dout);
endmodule
module top(input [3:0] a, output y);
    localparam W = 2 + 2;
    wire [W-1:0] data = a + W;
    child #(.WIDTH(W)) u_child(.din(data[W-1:0]), .dout(y));
endmodule
`.trim();
    const document = doc(text);
    const parsed = parseVerilog(document, mergeCoSettings({}), false);
    const child = parsed.modules.find((module) => module.name === 'child');
    const top = parsed.modules.find((module) => module.name === 'top');
    expect(child?.declarations.get('WIDTH')?.initializerAst?.kind).toBe('numberLiteral');

    const localparam = top?.declarations.get('W');
    expect(localparam?.initializerAst?.kind).toBe('binaryExpression');
    if (localparam?.initializerAst) {
      const rangeText = document.getText({
        start: document.positionAt(localparam.initializerAst.start),
        end: document.positionAt(localparam.initializerAst.end)
      });
      expect(rangeText).toBe('2 + 2');
    }

    const data = top?.declarations.get('data');
    expect(data?.initializerAst?.kind).toBe('binaryExpression');
    if (data?.initializerAst) {
      const rangeText = document.getText({
        start: document.positionAt(data.initializerAst.start),
        end: document.positionAt(data.initializerAst.end)
      });
      expect(rangeText).toBe('a + W');
    }

    const instance = top?.instances[0];
    expect(instance?.parameterConnections[0].expressionAst?.kind).toBe('identifier');
    expect(instance?.portConnections[0].expressionAst?.kind).toBe('selectExpression');
    if (instance?.portConnections[0].expressionAst) {
      const rangeText = document.getText({
        start: document.positionAt(instance.portConnections[0].expressionAst.start),
        end: document.positionAt(instance.portConnections[0].expressionAst.end)
      });
      expect(rangeText).toBe('data[W-1:0]');
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// parseModules
// ────────────────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────────────────
// splitTopLevelCommas — additional edge cases
// ────────────────────────────────────────────────────────────────────────────────
describe('splitTopLevelCommas — edge cases', () => {
  it('handles deeply nested parentheses', () => {
    expect(splitTopLevelCommas('a((b, c), (d, e)), f')).toEqual(['a((b, c), (d, e))', ' f']);
  });

  it('handles strings with escaped quotes', () => {
    expect(splitTopLevelCommas('"a, \\"b\\"", c')).toEqual(['"a, \\"b\\""', ' c']);
  });

  it('handles empty segments between commas', () => {
    const result = splitTopLevelCommas('a,,b');
    expect(result).toHaveLength(3);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// stripCommentsAndStrings — additional edge cases
// ────────────────────────────────────────────────────────────────────────────────
describe('stripCommentsAndStrings — edge cases', () => {
  it('handles multiple block comments on the same line', () => {
    const input = '/* a */wire;/* b */';
    const result = stripCommentsAndStrings(input);
    expect(result).toContain('wire;');
    expect(result).not.toContain('a');
    expect(result).not.toContain('b');
  });

  it('handles block comment spanning multiple lines', () => {
    const input = 'wire a;\n/* comment\nstill comment */\nwire b;';
    const result = stripCommentsAndStrings(input);
    expect(result).toContain('wire a;');
    expect(result).toContain('wire b;');
    expect(result).not.toContain('still comment');
  });

  it('handles string containing comment-like characters', () => {
    const input = '"/* not a comment */"';
    const result = stripCommentsAndStrings(input);
    expect(result).not.toContain('comment');
    expect(result.length).toBe(input.length);
  });

  it('preserves code outside comments and strings', () => {
    const input = 'wire a; // comment\nwire b;';
    const result = stripCommentsAndStrings(input);
    expect(result).toContain('wire a;');
    expect(result).toContain('wire b;');
  });

  it('handles empty input', () => {
    expect(stripCommentsAndStrings('')).toBe('');
  });

  it('handles input with only whitespace', () => {
    expect(stripCommentsAndStrings('   \n  ')).toBe('   \n  ');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// widthOfExpression — additional edge cases
// ────────────────────────────────────────────────────────────────────────────────
describe('widthOfExpression — edge cases', () => {
  it('handles parentheses wrapping', () => {
    const module = makeModule({
      declarations: new Map([['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })]])
    });
    expect(widthOfExpression('(a)', module).width).toBe(32);
    expect(widthOfExpression('((a))', module).width).toBe(32);
  });

  it('handles sized binary literal', () => {
    expect(widthOfExpression("8'b10101010", makeModule()).width).toBe(8);
  });

  it('handles sized hex literal', () => {
    expect(widthOfExpression("16'hFF00", makeModule()).width).toBe(16);
  });

  it('handles unsized zero (IEEE strict: no flexibility)', () => {
    const result = widthOfExpression('0', makeModule());
    expect(result.width).toBe(32);
    expect(result.flexible).toBeUndefined();
  });

  it('handles unsized one (IEEE strict: no flexibility)', () => {
    const result = widthOfExpression('1', makeModule());
    expect(result.width).toBe(32);
    expect(result.flexible).toBeUndefined();
  });

  it('handles reduction operators', () => {
    const module = makeModule({
      declarations: new Map([['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })]])
    });
    expect(widthOfExpression('&a', module).width).toBe(1);
    expect(widthOfExpression('|a', module).width).toBe(1);
    expect(widthOfExpression('^a', module).width).toBe(1);
  });

  it('handles nested concatenation', () => {
    const module = makeModule({
      declarations: new Map([
        ['a', makeDecl({ name: 'a', kind: 'wire', width: '[7:0]' })],
        ['b', makeDecl({ name: 'b', kind: 'wire', width: '[3:0]' })]
      ])
    });
    expect(widthOfExpression('{a, {b, b}}', module).width).toBe(16);
  });

  it('handles case equality operators (===, !==)', () => {
    const module = makeModule({
      declarations: new Map([
        ['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })],
        ['b', makeDecl({ name: 'b', kind: 'wire', width: '[31:0]' })]
      ])
    });
    expect(widthOfExpression('a === b', module)).toEqual({ width: 1 });
    expect(widthOfExpression('a !== b', module)).toEqual({ width: 1 });
  });

  it('handles XNOR binary operators (~^, ^~)', () => {
    const module = makeModule({
      declarations: new Map([
        ['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })],
        ['b', makeDecl({ name: 'b', kind: 'wire', width: '[7:0]' })]
      ])
    });
    expect(widthOfExpression('a ~^ b', module)).toEqual({ width: 32, minWidth: 32, flexible: true });
    expect(widthOfExpression('a ^~ b', module)).toEqual({ width: 32, minWidth: 32, flexible: true });
  });

  it('handles power operator (**)', () => {
    const module = makeModule({
      declarations: new Map([
        ['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })],
        ['b', makeDecl({ name: 'b', kind: 'wire', width: '[4:0]' })]
      ])
    });
    expect(widthOfExpression('a ** b', module)).toEqual({ width: 32, minWidth: 32, flexible: true });
  });

  it('handles reduction NAND, NOR, XNOR operators (~&, ~|, ~^, ^~)', () => {
    const module = makeModule({
      declarations: new Map([['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })]])
    });
    expect(widthOfExpression('~&a', module).width).toBe(1);
    expect(widthOfExpression('~|a', module).width).toBe(1);
    expect(widthOfExpression('~^a', module).width).toBe(1);
    expect(widthOfExpression('^~a', module).width).toBe(1);
  });

  it('handles indexed part selects (+:, -:)', () => {
    const module = makeModule({
      declarations: new Map([['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })]])
    });
    expect(widthOfExpression('a[3+:4]', module)).toEqual({ width: 4 });
    expect(widthOfExpression('a[7-:8]', module)).toEqual({ width: 8 });
  });

  it('handles indexed part selects with spaces (+:, -:)', () => {
    const module = makeModule({
      declarations: new Map([['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })]])
    });
    expect(widthOfExpression('a[3 +: 4]', module)).toEqual({ width: 4 });
    expect(widthOfExpression('a[7 -: 8]', module)).toEqual({ width: 8 });
    expect(widthOfExpression('a[3 + : 4]', module)).toEqual({ width: 4 });
    expect(widthOfExpression('a[7 - : 8]', module)).toEqual({ width: 8 });
  });

  it('handles $signed and $unsigned pass-through width', () => {
    const module = makeModule({
      declarations: new Map([['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })]])
    });
    expect(widthOfExpression('$signed(a)', module)).toEqual({ width: 32 });
    expect(widthOfExpression('$unsigned(a)', module)).toEqual({ width: 32 });
  });

  it('handles $signed/$unsigned in arithmetic expressions', () => {
    const module = makeModule({
      declarations: new Map([
        ['a', makeDecl({ name: 'a', kind: 'wire', width: '[31:0]' })],
        ['b', makeDecl({ name: 'b', kind: 'wire', width: '[31:0]' })]
      ])
    });
    // $signed(a) * $signed(b) — both 32-bit operands, result flexible max=32
    expect(widthOfExpression('$signed(a) * $signed(b)', module)).toEqual({ width: 32, minWidth: 32, flexible: true });
    // $signed(a) / $signed(b) — division
    expect(widthOfExpression('$signed(a) / $signed(b)', module)).toEqual({ width: 32, minWidth: 32, flexible: true });
    // $signed(a) % $signed(b) — modulo
    expect(widthOfExpression('$signed(a) % $signed(b)', module)).toEqual({ width: 32, minWidth: 32, flexible: true });
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// parseModules — additional edge cases
// ────────────────────────────────────────────────────────────────────────────────
describe('parseModules — edge cases', () => {
  it('parses a simple module', () => {
    const text = 'module test(input clk, output [31:0] data); endmodule';
    const d = doc(text);
    const modules = parseModules(d, text);
    expect(modules).toHaveLength(1);
    expect(modules[0].name).toBe('test');
    expect(modules[0].hasEndmodule).toBe(true);
  });

  it('parses multiple modules', () => {
    const text = 'module a(); endmodule module b(); endmodule';
    const d = doc(text);
    const modules = parseModules(d, text);
    expect(modules).toHaveLength(2);
    expect(modules[0].name).toBe('a');
    expect(modules[1].name).toBe('b');
  });

  it('detects missing endmodule', () => {
    const text = 'module test(input clk);';
    const d = doc(text);
    const modules = parseModules(d, text);
    expect(modules).toHaveLength(1);
    expect(modules[0].hasEndmodule).toBe(false);
  });

  it('parses module with parameters', () => {
    const text = 'module test #(parameter WIDTH = 32)(input clk); endmodule';
    const d = doc(text);
    const modules = parseModules(d, text);
    expect(modules[0].parameters).toHaveLength(1);
    expect(modules[0].parameters[0].name).toBe('WIDTH');
  });

  it('parses nested expressions in parameterized module headers', () => {
    const text = `
module fifo #(
    parameter DEPTH = 16,
    parameter AW = $clog2(DEPTH)
)(
    input [AW-1:0] addr,
    output [DEPTH-1:0] data
);
endmodule
`.trim();
    const d = doc(text);
    const modules = parseModules(d, text);

    expect(modules).toHaveLength(1);
    expect(modules[0].parameters.map((param) => param.name)).toEqual(['DEPTH', 'AW']);
    expect(modules[0].ports.map((port) => port.name)).toEqual(['addr', 'data']);
  });

  it('infers parameter widths from sized literal initializers', () => {
    const text = `
module test #(parameter OP = 6'b000000)(input add, input sub, output [5:0] type);
    parameter ADD = 6'b100000, SUB = 6'b100010, NOP = 6'b000000;
    assign type = add ? ADD : sub ? SUB : NOP;
endmodule
`.trim();
    const d = doc(text);
    const module = parseModules(d, text)[0];

    expect(module.declarations.get('OP')?.inferredWidth).toBe(6);
    expect(module.declarations.get('ADD')?.inferredWidth).toBe(6);
    expect(widthOfExpression('add ? ADD : sub ? SUB : NOP', module).width).toBe(6);
  });

  it('evaluates dependent parameter constants for declaration widths', () => {
    const text = `
module test;
    parameter WIDTH = 8;
    localparam BUS_MSB = WIDTH - 1;
    wire [BUS_MSB:0] data;
endmodule
`.trim();
    const d = doc(text);
    const module = parseModules(d, text)[0];

    expect(module.declarations.get('WIDTH')?.constantValue).toBe(8n);
    expect(module.declarations.get('BUS_MSB')?.constantValue).toBe(7n);
    expect(widthOfDecl(module.declarations.get('data')!, module)).toEqual({ width: 8 });
  });

  it('evaluates clog2, concatenation, and selects in parameter constants', () => {
    const text = `
module test;
    parameter DEPTH = 17;
    parameter A = 4'hA, B = 4'h5;
    localparam AW = $clog2(DEPTH);
    localparam PACK = {A, B};
    localparam LOW = PACK[3:0];
    localparam REPL = {2{2'b10}};
    wire [AW-1:0] addr;
    wire [LOW:0] low_bus;
endmodule
`.trim();
    const module = parseModules(doc(text), text)[0];

    expect(module.declarations.get('AW')?.constantValue).toBe(5n);
    expect(module.declarations.get('PACK')?.constantValue).toBe(0xA5n);
    expect(module.declarations.get('LOW')?.constantValue).toBe(5n);
    expect(module.declarations.get('REPL')?.constantValue).toBe(0b1010n);
    expect(widthOfDecl(module.declarations.get('addr')!, module)).toEqual({ width: 5 });
    expect(widthOfDecl(module.declarations.get('low_bus')!, module)).toEqual({ width: 6 });
  });

  it('treats unsized parameter literals as fixed-width (IEEE strict)', () => {
    const text = `
module test(input add, output [5:0] type);
    parameter ADD = 6'b100000, NOP = 0;
    assign type = add ? ADD : NOP;
endmodule
`.trim();
    const d = doc(text);
    const module = parseModules(d, text)[0];
    const result = widthOfExpression('add ? ADD : NOP', module);

    // NOP = 0 → unsized literal → width ≥32, non-flexible per IEEE
    expect(module.declarations.get('NOP')?.inferredFlexible).toBeUndefined();
    // Ternary: max(6, 32) = 32, minWidth = max(6, 1) = 6
    expect(result.width).toBe(32);
    expect(result.minWidth).toBe(6);
    expect(result.flexible).toBeUndefined();
  });

  it('parses module ports from header', () => {
    const text = 'module test(input clk, input reset, output [31:0] data); endmodule';
    const d = doc(text);
    const modules = parseModules(d, text);
    expect(modules[0].ports).toHaveLength(3);
    expect(modules[0].ports[0].name).toBe('clk');
    expect(modules[0].ports[0].direction).toBe('input');
    expect(modules[0].ports[2].name).toBe('data');
    expect(modules[0].ports[2].direction).toBe('output');
  });

  it('parses body declarations', () => {
    const text = 'module test(input clk);\nwire a;\nreg [7:0] b;\nendmodule';
    const d = doc(text);
    const modules = parseModules(d, text);
    expect(modules[0].declarations.has('a')).toBe(true);
    expect(modules[0].declarations.has('b')).toBe(true);
    expect(modules[0].declarations.get('b')?.width).toBe('[7:0]');
  });

  it('parses declarations that follow procedural blocks', () => {
    const text = `
module test(input clk, input reset, input w_grf_we, input [4:0] w_grf_addr, input [31:0] w_inst_addr, input [31:0] w_grf_wdata);
    always @(posedge clk) begin
        if (~reset) begin
            if (w_grf_we && (w_grf_addr != 0)) begin
                $display("%d@%h: $%d <= %h", $time, w_inst_addr, w_grf_addr, w_grf_wdata);
            end
        end
    end

    wire [31:0] fixed_macroscopic_pc;
endmodule
`.trim();
    const d = doc(text);
    const modules = parseModules(d, text);
    expect(modules[0].declarations.get('fixed_macroscopic_pc')?.width).toBe('[31:0]');
  });

  it('parses instances', () => {
    const text = 'module test(input clk);\nsub u_sub(.clk(clk));\nendmodule';
    const d = doc(text);
    const modules = parseModules(d, text);
    expect(modules[0].instances).toHaveLength(1);
    expect(modules[0].instances[0].moduleName).toBe('sub');
    expect(modules[0].instances[0].instanceName).toBe('u_sub');
  });

  it('does not confuse the current module name with an instance', () => {
    const text = 'module test(input clk);\ntest u_self(.clk(clk));\nendmodule';
    const d = doc(text);
    const modules = parseModules(d, text);
    expect(modules[0].instances).toHaveLength(0);
  });

  it('handles empty module body', () => {
    const text = 'module empty(); endmodule';
    const d = doc(text);
    const modules = parseModules(d, text);
    expect(modules).toHaveLength(1);
    expect(modules[0].name).toBe('empty');
  });

  it('handles module with comments stripped', () => {
    const text = 'module test(/* comment */ input clk); // line comment\nendmodule';
    const d = doc(text);
    const modules = parseModules(d, text);
    expect(modules).toHaveLength(1);
    expect(modules[0].ports).toHaveLength(1);
  });

  it('parses instances whose module name matches a system task name', () => {
    const text = 'module top(input [3:0] val);\ndisplay u(.val(val));\nendmodule';
    const d = doc(text);
    const modules = parseModules(d, text);
    expect(modules[0].instances).toHaveLength(1);
    expect(modules[0].instances[0].moduleName).toBe('display');
    expect(modules[0].instances[0].instanceName).toBe('u');
  });

  it('parses instances whose module name is a Verilog keyword', () => {
    const text = 'module top(input a);\nsmall u_small(.a(a));\nendmodule';
    const d = doc(text);
    const modules = parseModules(d, text);
    expect(modules[0].instances).toHaveLength(1);
    expect(modules[0].instances[0].moduleName).toBe('small');
  });

  it('parses instances nested inside generate blocks', () => {
    const text = [
      'module top;',
      '  generate',
      '    if (USE) begin : g',
      '      sub u_sub(.a(a));',
      '    end',
      '  endgenerate',
      'endmodule'
    ].join('\n');
    const d = doc(text);
    const modules = parseModules(d, text);
    expect(modules[0].instances).toHaveLength(1);
    expect(modules[0].instances[0].moduleName).toBe('sub');
    expect(modules[0].instances[0].instanceName).toBe('u_sub');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// parseMacros
// ────────────────────────────────────────────────────────────────────────────────
describe('parseMacros', () => {
  it('parses a single macro definition', () => {
    const text = '`define WIDTH 32';
    const d = doc(text);
    const macros = parseMacros(d, text);
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('WIDTH');
  });

  it('parses multiple macro definitions', () => {
    const text = '`define A 1\n`define B 2';
    const d = doc(text);
    const macros = parseMacros(d, text);
    expect(macros).toHaveLength(2);
    expect(macros[0].name).toBe('A');
    expect(macros[1].name).toBe('B');
  });

  it('returns empty array when no macros', () => {
    const text = 'module test(); endmodule';
    const d = doc(text);
    expect(parseMacros(d, text)).toHaveLength(0);
  });

  it('ignores defines inside comments', () => {
    const text = '// `define COMMENTED\n`define ACTIVE 1';
    const d = doc(text);
    const macros = parseMacros(d, text);
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('ACTIVE');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// parseMacroUses
// ────────────────────────────────────────────────────────────────────────────────
describe('parseMacroUses', () => {
  it('finds macro uses', () => {
    const text = '`define W 32\nwire [`W-1:0] data;';
    const d = doc(text);
    const macros = parseMacros(d, text);
    const uses = parseMacroUses(d, text, macros);
    expect(uses).toHaveLength(1);
    expect(uses[0].name).toBe('W');
  });

  it('does not count macro definitions as uses', () => {
    const text = '`define W 32';
    const d = doc(text);
    const macros = parseMacros(d, text);
    const uses = parseMacroUses(d, text, macros);
    expect(uses).toHaveLength(0);
  });

  it('ignores preprocessor directives', () => {
    const text = '`ifdef SOMETHING\n`endif';
    const d = doc(text);
    const uses = parseMacroUses(d, text, []);
    expect(uses).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// parseIncludes
// ────────────────────────────────────────────────────────────────────────────────
describe('parseIncludes', () => {
  it('parses include paths and keeps their ranges', () => {
    const text = '`include "defines.v"';
    const d = doc(text);
    const includes = parseIncludes(d, text);
    expect(includes).toHaveLength(1);
    expect(includes[0].path).toBe('defines.v');
    expect(d.getText(includes[0].pathRange)).toBe('defines.v');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// parseDirectives
// ────────────────────────────────────────────────────────────────────────────────
describe('parseDirectives', () => {
  it('parses preprocessor directive arguments and ranges', () => {
    const text = '`default_nettype none\nmodule demo; endmodule';
    const d = doc(text);
    const directives = parseDirectives(d, text);
    const defaultNettype = directives.find((directive) => directive.name === 'default_nettype');
    expect(defaultNettype?.argument).toBe('none');
    expect(defaultNettype?.argumentRange ? d.getText(defaultNettype.argumentRange) : undefined).toBe('none');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// moduleAtPosition
// ────────────────────────────────────────────────────────────────────────────────
describe('moduleAtPosition', () => {
  it('finds the module containing the position', () => {
    const text = 'module a(); endmodule\nmodule b(); endmodule';
    const d = doc(text);
    const modules = parseModules(d, text);
    expect(moduleAtPosition(modules, { line: 0, character: 10 })).toBe(modules[0]);
    expect(moduleAtPosition(modules, { line: 1, character: 10 })).toBe(modules[1]);
  });

  it('returns undefined when position is outside all modules', () => {
    const text = 'module a(); endmodule';
    const d = doc(text);
    const modules = parseModules(d, text);
    expect(moduleAtPosition(modules, { line: 5, character: 0 })).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// buildTestbench
// ────────────────────────────────────────────────────────────────────────────────
describe('buildTestbench', () => {
  it('generates a basic testbench', () => {
    const module = makeModule({
      name: 'alu',
      ports: [
        makeDecl({ name: 'a', kind: 'input', direction: 'input', width: '[31:0]' }),
        makeDecl({ name: 'b', kind: 'input', direction: 'input', width: '[31:0]' }),
        makeDecl({ name: 'out', kind: 'output', direction: 'output', width: '[31:0]' })
      ]
    });
    const tb = buildTestbench(module, 'alu_tb');
    expect(tb).toContain('module alu_tb');
    expect(tb).toContain('.a(a)');
    expect(tb).toContain('.b(b)');
    expect(tb).toContain('.out(out)');
    expect(tb).toContain('endmodule');
    expect(tb).toContain('$finish');
  });

  it('generates clock for modules with clk port', () => {
    const module = makeModule({
      name: 'cpu',
      ports: [
        makeDecl({ name: 'clk', kind: 'input', direction: 'input' }),
        makeDecl({ name: 'reset', kind: 'input', direction: 'input' })
      ]
    });
    const tb = buildTestbench(module, 'cpu_tb');
    expect(tb).toContain('forever #5 clk = ~clk');
    expect(tb).toContain('reset');
    expect(tb).toContain('$finish');
  });

  it('handles module with no ports', () => {
    const module = makeModule({ name: 'empty', ports: [] });
    const tb = buildTestbench(module, 'empty_tb');
    expect(tb).toContain('module empty_tb');
    expect(tb).toContain('endmodule');
  });

  it('generates reset logic for modules with reset port', () => {
    const module = makeModule({
      name: 'm',
      ports: [
        makeDecl({ name: 'clk', kind: 'input', direction: 'input' }),
        makeDecl({ name: 'reset', kind: 'input', direction: 'input' })
      ]
    });
    const tb = buildTestbench(module, 'm_tb');
    expect(tb).toContain("reset = 1'b1");
    expect(tb).toContain("reset = 1'b0");
  });

  it('uses the configured finish delay when generating a testbench', () => {
    const module = makeModule({
      name: 'm',
      ports: [
        makeDecl({ name: 'clk', kind: 'input', direction: 'input' })
      ]
    });
    const tb = buildTestbench(module, 'm_tb', { finishDelay: '400000' });
    expect(tb).toContain('        #400000;');
    expect(tb).toContain('        $finish;');
  });

  it('generates external memory wiring for P6-style CPU interfaces', () => {
    const module = makeModule({
      name: 'mips',
      ports: [
        makeDecl({ name: 'clk', kind: 'input', direction: 'input' }),
        makeDecl({ name: 'reset', kind: 'input', direction: 'input' }),
        makeDecl({ name: 'i_inst_addr', kind: 'output', direction: 'output', width: '[31:0]' }),
        makeDecl({ name: 'i_inst_rdata', kind: 'input', direction: 'input', width: '[31:0]' }),
        makeDecl({ name: 'm_data_addr', kind: 'output', direction: 'output', width: '[31:0]' }),
        makeDecl({ name: 'm_data_rdata', kind: 'input', direction: 'input', width: '[31:0]' }),
        makeDecl({ name: 'm_data_wdata', kind: 'output', direction: 'output', width: '[31:0]' }),
        makeDecl({ name: 'm_data_byteen', kind: 'output', direction: 'output', width: '[3:0]' }),
        makeDecl({ name: 'm_inst_addr', kind: 'output', direction: 'output', width: '[31:0]' }),
        makeDecl({ name: 'w_grf_we', kind: 'output', direction: 'output' }),
        makeDecl({ name: 'w_grf_addr', kind: 'output', direction: 'output', width: '[4:0]' }),
        makeDecl({ name: 'w_grf_wdata', kind: 'output', direction: 'output', width: '[31:0]' }),
        makeDecl({ name: 'w_inst_addr', kind: 'output', direction: 'output', width: '[31:0]' })
      ]
    });
    const tb = buildTestbench(module, 'mips_tb');
    expect(tb).toContain('wire [31:0] i_inst_rdata;');
    expect(tb).toContain('reg [31:0] data[0:4095];');
    expect(tb).toContain('reg [31:0] fixed_addr;');
    expect(tb).toContain('reg [31:0] fixed_wdata;');
    expect(tb).toContain('$readmemh("code.txt", inst);');
    expect(tb).toContain('for (i = 0; i < 4096; i = i + 1) begin');
    expect(tb).toContain('data[i] <= 0;');
    expect(tb).toContain('assign i_inst_rdata = inst[(i_inst_addr - 32\'h3000) >> 2];');
    expect(tb).toContain('assign m_data_rdata = data[m_data_addr >> 2];');
    expect(tb).toContain('fixed_wdata = data[m_data_addr >> 2];');
    expect(tb).toContain('data[fixed_addr >> 2] <= fixed_wdata;');
    expect(tb).toContain('$display("%d@%h: *%h <= %h", $time, m_inst_addr, fixed_addr, fixed_wdata);');
    expect(tb).toContain('$display("%d@%h: $%d <= %h", $time, w_inst_addr, w_grf_addr, w_grf_wdata);');
    expect(tb).toContain('always #2 clk <= ~clk;');
    expect(tb).not.toContain('$finish;');
  });

  it('generates P7 normal official-style external memory wiring', () => {
    const module = makeModule({
      name: 'mips',
      ports: [
        makeDecl({ name: 'clk', kind: 'input', direction: 'input' }),
        makeDecl({ name: 'reset', kind: 'input', direction: 'input' }),
        makeDecl({ name: 'interrupt', kind: 'input', direction: 'input' }),
        makeDecl({ name: 'macroscopic_pc', kind: 'output', direction: 'output', width: '[31:0]' }),
        makeDecl({ name: 'i_inst_addr', kind: 'output', direction: 'output', width: '[31:0]' }),
        makeDecl({ name: 'i_inst_rdata', kind: 'input', direction: 'input', width: '[31:0]' }),
        makeDecl({ name: 'm_data_addr', kind: 'output', direction: 'output', width: '[31:0]' }),
        makeDecl({ name: 'm_data_rdata', kind: 'input', direction: 'input', width: '[31:0]' }),
        makeDecl({ name: 'm_data_wdata', kind: 'output', direction: 'output', width: '[31:0]' }),
        makeDecl({ name: 'm_data_byteen', kind: 'output', direction: 'output', width: '[3:0]' }),
        makeDecl({ name: 'm_int_addr', kind: 'output', direction: 'output', width: '[31:0]' }),
        makeDecl({ name: 'm_int_byteen', kind: 'output', direction: 'output', width: '[3:0]' }),
        makeDecl({ name: 'm_inst_addr', kind: 'output', direction: 'output', width: '[31:0]' }),
        makeDecl({ name: 'w_grf_we', kind: 'output', direction: 'output' }),
        makeDecl({ name: 'w_grf_addr', kind: 'output', direction: 'output', width: '[4:0]' }),
        makeDecl({ name: 'w_grf_wdata', kind: 'output', direction: 'output', width: '[31:0]' }),
        makeDecl({ name: 'w_inst_addr', kind: 'output', direction: 'output', width: '[31:0]' })
      ]
    });
    const tb = buildTestbench(module, 'mips_tb');
    expect(tb).toContain('`timescale 1ns/1ps');
    expect(tb).toContain('module mips_tb;');
    expect(tb).toContain('mips uut(');
    expect(tb).toContain('reg interrupt;');
    expect(tb).toContain('interrupt <= 0;');
    expect(tb).toContain('reg [31:0] inst[0:5119];');
    expect(tb).toContain('for (i = 0; i < 5120; i = i + 1) data[i] <= 0;');
    expect(tb).toContain('assign i_inst_rdata = inst[((i_inst_addr - 32\'h3000) >> 2) % 5120];');
    expect(tb).toContain('assign m_data_rdata = data[(m_data_addr >> 2) % 5120];');
    expect(tb).toContain('fixed_wdata = data[(m_data_addr >> 2) & 4095];');
    expect(tb).toContain('else if (|m_data_byteen && fixed_addr >> 2 < 4096) begin');
    expect(tb).toContain('// ----------- For Interrupt -----------');
    expect(tb).toContain("// parameter target_pc = 32'h00003010;");
    expect(tb).toMatch(/\/\/\s+if \(\|m_int_byteen && \(m_int_addr & 32'hfffffffc\) == 32'h7f20\) begin/);
    expect(tb).toMatch(/\/\/\s+interrupt = 1;/);
    expect(tb).not.toMatch(/^\s*parameter\s+target_pc\b/m);
    expect(tb).not.toMatch(/^\s*always\s+@\(negedge clk\)\s+begin/m);
    expect(tb).not.toContain('$finish;');
  });

  it('uses the P7 official testbench when the profile is P7', () => {
    const module = makeModule({
      name: 'mips',
      ports: [
        makeDecl({ name: 'clk', kind: 'input', direction: 'input' }),
        makeDecl({ name: 'reset', kind: 'input', direction: 'input' })
      ]
    });
    const tb = buildTestbench(module, 'mips_tb', { profile: 'P7' });

    expect(tb).toContain('wire [31:0] macroscopic_pc;');
    expect(tb).toContain('.interrupt(interrupt),');
    expect(tb).toContain('reg [31:0] inst[0:5119];');
    expect(tb).toContain('always #2 clk <= ~clk;');
  });

  it('activates the interrupt block with the scheduled target_pc when given a schedule', () => {
    const module = makeModule({
      name: 'mips',
      ports: [
        makeDecl({ name: 'clk', kind: 'input', direction: 'input' }),
        makeDecl({ name: 'reset', kind: 'input', direction: 'input' })
      ]
    });
    const tb = buildTestbench(module, 'mips_tb', { profile: 'P7', interruptSchedule: [0x3010] });

    // The interrupt block is now active (uncommented) with the scheduled target_pc.
    expect(tb).toMatch(/^\s*parameter target_pc = 32'h00003010;/m);
    expect(tb).toMatch(/^\s*always @\(negedge clk\) begin/m);
    expect(tb).toMatch(/^\s*assign fixed_macroscopic_pc = macroscopic_pc & 32'hfffffffc;/m);
    expect(tb).toMatch(/^\s*if \(\|m_int_byteen && \(m_int_addr & 32'hfffffffc\) == 32'h7f20\) begin/m);
    expect(tb).toMatch(/^\s*interrupt = 1;/m);
    // No leftover commented interrupt scaffolding for the parameter line.
    expect(tb).not.toContain("// parameter target_pc = 32'h00003010;");
  });

  it('generates a black-box P7 probe testbench without hierarchical reads', () => {
    const module = makeModule({
      name: 'mips',
      ports: [
        makeDecl({ name: 'clk', kind: 'input', direction: 'input' }),
        makeDecl({ name: 'reset', kind: 'input', direction: 'input' })
      ]
    });
    const tb = buildTestbench(module, 'mips_tb', {
      profile: 'P7',
      p7Probe: {
        scenarios: [
          { id: 1, kind: 'external', waitPc: 0x3020, armAddress: 0x27d0, armValue: 1, externalDelayCycles: 4 },
          { id: 2, kind: 'timer0', waitPc: 0x3040 }
        ]
      }
    });

    expect(tb).toContain('CO_P7_PROBE external_raise');
    expect(tb).toContain('CO_P7_PROBE external_arm');
    expect(tb).toContain('CO_P7_PROBE external_ack');
    expect(tb).toContain("co_p7_external_target = 32'h00003020;");
    expect(tb).toContain("co_p7_external_arm_addr = 32'h000027d0;");
    expect(tb).toContain('co_p7_external_armed && fixed_macroscopic_pc == co_p7_external_target');
    expect(tb).not.toContain('uut.');
  });
});
