import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mipsSemanticTokenTypes } from '../../../language/mips/resources';
import { defaultCoSettings, mergeCoSettings } from '../../../language/common/settings';
import { clearVerilogSemanticTokenCache, getVerilogSemanticTokens } from '../../../language/verilog/service';
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
  afterEach(() => {
    clearVerilogSemanticTokenCache();
  });

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

  it('does not highlight code tokens inside line comments after based literals', () => {
    const text = [
      'module m;',
      '    wire [31:0] pc;',
      "    assign plusJUMP = pc + 32'h00000004; // pc+4",
      "    assign immJUMP = {pc[31:28], imm26, 2'b00}; // J型指令跳转",
      'endmodule'
    ].join('\n');
    const tokens = decode(getVerilogSemanticTokens(doc(text), mergeCoSettings({}), new VerilogWorkspaceIndex()).data);
    const commentType = mipsSemanticTokenTypes.length + verilogSemanticTokenTypes.indexOf('verilogComment');
    const lines = text.split('\n');

    for (const lineNumber of [2, 3]) {
      const commentStart = lines[lineNumber].indexOf('//');
      const tokensInComment = tokens.filter((token) => token.line === lineNumber && token.character >= commentStart);

      expect(tokensInComment).toEqual([expect.objectContaining({
        line: lineNumber,
        character: commentStart,
        type: commentType
      })]);
    }
  });

  it('highlights single-letter display format conversions', () => {
    const text = [
      'module m;',
      '    initial begin',
      '        $display("%d@%h: $%d <= %h %% %m %ld", $time, pc, regno, data);',
      '    end',
      'endmodule'
    ].join('\n');
    const tokens = decode(getVerilogSemanticTokens(doc(text), mergeCoSettings({}), new VerilogWorkspaceIndex()).data);
    const formatType = mipsSemanticTokenTypes.length + verilogSemanticTokenTypes.indexOf('verilogFormatSpecifier');
    const line = text.split('\n')[2];
    const expected = Array.from(line.matchAll(/%[%0-9a-z]+/g)).map((match) => ({
      line: 2,
      character: match.index ?? 0,
      length: match[0].length,
      type: formatType
    }));

    for (const token of expected) {
      expect(tokens).toContainEqual(token);
    }
  });

  it('highlights syntax tokens from AST statements', () => {
    const text = [
      'module m;',
      "    assign y = 4'hf;",
      'endmodule'
    ].join('\n');
    const tokens = decode(getVerilogSemanticTokens(doc(text), mergeCoSettings({}), new VerilogWorkspaceIndex()).data);
    const keywordType = mipsSemanticTokenTypes.length + verilogSemanticTokenTypes.indexOf('verilogKeyword');
    const numberType = mipsSemanticTokenTypes.length + verilogSemanticTokenTypes.indexOf('verilogNumber');
    const punctuationType = mipsSemanticTokenTypes.length + verilogSemanticTokenTypes.indexOf('verilogPunctuation');

    expect(tokens).toContainEqual({ line: 0, character: 0, length: 6, type: keywordType });
    expect(tokens).toContainEqual({ line: 0, character: 8, length: 1, type: punctuationType });
    expect(tokens).toContainEqual({ line: 1, character: 15, length: 4, type: numberType });
    expect(tokens).toContainEqual({ line: 1, character: 19, length: 1, type: punctuationType });
  });

  it('does not invalidate cached tokens for unrelated workspace index revisions', () => {
    const document = doc('module top; wire sig; Child u(.a(sig)); endmodule');
    const index = new VerilogWorkspaceIndex();
    const first = getVerilogSemanticTokens(document, mergeCoSettings({}), index);

    index.updateDocument(TextDocument.create('test://semantic-child.v', 'verilog', 1, 'module Child(input wire a); endmodule'), defaultCoSettings);

    expect(getVerilogSemanticTokens(document, mergeCoSettings({}), index)).toBe(first);
  });

  it('refreshes cross-file port connection colors after semantic token cache is cleared', () => {
    const text = 'module top; wire sig; Child u(.a(sig)); endmodule';
    const document = doc(text);
    const index = new VerilogWorkspaceIndex();
    const signalType = mipsSemanticTokenTypes.length + verilogSemanticTokenTypes.indexOf('verilogSignal');
    const portType = mipsSemanticTokenTypes.length + verilogSemanticTokenTypes.indexOf('verilogPort');
    const connectionCharacter = text.indexOf('.a') + 1;

    expect(tokenAt(decode(getVerilogSemanticTokens(document, mergeCoSettings({}), index).data), 0, connectionCharacter)?.type).toBe(signalType);

    index.updateDocument(TextDocument.create('test://semantic-child.v', 'verilog', 1, 'module Child(input wire a); endmodule'), defaultCoSettings);
    clearVerilogSemanticTokenCache(document.uri);

    expect(tokenAt(decode(getVerilogSemanticTokens(document, mergeCoSettings({}), index).data), 0, connectionCharacter)?.type).toBe(portType);
  });
});

function tokenAt(tokens: DecodedToken[], line: number, character: number): DecodedToken | undefined {
  return tokens.find((token) =>
    token.line === line &&
    token.character <= character &&
    character < token.character + token.length
  );
}
