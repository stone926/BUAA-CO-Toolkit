import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ReferenceParams } from 'vscode-languageserver/node';
import { mergeCoSettings } from '../../../language/common/settings';
import {
  getVerilogDefinition,
  getVerilogReferences
} from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

let documentVersion = 1;

function doc(uri: string, text: string): TextDocument {
  return TextDocument.create(uri, 'verilog', documentVersion++, text.trim());
}

function positionOf(document: TextDocument, text: string, offset = 0) {
  const index = document.getText().indexOf(text);
  expect(index).toBeGreaterThanOrEqual(0);
  return document.positionAt(index + offset);
}

function referencesAt(document: TextDocument, text: string, index: VerilogWorkspaceIndex) {
  const params: ReferenceParams = {
    textDocument: { uri: document.uri },
    position: positionOf(document, text),
    context: { includeDeclaration: true }
  };
  return getVerilogReferences(document, params, mergeCoSettings({}), index);
}

describe('Verilog cross-file semantic graph', () => {
  it('resolves named port and parameter connections to indexed module symbols', () => {
    const child = doc('test://workspace/child.v', `
module child #(parameter WIDTH = 8)(
    input [WIDTH-1:0] din,
    output dout
);
    assign dout = din[0];
endmodule
`);
    const top = doc('test://workspace/top.v', `
module top(input [7:0] bus, output y);
    child #(.WIDTH(8)) u_child(.din(bus), .dout(y));
endmodule
`);
    const index = new VerilogWorkspaceIndex();
    const settings = mergeCoSettings({});
    index.updateDocument(child, settings);
    index.updateDocument(top, settings);
    const childModule = index.getModule('child');
    expect(childModule).toBeDefined();
    expect(index.getModuleSymbols(childModule!).some((symbol) => symbol.kind === 'port' && symbol.name === 'din')).toBe(true);
    expect(index.getModuleSymbols(childModule!).some((symbol) => symbol.kind === 'parameter' && symbol.name === 'WIDTH')).toBe(true);

    const portDefinition = getVerilogDefinition(top, positionOf(top, '.din', 1), settings, index);
    expect(portDefinition?.uri).toBe(child.uri);
    expect(child.getText(portDefinition!.range)).toBe('din');

    const parameterDefinition = getVerilogDefinition(top, positionOf(top, '.WIDTH', 1), settings, index);
    expect(parameterDefinition?.uri).toBe(child.uri);
    expect(child.getText(parameterDefinition!.range)).toBe('WIDTH');
  });

  it('includes cross-file port and parameter connections in references', () => {
    const child = doc('test://workspace/ref-child.v', `
module child #(parameter WIDTH = 8)(
    input [WIDTH-1:0] din,
    output dout
);
    assign dout = din[0];
endmodule
`);
    const top = doc('test://workspace/ref-top.v', `
module top(input [7:0] bus, output y);
    child #(.WIDTH(8)) u_child(.din(bus), .dout(y));
endmodule
`);
    const index = new VerilogWorkspaceIndex();
    const settings = mergeCoSettings({});
    index.updateDocument(child, settings);
    index.updateDocument(top, settings);

    const dinReferences = referencesAt(child, 'din,', index);
    expect(dinReferences.some((location) => location.uri === top.uri && top.getText(location.range) === 'din')).toBe(true);
    expect(dinReferences.some((location) => location.uri === child.uri && child.getText(location.range) === 'din')).toBe(true);

    const widthReferences = referencesAt(child, 'WIDTH =', index);
    expect(widthReferences.some((location) => location.uri === top.uri && top.getText(location.range) === 'WIDTH')).toBe(true);
    expect(widthReferences.some((location) => location.uri === child.uri && child.getText(location.range) === 'WIDTH')).toBe(true);
  });
});
