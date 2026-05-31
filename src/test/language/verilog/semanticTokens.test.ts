import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mipsSemanticTokenTypes } from '../../../language/mips/resources';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogSemanticTokens } from '../../../language/verilog/service';
import { verilogSemanticTokenTypes } from '../../../language/verilog/model';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

interface DecodedToken {
  line: number;
  character: number;
  length: number;
  type: number;
}

function doc(text: string): TextDocument {
  return TextDocument.create('test://semantic.v', 'verilog', 1, text);
}

function decode(data: number[]): DecodedToken[] {
  const tokens: DecodedToken[] = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < data.length; index += 5) {
    line += data[index];
    character = data[index] === 0 ? character + data[index + 1] : data[index + 1];
    tokens.push({
      line,
      character,
      length: data[index + 2],
      type: data[index + 3]
    });
  }
  return tokens;
}

describe('Verilog semantic tokens', () => {
  it('highlights backtick macro uses as one macro token', () => {
    const text = [
      '`define WIDTH 8',
      'module m;',
      '    wire [`WIDTH-1:0] data;',
      '    assign data = `WIDTH;',
      'endmodule'
    ].join('\n');
    const document = doc(text);
    const tokens = decode(getVerilogSemanticTokens(document, mergeCoSettings({}), new VerilogWorkspaceIndex()).data);
    const macroType = mipsSemanticTokenTypes.length + verilogSemanticTokenTypes.indexOf('verilogMacro');
    const line = text.split('\n')[3];
    const start = line.indexOf('`WIDTH');

    expect(tokens).toContainEqual({
      line: 3,
      character: start,
      length: '`WIDTH'.length,
      type: macroType
    });
  });
});
