import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import { findExistingTestbenchResolution } from '../../verilog/testbenchResolver';
import { verilogProjectExcludeGlob } from '../../verilogSimulationFiles';
import { findWorkspaceFileCandidates } from '../../workflowInputs';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('../helpers/vscodeMock').createVscodeMockState> | undefined,
  module: undefined as ReturnType<typeof import('../helpers/vscodeMock').createVscodeModuleMock> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  vscodeState.module = createVscodeModuleMock(vscodeState.state, vi.fn);
  return vscodeState.module;
});

vi.mock('../../config', () => ({
  config: vi.fn((_key: string, fallback: unknown) => fallback),
  getIsePath: vi.fn(() => 'D:/ISE'),
  getProfile: vi.fn(() => 'P6'),
  getRunTimeout: vi.fn(() => 120000),
  getSimTime: vi.fn(() => '200us'),
  getTestbench: vi.fn(() => 'mips_tb'),
  getTopModule: vi.fn(() => 'mips')
}));

vi.mock('../../fsUtil', async () => {
  const actual = await vi.importActual<typeof import('../../fsUtil')>('../../fsUtil');
  return {
    ...actual,
    ensureDirectory: vi.fn(async () => undefined),
    isFile: vi.fn(async () => true),
    pathExists: vi.fn(async () => false),
    workspaceFolderFor: vi.fn(() => ({ uri: URI.file('E:/work'), name: 'work', index: 0 })),
    workspaceFolderForOrFirst: vi.fn(() => ({ uri: URI.file('E:/work'), name: 'work', index: 0 })),
    writeTextFile: vi.fn(async () => undefined)
  };
});

vi.mock('../../workflowInputs', () => ({
  findWorkspaceFileCandidates: vi.fn()
}));

describe('testbench workspace discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeState.state!.workspaceFolders.splice(0, vscodeState.state!.workspaceFolders.length, {
      uri: URI.file('E:/work'),
      name: 'work'
    });
    vscodeState.module!.workspace.fs.readFile.mockResolvedValue(Buffer.from('module mips_tb; endmodule\n'));
  });

  it('excludes editor-owned .vscode testbench copies before conflict ranking', async () => {
    const rootTestbench = URI.file('E:/work/mips_tb.v');
    vi.mocked(findWorkspaceFileCandidates).mockImplementation(async (options) => {
      expect(options.exclude).toBe(verilogProjectExcludeGlob);
      expect(options.exclude).toContain('.vscode');
      expect(options.exclude).toContain('.vscode-test');
      return [{ uri: rootTestbench, relative: 'mips_tb.v' }];
    });

    const result = await findExistingTestbenchResolution(URI.file('E:/work/program.asm'), 'mips_tb');

    expect(result.conflict).toBe(false);
    expect(result.resolution?.sourceUri?.fsPath).toBe(rootTestbench.fsPath);
    expect(findWorkspaceFileCandidates).toHaveBeenCalledTimes(1);
  });
});
