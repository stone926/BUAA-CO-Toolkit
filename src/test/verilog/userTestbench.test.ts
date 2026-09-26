import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { URI } from 'vscode-uri';
import type { AppServices } from '../../types';
import { defaultCoSettings } from '../../language/common/settings';
import { parseVerilog } from '../../language/verilog/service';
import { getProfile } from '../../config';
import { writeTextFile, writeTextFileIfAbsent } from '../../fsUtil';
import {
  ensureRunnableTestbench,
  testbenchCompileSources,
  userTestbenchText
} from '../../verilog/testbenchResolver';
import {
  findUserTestbench,
  isUserTestbenchUri,
  userTestbenchUri
} from '../../verilog/userTestbench';
import { findWorkspaceFileCandidates } from '../../workflowInputs';
import { verilogDoc } from '../helpers/textDocument';

const files = vi.hoisted(() => new Map<string, string>());

function fileKey(file: string): string {
  return file.replace(/\\/g, '/').toLowerCase();
}

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  const module = createVscodeModuleMock(createVscodeMockState(), vi.fn);
  module.workspace.fs.readFile.mockImplementation(async (uri) => {
    const text = files.get(uri.fsPath.replace(/\\/g, '/').toLowerCase());
    if (text === undefined) {
      throw new Error(`ENOENT: ${uri.fsPath}`);
    }
    return Buffer.from(text);
  });
  return module;
});

vi.mock('../../config', () => ({
  config: vi.fn((_key: string, fallback: unknown) => fallback),
  getProfile: vi.fn(() => 'P1'),
  getRunTimeout: vi.fn(() => 120000),
  getSimTime: vi.fn(() => '200us'),
  getTestbench: vi.fn(() => 'main_tb'),
  getTopModule: vi.fn(() => 'main')
}));

vi.mock('../../fsUtil', async () => {
  const actual = await vi.importActual<typeof import('../../fsUtil')>('../../fsUtil');
  const key = (file: string) => file.replace(/\\/g, '/').toLowerCase();
  return {
    ...actual,
    ensureDirectory: vi.fn(async () => undefined),
    isFile: vi.fn(async (file: string) => files.has(key(file))),
    pathExists: vi.fn(async (file: string) => files.has(key(file))),
    writeTextFile: vi.fn(async () => undefined),
    writeTextFileIfAbsent: vi.fn(async (uri: URI, content: string) => {
      if (files.has(key(uri.fsPath))) {
        return false;
      }
      files.set(key(uri.fsPath), content);
      return true;
    })
  };
});

vi.mock('../../workflowInputs', () => ({
  findWorkspaceFileCandidates: vi.fn(async () => [])
}));

const workspaceFolder = { uri: URI.file('E:/work'), name: 'work', index: 0 };
const aluSource = 'module alu(input [31:0] A, input [31:0] B, output [31:0] C);\nendmodule\n';

function setFile(file: string, text: string): URI {
  const uri = URI.file(file);
  files.set(fileKey(uri.fsPath), text);
  return uri;
}

function readFile(file: string): string | undefined {
  return files.get(fileKey(URI.file(file).fsPath));
}

function normalized(uri: URI | undefined): string | undefined {
  return uri?.fsPath.replace(/\\/g, '/').toLowerCase();
}

function services(): AppServices {
  return {
    output: {
      appendLine: vi.fn(),
      append: vi.fn(),
      show: vi.fn(),
      clear: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      name: 'test'
    } as never,
    statusBar: {} as never
  };
}

