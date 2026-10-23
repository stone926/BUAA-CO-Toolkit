import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { mergeCoSettings } from '../../../language/common/settings';
import { VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';
import { getVerilogDefinition, getVerilogReferences } from '../../../language/verilog/navigation';
import { getVerilogDiagnostics } from '../../../language/verilog/diagnosticProvider';
import { getVerilogRenameEdits } from '../../../language/verilog/rename';
import { resolveExternalSyntaxProject } from '../../../language/verilog/externalSyntaxProject';
import { normalizeVerilogProjects } from '../../../language/verilog/projectContext';
import { normalizePathKey } from '../../../pathUtils';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

function fixture(configured = true) {
  const root = path.resolve('project fixtures 中文');
  const settings = mergeCoSettings({ verilog: { projects: configured ? { P4: ['p4'], P7: ['p7'] } : {} } });
  const index = new VerilogWorkspaceIndex();
  index.configureProjects([URI.file(root).toString()], settings.verilog.projects);
  const doc = (file: string, text: string) => {
    const document = TextDocument.create(URI.file(path.join(root, file)).toString(), 'verilog', 1, text);
    index.updateDocument(document, settings);
    return document;
  };
  const p4 = doc('p4/alu.v', 'module alu(input a, output y); assign y=a; endmodule');
  const p7 = doc('p7/alu.v', 'module alu(input [31:0] a, output [31:0] y); assign y=a; endmodule');
  const top4 = doc('p4/top.v', 'module top(input a, output y); alu u(.a(a), .y(y)); endmodule');
  const top7 = doc('p7/top.v', 'module top(input [31:0] a, output [31:0] y); alu u(.a(a), .y(y)); endmodule');
  return { root, settings, index, doc, p4, p7, top4, top7 };
}

describe('Verilog project identity', () => {
  it('binds duplicate module names to their explicit source sets', () => {
    const { index, settings, p7, top7 } = fixture();
    const position = top7.positionAt(top7.getText().indexOf('alu u'));
    expect(getVerilogDefinition(top7, position, settings, index)?.uri).toBe(p7.uri);
    for (const document of [p7, top7]) {
      expect(getVerilogDiagnostics(document, settings, index).filter((d) =>
        ['port-width-mismatch', 'unknown-port', 'duplicate-module', 'ambiguous-module'].includes(String(d.code)))).toEqual([]);
    }
  });

  it('does not guess when an unconfigured source set has ambiguous definitions', () => {
    const { index, settings, top7, p7 } = fixture(false);
    expect(getVerilogDefinition(top7, top7.positionAt(top7.getText().indexOf('alu u')), settings, index)).toBeUndefined();
    const diagnostics = getVerilogDiagnostics(top7, settings, index);
    expect(diagnostics.some((d) => d.code === 'ambiguous-module')).toBe(true);
    expect(diagnostics.some((d) => d.code === 'port-width-mismatch')).toBe(false);
    expect(getVerilogRenameEdits(p7, p7.positionAt(7), 'renamed', settings, index)).toBeUndefined();
  });

  it('scopes module and port references and rename edits to their bound definition', () => {
    const { index, settings, p7, top7, top4 } = fixture();
    for (const marker of ['alu(', 'a,']) {
      const position = p7.positionAt(p7.getText().indexOf(marker));
      const references = getVerilogReferences(p7, { textDocument: { uri: p7.uri }, position, context: { includeDeclaration: true } }, settings, index);
      expect(references.some((location) => location.uri === top7.uri)).toBe(true);
      expect(references.some((location) => location.uri === top4.uri)).toBe(false);
      const changes = getVerilogRenameEdits(p7, position, 'new_name', settings, index)?.changes;
      expect(Object.keys(changes ?? {}).sort()).toEqual([p7.uri, top7.uri].sort());
    }
  });

  it('keeps same-range macro definitions and references in separate projects', () => {
    const { index, settings, doc } = fixture();
    const a = doc('p4/defs.vh', '`define WIDTH 1\n');
    const b = doc('p7/defs.vh', '`define WIDTH 32\n');
    const useA = doc('p4/use.v', 'module use_a; wire [`WIDTH-1:0] a; endmodule');
    const useB = doc('p7/use.v', 'module use_b; wire [`WIDTH-1:0] b; endmodule');
    expect(getVerilogDefinition(useB, useB.positionAt(useB.getText().indexOf('WIDTH')), settings, index)?.uri).toBe(b.uri);
    const changes = getVerilogRenameEdits(b, b.positionAt(8), 'BITS', settings, index)?.changes;
    expect(Object.keys(changes ?? {}).sort()).toEqual([b.uri, useB.uri].sort());
    expect(changes?.[a.uri]).toBeUndefined();
    expect(changes?.[useA.uri]).toBeUndefined();
  });

  it('supports separate designs in the same directory using explicit files', () => {
    const { index, root, doc } = fixture();
    const settings = mergeCoSettings({ verilog: { projects: { one: ['ALU1.v'], two: ['ALU2.v'] } } });
    const a = doc('ALU1.v', 'module ALU; endmodule');
    const b = doc('ALU2.v', 'module ALU; endmodule');
    index.configureProjects([URI.file(root).toString()], settings.verilog.projects);
    expect(index.getModule('ALU', a.uri)?.uri).toBe(a.uri);
    expect(getVerilogDiagnostics(b, settings, index).some((d) => d.code === 'duplicate-module')).toBe(false);
  });

  it('uses the same source sets for external compiler discovery', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co projects 中文 ')); roots.push(root);
    for (const project of ['p4', 'p7']) {
      await fs.mkdir(path.join(root, project));
      await fs.writeFile(path.join(root, project, 'alu.v'), 'module alu; endmodule');
    }
    const uri = URI.file(path.join(root, 'p7', 'alu.v')).toString();
    const project = await resolveExternalSyntaxProject([{ uri: URI.file(root).toString(), name: 'cpus' }], uri, 5000, { P4: ['p4'], P7: ['p7'] });
    expect(project?.sources.map(normalizePathKey)).toEqual([normalizePathKey(path.join(root, 'p7', 'alu.v'))]);
  });

  it('validates source-set settings without accepting empty or wildcard roots', () => {
    expect(normalizeVerilogProjects({ good: ['p7', 'p7'], empty: [], glob: ['**/*.v'], bad: [1] })).toEqual({ good: ['p7'] });
  });

  it('does not let a document update replace the workspace project configuration', () => {
    const { index, p7, top7 } = fixture();
    index.updateDocument(TextDocument.create('file:///another-workspace/t.v', 'verilog', 1, 'module t; endmodule'), mergeCoSettings({}));
    expect(index.getModule('alu', top7.uri)?.uri).toBe(p7.uri);
  });

  it('keeps DUT sources when checking a generated testbench with one explicit project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-tb-project-')); roots.push(root);
    await fs.mkdir(path.join(root, 'src'));
    await fs.mkdir(path.join(root, '.co/tb'), { recursive: true });
    const dut = path.join(root, 'src/dut.v'), tb = path.join(root, '.co/tb/dut_tb.v');
    await fs.writeFile(dut, 'module dut; endmodule');
    await fs.writeFile(tb, 'module dut_tb; dut u(); endmodule');
    const folders = [{ uri: URI.file(root).toString(), name: 'test' }];
    const project = await resolveExternalSyntaxProject(folders, URI.file(tb).toString(), 5000, { only: ['src'] });
    expect(project?.sources.map(normalizePathKey)).toEqual([dut, tb].map(normalizePathKey));
    await expect(resolveExternalSyntaxProject(folders, URI.file(tb).toString(), 5000, { first: ['src'], second: ['other'] })).rejects.toThrow('testbench');
  });
});
