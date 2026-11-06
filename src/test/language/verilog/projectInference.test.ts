import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { mergeCoSettings } from '../../../language/common/settings';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';
import { getVerilogDiagnostics } from '../../../language/verilog/diagnosticProvider';
import { getVerilogCodeActions } from '../../../language/verilog/codeActions';
import { inferVerilogProjects } from '../../../language/verilog/projectInference';
import { Commands } from '../../../constants';

function fixture(complete = true) {
  const root = path.resolve('inferred projects 中文');
  const settings = mergeCoSettings({ verilog: { lint: { courseRules: false } } });
  const index = new VerilogWorkspaceIndex({ workspaceComplete: complete });
  index.configureProjects([URI.file(root).toString()], {});
  const add = (file: string, text: string) => {
    const document = TextDocument.create(URI.file(path.join(root, file)).toString(), 'verilog', 1, text);
    index.updateDocument(document, settings);
    return document;
  };
  return { root, settings, index, add };
}

describe('automatic Verilog projects', () => {
  it('separates nested CPU variants and retains shared dependency closures', () => {
    const { index, add, settings } = fixture();
    const helper = add('common/helper.v', 'module helper; endmodule');
    const header = add('common/defs.vh', '`define WIDTH 32');
    const tops: TextDocument[] = [];
    for (const dir of ['lrz', 'stone/p4', 'stone/p7']) {
      add(`${dir}/rtl/ifu.v`, 'module A_IFU; helper h(); endmodule');
      tops.push(add(`${dir}/mips.v`, '`include "../' + (dir.includes('/') ? '../' : '') + 'common/defs.vh"\nmodule mips; A_IFU ifu(); endmodule'));
    }
    for (const top of tops) {
      expect(index.getModules('mips', top.uri)).toHaveLength(1);
      const target = index.getModule('A_IFU', top.uri);
      expect(target?.uri).toContain(top.uri.slice(0, top.uri.lastIndexOf('/')));
      expect(index.getModule('helper', top.uri)?.uri).toBe(helper.uri);
      expect(index.indexedFiles(top.uri).some((file) => file.uri === header.uri)).toBe(true);
      expect(getVerilogDiagnostics(top, settings, index).some((entry) => ['duplicate-module', 'ambiguous-module'].includes(String(entry.code)))).toBe(false);
    }
    expect(index.indexedFiles(helper.uri).length).toBeGreaterThan(3);
  });

  it('preserves genuine same-directory ambiguity and offers project configuration', () => {
    const { index, add, settings } = fixture();
    add('src/first.v', 'module alu; endmodule');
    add('src/second.v', 'module alu; endmodule');
    const top = add('src/top.v', 'module top; alu u(); endmodule');
    const diagnostics = getVerilogDiagnostics(top, settings, index);
    expect(diagnostics.some((entry) => entry.code === 'ambiguous-module')).toBe(true);
    expect(index.getModule('alu', top.uri)).toBeUndefined();
    const action = getVerilogCodeActions(top, diagnostics[0].range, diagnostics, settings, index)
      .find((entry) => entry.command?.command === Commands.Verilog.ConfigureProjects);
    expect(action?.command?.arguments).toEqual([top.uri]);
    expect(action?.diagnostics?.some((entry) => entry.code === 'ambiguous-module')).toBe(true);
  });

  it('does not choose a distant variant when a shared caller has no local definition', () => {
    const { index, add, settings } = fixture();
    add('a/alu.v', 'module alu; endmodule');
    add('b/alu.v', 'module alu; endmodule');
    const top = add('top.v', 'module top; alu u(); endmodule');
    expect(index.getModules('alu', top.uri)).toHaveLength(2);
    expect(getVerilogDiagnostics(top, settings, index).some((entry) => entry.code === 'ambiguous-module')).toBe(true);
  });

  it('recomputes inference after add, edit and remove without discarding explicit settings', () => {
    const { index, add, root } = fixture();
    const a = add('a/alu.v', 'module alu; endmodule');
    const top = add('a/top.v', 'module top; alu u(); endmodule');
    const b = add('b/alu.v', 'module alu; endmodule');
    expect(index.getModule('alu', top.uri)?.uri).toBe(a.uri);
    add('b/alu.v', 'module other; endmodule');
    expect(index.getModule('other', top.uri)?.uri).toBe(b.uri);
    index.remove(b.uri);
    expect(index.getModule('other', top.uri)).toBeUndefined();
    add('b/alu.v', 'module alu; endmodule');
    index.configureProjects([URI.file(root).toString()], { explicit: ['a', 'b'] });
    expect(index.getModules('alu', top.uri)).toHaveLength(2);
  });

  it('suppresses provisional duplicate diagnostics until the initial scan finishes', () => {
    const { index, add, settings } = fixture(false);
    add('one.v', 'module alu; endmodule');
    const other = add('two.v', 'module alu; endmodule');
    expect(getVerilogDiagnostics(other, settings, index).some((entry) => entry.code === 'duplicate-module')).toBe(false);
  });

  it('produces deterministic source sets independent of discovery order', () => {
    const { index, add, root } = fixture();
    add('B/top.v', 'module top; endmodule');
    add('A/top.v', 'module top; endmodule');
    const files = index.allFiles();
    const folders = [URI.file(root).toString()];
    expect(inferVerilogProjects(folders, files)).toEqual(inferVerilogProjects(folders, [...files].reverse()));
  });

  it('keeps nested workspace folders isolated and never exports their files twice', () => {
    const { index, add, root } = fixture();
    const parent = add('top.v', 'module alu; endmodule');
    const child = add('nested/top.v', 'module alu; endmodule');
    index.configureProjects([URI.file(root).toString(), URI.file(path.join(root, 'nested')).toString()], {});
    expect(index.getModule('alu', parent.uri)?.uri).toBe(parent.uri);
    expect(index.getModule('alu', child.uri)?.uri).toBe(child.uri);
    expect(Object.values(index.effectiveProjects).flat()).toHaveLength(2);
  });
});
