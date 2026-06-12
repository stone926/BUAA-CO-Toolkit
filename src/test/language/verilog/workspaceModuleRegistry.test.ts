import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => {
  class MockUri {
    readonly scheme = 'file';
    constructor(readonly fsPath: string) {}
    static file(file: string): MockUri {
      return new MockUri(file);
    }
    toString(): string {
      return this.fsPath;
    }
  }
  return {
    MockUri,
    state: {
      activeTextEditor: undefined as { document: { uri: InstanceType<typeof MockUri> } } | undefined,
      textDocuments: [] as Array<{ uri: InstanceType<typeof MockUri>; languageId: string }>
    }
  };
});

vi.mock('vscode', () => ({
  Uri: vscodeMock.MockUri,
  workspace: {
    get textDocuments() {
      return vscodeMock.state.textDocuments;
    },
    get workspaceFolders() {
      return [];
    }
  },
  window: {
    get activeTextEditor() {
      return vscodeMock.state.activeTextEditor;
    }
  }
}));

import { WorkspaceModuleRegistry } from '../../../language/verilog/workspaceModuleRegistry';

const tempDirs: string[] = [];

afterEach(() => {
  vscodeMock.state.activeTextEditor = undefined;
  vscodeMock.state.textDocuments.splice(0);
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('WorkspaceModuleRegistry', () => {
  it('returns all same-name module candidates', () => {
    const root = makeTempDir();
    const first = writeVerilog(root, 'test/a.v', 'module mips_tb; endmodule\n');
    const second = writeVerilog(root, 'test/b.v', 'module mips_tb; endmodule\n');
    const registry = new WorkspaceModuleRegistry();

    registry.updateUri(vscodeMock.MockUri.file(first) as never);
    registry.updateUri(vscodeMock.MockUri.file(second) as never);

    expect(registry.getModules('mips_tb').map((module) => normalize(module.uri))).toEqual([
      normalize(first),
      normalize(second)
    ]);
  });

  it('indexes a testbench by module name even when the file name differs', () => {
    const root = makeTempDir();
    const file = writeVerilog(root, 'test/tb.v', 'module mips_tb; endmodule\n');
    const registry = new WorkspaceModuleRegistry();

    registry.updateUri(vscodeMock.MockUri.file(file) as never);

    expect(registry.getModule('mips_tb')?.name).toBe('mips_tb');
    expect(normalize(registry.getModule('mips_tb')?.uri ?? '')).toBe(normalize(file));
  });

  it('updates the registry after a generated user testbench is written', () => {
    const root = makeTempDir();
    const file = path.join(root, 'test', 'generated_tb.v');
    const registry = new WorkspaceModuleRegistry();

    expect(registry.getModule('generated_tb')).toBeUndefined();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'module generated_tb; endmodule\n');
    registry.updateUri(vscodeMock.MockUri.file(file) as never);

    expect(registry.getModule('generated_tb')?.name).toBe('generated_tb');
  });

  it('removes stale module entries when a Verilog file is deleted', () => {
    const root = makeTempDir();
    const file = writeVerilog(root, 'test/mips_tb.v', 'module mips_tb; endmodule\n');
    const uri = vscodeMock.MockUri.file(file) as never;
    const registry = new WorkspaceModuleRegistry();

    registry.updateUri(uri);
    expect(registry.getModule('mips_tb')?.name).toBe('mips_tb');

    fs.rmSync(file);
    registry.updateUri(uri);

    expect(registry.getModule('mips_tb')).toBeUndefined();
  });
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-registry-test-'));
  tempDirs.push(dir);
  return dir;
}

function writeVerilog(root: string, relative: string, text: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function normalize(value: string): string {
  return path.resolve(value).split(path.sep).join('/');
}