describe('P1 module runs with .co/tb testbenches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    files.clear();
    (vscode.workspace.workspaceFolders as unknown[]).splice(0, Infinity, { uri: workspaceFolder.uri, name: 'work' });
    vi.mocked(getProfile).mockReturnValue('P1');
    vi.mocked(findWorkspaceFileCandidates).mockResolvedValue([]);
  });

  it('creates and opens a stimulus scaffold instead of simulating a module without stimulus', async () => {
    const alu = setFile('E:/work/alu.v', aluSource);
    const currentServices = services();

    const result = await ensureRunnableTestbench(currentServices, alu, true);

    expect(result).toBeUndefined();
    const scaffold = readFile('E:/work/.co/tb/alu_tb.v');
    expect(scaffold).toContain('module alu_tb;');
    expect(scaffold).toContain('    alu uut (');
    expect(scaffold).toContain('$monitor("t=%0d A=%h B=%h C=%h", $time, A, B, C);');
    const [openedUri, openOptions] = vi.mocked(vscode.window.showTextDocument).mock.calls[0] ?? [];
    expect(normalized(openedUri as URI)).toBe('e:/work/.co/tb/alu_tb.v');
    expect(openOptions).toEqual({ preview: false });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('.co/tb/alu_tb.v'));
    // The input-less runtime testbench is no longer written or simulated.
    expect(writeTextFile).not.toHaveBeenCalled();
    expect([...files.keys()].some((file) => file.includes('co_generated'))).toBe(false);
  });

  it('simulates an existing .co/tb testbench without rewriting it', async () => {
    const alu = setFile('E:/work/alu.v', aluSource);
    const userText = 'module alu_tb;\n  initial $display("mine");\nendmodule\n';
    setFile('E:/work/.co/tb/alu_tb.v', userText);

    const result = await ensureRunnableTestbench(services(), alu, true);

    expect(result).toMatchObject({ moduleName: 'alu_tb', kind: 'user' });
    expect(normalized(result?.sourceUri)).toBe('e:/work/.co/tb/alu_tb.v');
    expect(result?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFile('E:/work/.co/tb/alu_tb.v')).toBe(userText);
    expect(writeTextFileIfAbsent).not.toHaveBeenCalled();
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
    expect(testbenchCompileSources(workspaceFolder, result!).map(normalized)).toEqual(['e:/work/.co/tb/alu_tb.v']);
  });

  it('prefers a project testbench over .co/tb and keeps it in project order', async () => {
    const alu = setFile('E:/work/alu.v', aluSource);
    const projectTestbench = setFile('E:/work/test/alu_tb.v', 'module alu_tb; endmodule\n');
    setFile('E:/work/.co/tb/alu_tb.v', 'module alu_tb; endmodule\n');
    vi.mocked(findWorkspaceFileCandidates).mockResolvedValue([{ uri: projectTestbench, rank: 0 } as never]);

    const result = await ensureRunnableTestbench(services(), alu, true);

    expect(normalized(result?.sourceUri)).toBe('e:/work/test/alu_tb.v');
    expect(testbenchCompileSources(workspaceFolder, result!)).toEqual([]);
  });

  it('targets the module under test even when the configured P1 top exists', async () => {
    const alu = setFile('E:/work/alu.v', aluSource);
    const main = setFile('E:/work/src/main.v', 'module main(input clk); endmodule\n');
    setFile('E:/work/test/main_tb.v', 'module main_tb; endmodule\n');
    vi.mocked(findWorkspaceFileCandidates).mockResolvedValue([{ uri: main, rank: 0 } as never]);

    const result = await ensureRunnableTestbench(services(), alu, true);

    expect(result).toBeUndefined();
    expect(readFile('E:/work/.co/tb/alu_tb.v')).toContain('module alu_tb;');
  });

  it('runs any module of an active .co/tb file as the testbench', async () => {
    setFile('E:/work/alu.v', aluSource);
    const testbench = setFile('E:/work/.co/tb/check_alu.v', 'module helper; endmodule\nmodule check_alu; endmodule\n');

    const result = await ensureRunnableTestbench(services(), testbench, true);

    expect(result).toMatchObject({ moduleName: 'check_alu', kind: 'active' });
    expect(testbenchCompileSources(workspaceFolder, result!).map(normalized)).toEqual(['e:/work/.co/tb/check_alu.v']);
  });

  it.each(['alu_tb.v', 'alu_testbench.v'])('runs a user-created %s as a testbench', async (fileName) => {
    const testbench = setFile(`E:/work/test/${fileName}`, 'module helper; endmodule\nmodule alu_tb; endmodule\n');

    const result = await ensureRunnableTestbench(services(), testbench, true);

    expect(result).toMatchObject({ moduleName: 'alu_tb', kind: 'active' });
    expect(normalized(result?.sourceUri)).toBe(`e:/work/test/${fileName}`);
    expect(writeTextFileIfAbsent).not.toHaveBeenCalled();
  });

  it('does not treat a non-suffix source file as a testbench because of its module name', async () => {
    const source = setFile('E:/work/alu.v', 'module alu_tb; endmodule\n');

    const result = await ensureRunnableTestbench(services(), source, true);

    expect(result).toBeUndefined();
    expect(readFile('E:/work/.co/tb/alu_tb_tb.v')).toContain('在此编写激励');
  });

  it('stops on an incomplete active custom testbench instead of running another top', async () => {
    const testbench = setFile('E:/work/test/alu_tb.v', 'module alu_tb(');
    setFile('E:/work/main.v', 'module main; endmodule\n');

    const result = await ensureRunnableTestbench(services(), testbench, true);

    expect(result).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('未找到可仿真的模块'));
    expect(writeTextFileIfAbsent).not.toHaveBeenCalled();
  });

  it('does not run a private generated testbench opened in the editor', async () => {
    const privateTb = setFile('E:/work/.co/iverilog/co_generated_auto_tb.v', 'module co_generated_auto_tb; endmodule\n');

    const result = await ensureRunnableTestbench(services(), privateTb, true);

    expect(result).toBeUndefined();
    expect(writeTextFileIfAbsent).not.toHaveBeenCalled();
  });

  it('keeps an existing .co/tb file that no longer declares the testbench module', async () => {
    const alu = setFile('E:/work/alu.v', aluSource);
    setFile('E:/work/.co/tb/alu_tb.v', 'module renamed_tb; endmodule\n');

    const result = await ensureRunnableTestbench(services(), alu, true);

    expect(result).toBeUndefined();
    expect(readFile('E:/work/.co/tb/alu_tb.v')).toBe('module renamed_tb; endmodule\n');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('未找到 testbench 模块 alu_tb'));
    const openedUri = vi.mocked(vscode.window.showTextDocument).mock.calls[0]?.[0] as URI;
    expect(normalized(openedUri)).toBe('e:/work/.co/tb/alu_tb.v');
  });

  it('never lets .co/tb testbenches into the automatic lane', async () => {
    vi.mocked(getProfile).mockReturnValue('P5');
    const mips = setFile('E:/work/mips.v', 'module main(input clk, input reset); endmodule\n');
    setFile('E:/work/.co/tb/main_tb.v', 'module main_tb; initial #1 $finish; endmodule\n');

    const result = await ensureRunnableTestbench(services(), mips, false, undefined, { nonInteractive: true });

    expect(result).toMatchObject({ moduleName: 'co_generated_auto_tb', kind: 'generated' });
    expect(result?.sourceUri).toBeUndefined();
    expect(testbenchCompileSources(workspaceFolder, result!).map(normalized)).toEqual(['e:/work/.co/iverilog/co_generated_auto_tb.v']);
  });
});

