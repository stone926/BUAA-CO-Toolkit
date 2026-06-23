import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceFolder } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { defaultCoSettings } from '../../../language/common/settings';
import { isVerilogUri, VerilogWorkspaceIndex } from '../../../language/verilog/workspaceIndex';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('VerilogWorkspaceIndex', () => {
  it('skips generated and dependency directories while rebuilding', async () => {
    const root = makeTempRoot();
    writeFile(root, 'src/a.v', 'module A; endmodule\n');
    writeFile(root, 'src/b.v', 'module B; endmodule\n');
    writeFile(root, '.co/generated.v', 'module Generated; endmodule\n');
    writeFile(root, 'node_modules/pkg/dep.v', 'module Dependency; endmodule\n');
    writeFile(root, 'build/out.v', 'module BuildOutput; endmodule\n');

    const index = new VerilogWorkspaceIndex();
    await index.rebuild([folder(root)], defaultCoSettings);

    expect(index.getModule('A')).toBeDefined();
    expect(index.getModule('B')).toBeDefined();
    expect(index.getModule('Generated')).toBeUndefined();
    expect(index.getModule('Dependency')).toBeUndefined();
    expect(index.getModule('BuildOutput')).toBeUndefined();
  });

  it('honors the configured maximum indexed file count', async () => {
    const root = makeTempRoot();
    writeFile(root, 'a.v', 'module A; endmodule\n');
    writeFile(root, 'b.v', 'module B; endmodule\n');

    const index = new VerilogWorkspaceIndex({ maxFiles: 1 });
    await index.rebuild([folder(root)], defaultCoSettings);

    expect(index.allFiles()).toHaveLength(1);
  });

  it('updates and removes a single file without rebuilding the workspace', () => {
    const root = makeTempRoot();
    const file = writeFile(root, 'src/top.v', 'module OldTop; endmodule\n');
    const uri = URI.file(file).toString();
    const index = new VerilogWorkspaceIndex();

    index.updateFile(uri, defaultCoSettings);
    expect(index.getModule('OldTop')).toBeDefined();

    fs.writeFileSync(file, 'module NewTop; endmodule\n', 'utf8');
    index.updateFile(uri, defaultCoSettings);
    expect(index.getModule('OldTop')).toBeUndefined();
    expect(index.getModule('NewTop')).toBeDefined();

    fs.unlinkSync(file);
    index.updateFile(uri, defaultCoSettings);
    expect(index.getModule('NewTop')).toBeUndefined();
  });

  it('advances its version when indexed content changes', () => {
    const root = makeTempRoot();
    const file = writeFile(root, 'src/top.v', 'module OldTop; endmodule\n');
    const uri = URI.file(file).toString();
    const index = new VerilogWorkspaceIndex();
    const initialVersion = index.version;

    index.updateFile(uri, defaultCoSettings);
    const indexedVersion = index.version;
    expect(indexedVersion).toBeGreaterThan(initialVersion);

    fs.writeFileSync(file, 'module NewTop; endmodule\n', 'utf8');
    index.updateFile(uri, defaultCoSettings);
    expect(index.version).toBeGreaterThan(indexedVersion);
  });

  it('caches display trace formats for profile inference', () => {
    const root = makeTempRoot();
    const file = writeFile(root, 'src/top.v', 'module mips(input clk, input reset); initial $display("%0d@%08h: $%0d <= %08h", $time, pc, addr, data); endmodule\n');
    const index = new VerilogWorkspaceIndex();

    index.updateFile(URI.file(file).toString(), defaultCoSettings);

    expect(index.indexedDisplayFormats()).toContain('%0d@%08h: $%0d <= %08h');
  });

  it('updates inverted reference indexes when a file changes', () => {
    const root = makeTempRoot();
    const file = writeFile(root, 'src/top.v', 'module top; OldChild u_old(.a(sig)); endmodule\n');
    const uri = URI.file(file).toString();
    const index = new VerilogWorkspaceIndex();

    index.updateFile(uri, defaultCoSettings);
    expect(index.moduleReferenceLocations('OldChild')).toHaveLength(1);
    expect(index.interfaceConnectionLocations('OldChild', 'a', 'ports')).toHaveLength(1);

    fs.writeFileSync(file, 'module top; NewChild u_new(.b(sig)); endmodule\n', 'utf8');
    index.updateFile(uri, defaultCoSettings);

    expect(index.moduleReferenceLocations('OldChild')).toHaveLength(0);
    expect(index.interfaceConnectionLocations('OldChild', 'a', 'ports')).toHaveLength(0);
    expect(index.moduleReferenceLocations('NewChild')).toHaveLength(1);
    expect(index.interfaceConnectionLocations('NewChild', 'b', 'ports')).toHaveLength(1);
  });

  it('recognizes Verilog file URIs case-insensitively', () => {
    expect(isVerilogUri(URI.file(path.join('C:', 'work', 'CPU.V')).toString())).toBe(true);
    expect(isVerilogUri(URI.file(path.join('C:', 'work', 'CPU.sv')).toString())).toBe(false);
  });
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-ext-'));
  tempRoots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string, content: string): string {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function folder(root: string): WorkspaceFolder {
  return {
    name: path.basename(root),
    uri: URI.file(root).toString()
  };
}
