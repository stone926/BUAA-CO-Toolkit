import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { FormattingOptions } from 'vscode-languageserver/node';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogFormattingEdits } from '../../../language/verilog/formatting';

function doc(text: string): TextDocument {
  return TextDocument.create('test://format.v', 'verilog', 1, text);
}

const twoSpaceFormatting: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2
};

function format(text: string, settings = mergeCoSettings({}), options = twoSpaceFormatting): string {
  const document = doc(text);
  const edit = getVerilogFormattingEdits(document, settings, options)[0];
  return edit?.newText ?? text;
}

describe('Verilog formatting', () => {
  it('formats with the default BUAA CO course style', () => {
    const input = [
      'module demo(',
      'input [31:0] a,',
      'output reg [3:0] y',
      ');',
      'always@(posedge clk) begin',
      'if(a==1) begin',
      "y<=4'b0;",
      'end else begin',
      'y<=a+1;',
      'end',
      'end',
      'endmodule'
    ].join('\n');

    expect(format(input)).toBe([
      'module demo (',
      '    input [31: 0] a,',
      '    output reg [3: 0] y',
      '  );',
      '  always @(posedge clk) begin',
      '    if (a == 1) begin',
      "      y <= 4'b0;",
      '    end',
      '    else begin',
      '      y <= a + 1;',
      '    end',
      '  end',
      'endmodule'
    ].join('\n'));
  });

  it('honors custom style settings', () => {
    const settings = mergeCoSettings({
      verilog: {
        format: {
          style: 'custom',
          continuationIndent: 1,
          spaceInRange: false,
          spaceBeforeInstancePorts: false,
          separateElse: false,
          maxBlankLines: 0
        }
      }
    });
    const input = [
      'module demo(',
      'input [31 : 0] a',
      ');',
      '',
      'Sub u_sub (',
      '.a(a)',
      ');',
      'always @ (posedge clk) begin',
      'if (a != 0) begin',
      'end else begin',
      'end',
      'end',
      'endmodule'
    ].join('\n');

    expect(format(input, settings, { insertSpaces: true, tabSize: 4 })).toBe([
      'module demo (',
      '    input [31:0] a',
      '    );',
      '    Sub u_sub(',
      '        .a(a)',
      '        );',
      '    always @(posedge clk) begin',
      '        if (a != 0) begin',
      '        end else begin',
      '        end',
      '    end',
      'endmodule'
    ].join('\n'));
  });

  it('does not rewrite operators inside string literals or line comments', () => {
    const input = [
      'module tb;',
      '$display("a<=b // keep"); // a<=b',
      'endmodule'
    ].join('\n');

    expect(format(input)).toContain('$display("a<=b // keep"); // a<=b');
  });

  it('formats wildcard always blocks as always @(*)', () => {
    expect(format('module demo;\nalways@( * ) begin\nend\nendmodule')).toContain('always @(*) begin');
  });

  it('formats declaration range bracket spacing by default', () => {
    const input = [
      'module demo;',
      'input[1:0]a;',
      'output reg[3 :0]y;',
      'wire[7:0]w;',
      'endmodule'
    ].join('\n');

    expect(format(input)).toBe([
      'module demo;',
      '  input [1: 0] a;',
      '  output reg [3: 0] y;',
      '  wire [7: 0] w;',
      'endmodule'
    ].join('\n'));
  });

  it('supports compact and preserved declaration range bracket spacing', () => {
    const compact = mergeCoSettings({
      verilog: {
        format: {
          style: 'custom',
          spaceInRange: false,
          declarationRangeSpacing: 'compact'
        }
      }
    });
    expect(format('module demo;\ninput [1 : 0] a;\nendmodule', compact)).toBe([
      'module demo;',
      '  input[1:0]a;',
      'endmodule'
    ].join('\n'));

    const preserve = mergeCoSettings({
      verilog: {
        format: {
          style: 'custom',
          spaceInRange: false,
          declarationRangeSpacing: 'preserve'
        }
      }
    });
    expect(format('module demo;\ninput[1 : 0]a;\noutput reg   [3 : 0]   y;\nendmodule', preserve)).toBe([
      'module demo;',
      '  input[1:0]a;',
      '  output reg   [3:0]   y;',
      'endmodule'
    ].join('\n'));
  });

  it('normalizes line comment slash spacing', () => {
    const input = [
      '//abc',
      '////sth////',
      'module demo;',
      'assign a=b;////inline////',
      'endmodule'
    ].join('\n');

    expect(format(input)).toBe([
      '// abc',
      '//// sth ////',
      'module demo;',
      '  assign a = b; //// inline ////',
      'endmodule'
    ].join('\n'));
  });

  it('indents case item bodies one level and spaces same-line case item colons', () => {
    const input = [
      'module demo;',
      'case(PC_slt)',
      'ADD4:',
      "PC_reg<=PC_reg+32'd4;",
      'RA:PC_reg<=ra;',
      'IMM26://absolute jump',
      "PC_reg<={PC_plus4[31:28],imm26,2'b00};",
      'IMM16:////branch////',
      "PC_reg<=zero?PC_reg:32'd4;",
      'default:',
      "PC_reg<=PC_reg+32'd4;",
      'endcase',
      'endmodule'
    ].join('\n');

    expect(format(input)).toBe([
      'module demo;',
      '  case (PC_slt)',
      '    ADD4:',
      "      PC_reg <= PC_reg + 32'd4;",
      '    RA: PC_reg <= ra;',
      '    IMM26: // absolute jump',
      "      PC_reg <= {PC_plus4[31: 28], imm26, 2'b00};",
      '    IMM16: //// branch ////',
      "      PC_reg <= zero ? PC_reg : 32'd4;",
      '    default:',
      "      PC_reg <= PC_reg + 32'd4;",
      '  endcase',
      'endmodule'
    ].join('\n'));
  });

  it('keeps chained ternary continuations aligned', () => {
    const input = [
      'assign ALU_out=(ALU_op==ADD)?(ALU_in1+ALU_in2):',
      '(ALU_op==SUB)?(ALU_in1-ALU_in2):',
      '(ALU_op==OR)?(ALU_in1|ALU_in2):',
      "32'b0;"
    ].join('\n');

    expect(format(input)).toBe([
      'assign ALU_out = (ALU_op == ADD) ? (ALU_in1 + ALU_in2) :',
      '    (ALU_op == SUB) ? (ALU_in1 - ALU_in2) :',
      '    (ALU_op == OR) ? (ALU_in1 | ALU_in2) :',
      "    32'b0;"
    ].join('\n'));
  });

  it('preserves manual ternary line breaks and aligns nested parentheses', () => {
    const input = [
      'module demo;',
      'assign ExcCode =',
      '// LW：访问范围错误',
      '(type == LW && !(',
      "(ALU_Result >= 32'h00000000 && ALU_Result < 32'h00003000) ||",
      "(ALU_Result >= 32'h00007f00 && ALU_Result < 32'h00007f0c)",
      ')) ? 5\'b00100 :',
      "((type == ADD || type == SUB || type == ADDI) && overflow) ? 5'b01100 : 5'b00000;",
      'endmodule'
    ].join('\n');

    expect(format(input)).toBe([
      'module demo;',
      '  assign ExcCode =',
      '      // LW：访问范围错误',
      '      (type == LW && !(',
      "          (ALU_Result >= 32'h00000000 && ALU_Result < 32'h00003000) ||",
      "          (ALU_Result >= 32'h00007f00 && ALU_Result < 32'h00007f0c)",
      "      )) ? 5'b00100 :",
      "      ((type == ADD || type == SUB || type == ADDI) && overflow) ? 5'b01100 : 5'b00000;",
      'endmodule'
    ].join('\n'));
  });

  it('aligns assign and parameter continuations to the course examples', () => {
    const input = [
      'module demo;',
      'parameter ADD=6\'b000000,',
      'SUB=6\'b000001,',
      'ORI=6\'b000010;',
      'assign outputA=',
      'type==ADD?a_add_b:',
      'type==SUB?a_sub_b:none;',
      'endmodule'
    ].join('\n');

    expect(format(input)).toBe([
      'module demo;',
      "  parameter ADD = 6'b000000,",
      "            SUB = 6'b000001,",
      "            ORI = 6'b000010;",
      '  assign outputA =',
      '      type == ADD ? a_add_b :',
      '      type == SUB ? a_sub_b : none;',
      'endmodule'
    ].join('\n'));
  });

  it('does not treat comment-only lines ending in colon as continued expressions', () => {
    const input = [
      '// Company:',
      '// Engineer:',
      '// Project Name:',
      '`default_nettype none',
      'module demo(',
      'input clk',
      ');',
      'endmodule'
    ].join('\n');

    expect(format(input)).toBe([
      '// Company:',
      '// Engineer:',
      '// Project Name:',
      '`default_nettype none',
      'module demo (',
      '    input clk',
      '  );',
      'endmodule'
    ].join('\n'));
  });

  it('uses VS Code formatting options for indentation', () => {
    const input = [
      'module demo;',
      'if(a) begin',
      'a<=1;',
      'end',
      'endmodule'
    ].join('\n');

    expect(format(input, mergeCoSettings({}), { insertSpaces: false, tabSize: 4 })).toBe([
      'module demo;',
      '\tif (a) begin',
      '\t\ta <= 1;',
      '\tend',
      'endmodule'
    ].join('\n'));
  });

  it('keeps spaces around else-if conditions and begin', () => {
    const input = [
      'module Hazard;',
      "if(E_new!=3'b111&&E_A3!=5'b0&&E_A3==D_rs&&D_Trs<E_new)begin",
      'stall=1;',
      'end',
      "else if(M_new!=3'b111&&M_A3!=5'b0&&M_A3==D_rs&&D_Trs<M_new)begin",
      'stall=1;',
      'end',
      'endmodule'
    ].join('\n');

    expect(format(input)).toBe([
      'module Hazard;',
      "  if (E_new != 3'b111 && E_A3 != 5'b0 && E_A3 == D_rs && D_Trs < E_new) begin",
      '    stall = 1;',
      '  end',
      "  else if (M_new != 3'b111 && M_A3 != 5'b0 && M_A3 == D_rs && D_Trs < M_new) begin",
      '    stall = 1;',
      '  end',
      'endmodule'
    ].join('\n'));
  });

  it('uses a space before module declaration port lists', () => {
    expect(format('module Hazard(input clk);\nendmodule')).toBe('module Hazard (input clk);\nendmodule');
  });

  it('formats macro-based case labels as code instead of preprocessor directives', () => {
    const input = [
      'module demo;',
      'case(state)',
      '`IDLE: if(ctrl[0]) begin',
      'state<=`LOAD;',
      'end',
      '`LOAD: begin',
      '`count<=`preset;',
      'state<=`CNT;',
      'end',
      '`CNT:',
      'if(ctrl[0]) begin',
      "if(`count>1) `count<=`count-1;",
      'else begin',
      '`count<=0;',
      'state<=`INT;',
      'end',
      'end',
      'else state<=`IDLE;',
      'default: begin',
      "if(ctrl[2:1]==2'b00) ctrl[0]<=1'b0;",
      "else _IRQ<=1'b0;",
      'state<=`IDLE;',
      'end',
      'endcase',
      'endmodule'
    ].join('\n');

    expect(format(input)).toBe([
      'module demo;',
      '  case (state)',
      '    `IDLE: if (ctrl[0]) begin',
      '      state <= `LOAD;',
      '    end',
      '    `LOAD: begin',
      '      `count <= `preset;',
      '      state <= `CNT;',
      '    end',
      '    `CNT:',
      '      if (ctrl[0]) begin',
      "        if (`count > 1) `count <= `count - 1;",
      '        else begin',
      '          `count <= 0;',
      '          state <= `INT;',
      '        end',
      '      end',
      '      else state <= `IDLE;',
      '    default: begin',
      "      if (ctrl[2: 1] == 2'b00) ctrl[0] <= 1'b0;",
      "      else _IRQ <= 1'b0;",
      '      state <= `IDLE;',
      '    end',
      '  endcase',
      'endmodule'
    ].join('\n'));
  });
});
