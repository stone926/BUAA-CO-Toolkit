import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mergeCoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/service';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

let documentVersion = 1;

function doc(name: string, text: string): TextDocument {
  const version = documentVersion++;
  return TextDocument.create(`test://workspace-diagnostics/${version}/${name}.v`, 'verilog', version, text.trim());
}

function diagnostics(current: TextDocument, indexed: TextDocument[], settingsValue: unknown = {}) {
  const settings = mergeCoSettings(settingsValue);
  const index = new VerilogWorkspaceIndex();
  for (const item of indexed) {
    index.updateDocument(item, settings);
  }
  return getVerilogDiagnostics(current, settings, index);
}

function codes(current: TextDocument, indexed: TextDocument[], settingsValue: unknown = {}): string[] {
  return diagnostics(current, indexed, settingsValue)
    .map((diagnostic) => diagnostic.code)
    .filter((code): code is string => typeof code === 'string');
}

describe('Verilog workspace diagnostics', () => {
  it('does not report unresolved instance module names from incomplete workspace indexes', () => {
    const top = doc('top', `
module top;
    MissingModule u_missing();
endmodule
`);

    expect(codes(top, [top], { project: { topModule: 'top' } })).not.toContain('unresolved-module');
  });

  it('reports duplicate modules across indexed files', () => {
    const first = doc('first', 'module child; endmodule');
    const second = doc('second', 'module child; endmodule');

    expect(codes(second, [first, second], { project: { topModule: 'child' } })).toContain('duplicate-module');
  });

  it('reports modules that are not instantiated by the workspace hierarchy', () => {
    const top = doc('top', `
module used; endmodule
module unused; endmodule
module top;
    used u_used();
endmodule
`);

    expect(codes(top, [top], { project: { topModule: 'top' } })).toContain('uninstantiated-module');
  });

  it('defers global hierarchy diagnostics while the workspace index is incomplete', () => {
    const child = doc('child', 'module child; endmodule');
    const settings = mergeCoSettings({ project: { profile: 'P7', topModule: 'mips' } });
    const index = new VerilogWorkspaceIndex({ workspaceComplete: false });
    index.updateDocument(child, settings);

    const result = getVerilogDiagnostics(child, settings, index)
      .map((diagnostic) => diagnostic.code);

    expect(result).not.toContain('missing-top');
    expect(result).not.toContain('uninstantiated-module');
    expect(result).not.toContain('p7-module-cpu');
  });

  it('reports instance output drivers that conflict with assignments', () => {
    const child = doc('child', `
module child(output y);
    assign y = 1'b1;
endmodule
`);
    const top = doc('top', `
module top(input a);
    wire y;
    child u_child(.y(y));
    assign y = a;
endmodule
`);

    expect(codes(top, [child, top], { project: { topModule: 'top' } })).toContain('multi-driver');
  });

  it('reports multiple instance outputs driving the same signal', () => {
    const child = doc('child_multi', `
module child_multi(output y);
    assign y = 1'b1;
endmodule
`);
    const top = doc('top_multi', `
module top;
    wire y;
    child_multi u0(.y(y));
    child_multi u1(.y(y));
endmodule
`);

    expect(codes(top, [child, top], { project: { topModule: 'top' } })).toContain('multi-driver');
  });

  it('does not report intentionally unconnected output ports as missing', () => {
    const controller = doc('controller', `
module Controller(
    input [31:0] instr,
    input flush,
    output RegWrite,
    output MemWrite,
    output Branch
);
endmodule
`);
    const top = doc('top_outputs', `
module top(input [31:0] instr);
    wire reg_write;
    Controller ctrl(
        .instr(instr),
        .RegWrite(reg_write)
    );
endmodule
`);

    const result = codes(top, [controller, top], { project: { topModule: 'top' } });
    expect(result).toContain('missing-port:flush');
    expect(result).not.toContain('missing-port:MemWrite');
    expect(result).not.toContain('missing-port:Branch');
  });

  it('invalidates cached workspace project summaries when the index changes', () => {
    const settings = mergeCoSettings({ project: { profile: 'P4', topModule: 'mips' } });
    const uri = 'test://workspace-diagnostics/project-summary/mips.v';
    const index = new VerilogWorkspaceIndex();
    const incomplete = TextDocument.create(uri, 'verilog', 1, 'module mips; endmodule');
    index.updateDocument(incomplete, settings);

    const firstCodes = getVerilogDiagnostics(incomplete, settings, index)
      .map((diagnostic) => diagnostic.code);
    expect(firstCodes).toContain('project-pc-reset');
    expect(firstCodes).toContain('project-im-size');
    expect(firstCodes).toContain('project-dm-size');

    const complete = TextDocument.create(uri, 'verilog', 2, `
module mips;
    reg [31:0] pc;
    reg [31:0] im [0:4095];
    reg [31:0] dm [3071:0];
    initial pc = 32'h00003000;
endmodule
`);
    index.updateDocument(complete, settings);

    const secondCodes = getVerilogDiagnostics(complete, settings, index)
      .map((diagnostic) => diagnostic.code);
    expect(secondCodes).not.toContain('project-pc-reset');
    expect(secondCodes).not.toContain('project-im-size');
    expect(secondCodes).not.toContain('project-dm-size');
  });

  it('does not require a visible 0x4180 constant for P7 projects', () => {
    const top = doc('p7_top', `
module CPU; endmodule
module Bridge; endmodule
module TC; endmodule
module CP0;
    reg SR;
    reg CAUSE;
    reg EPC;
endmodule
module mips;
    CPU u_cpu();
    Bridge u_bridge();
    TC u_tc();
    CP0 u_cp0();
endmodule
`);

    expect(codes(top, [top], { project: { profile: 'P7', topModule: 'mips' } })).not.toContain('p7-exception-entry');
  });
});