describe('.co/tb helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    files.clear();
    (vscode.workspace.workspaceFolders as unknown[]).splice(0, Infinity, { uri: workspaceFolder.uri, name: 'work' });
  });

  it('derives .co/tb locations from the owning workspace folder', () => {
    expect(normalized(userTestbenchUri(URI.file('E:/work/src/alu.v'), 'alu_tb'))).toBe('e:/work/.co/tb/alu_tb.v');
    expect(isUserTestbenchUri(URI.file('E:/work/.co/tb/alu_tb.v'))).toBe(true);
    expect(isUserTestbenchUri(URI.file('E:/work/src/alu_tb.v'))).toBe(false);
    expect(isUserTestbenchUri(URI.file('E:/work/.co/iverilog/co_generated_alu_tb.v'))).toBe(false);
  });

  it('finds a .co/tb testbench only by its declared module name', async () => {
    setFile('E:/work/.co/tb/alu_tb.v', 'module alu_tb; endmodule\n');
    setFile('E:/work/.co/tb/ext_tb.v', 'module other; endmodule\n');

    expect((await findUserTestbench(URI.file('E:/work/alu.v'), 'alu_tb'))?.module.name).toBe('alu_tb');
    expect(await findUserTestbench(URI.file('E:/work/ext.v'), 'ext_tb')).toBeUndefined();
    expect(await findUserTestbench(URI.file('E:/work/gray.v'), 'gray_tb')).toBeUndefined();
  });

  it('appends only generated and undiscoverable testbench sources', () => {
    const generated = URI.file('E:/work/.co/iverilog/co_generated_mips_tb.v');
    expect(testbenchCompileSources(workspaceFolder, { moduleName: 'mips_tb', kind: 'generated', generatedUri: generated }))
      .toEqual([generated]);
    expect(testbenchCompileSources(workspaceFolder, { moduleName: 'mips_tb', kind: 'user', sourceUri: URI.file('E:/work/test/mips_tb.v') }))
      .toEqual([]);
    expect(testbenchCompileSources(workspaceFolder, { moduleName: 'alu_tb', kind: 'user', sourceUri: URI.file('E:/work/.co/tb/alu_tb.v') })
      .map(normalized)).toEqual(['e:/work/.co/tb/alu_tb.v']);
    expect(testbenchCompileSources(workspaceFolder, { moduleName: 'x_tb', kind: 'active', sourceUri: URI.file('E:/other/x_tb.v') })
      .map(normalized)).toEqual(['e:/other/x_tb.v']);
  });

  it('scaffolds configured course tops and other modules for manual stimulus', () => {
    const [mips] = parseVerilog(verilogDoc('module mips(input clk, input reset); endmodule'), defaultCoSettings, false).modules;

    const course = userTestbenchText(mips, 'mips_tb', { profile: 'P5', configuredTop: true, simTime: '1us' });
    expect(course).toContain('在此编写激励');
    expect(course).toContain('$monitor');

    expect(userTestbenchText(mips, 'mips_tb', { profile: 'P1', configuredTop: true, simTime: '1us' })).toContain('$monitor');
    expect(userTestbenchText(mips, 'mips_tb', { profile: 'P5', configuredTop: false, simTime: '1us' })).toContain('在此编写激励');
  });
});
