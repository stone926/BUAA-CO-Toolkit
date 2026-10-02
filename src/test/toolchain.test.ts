import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runTool: vi.fn(),
  profile: 'P2',
  mode: 'auto'
}));

vi.mock('vscode', () => ({ workspace: { workspaceFolders: [] }, window: {} }));
vi.mock('../config', () => ({
  ensureConcreteProfile: vi.fn(),
  getJava: () => 'java',
  getLogisimJar: () => 'Logisim.jar',
  getMipsEngine: () => mocks.mode,
  getProfile: () => mocks.profile
}));
vi.mock('../process', () => ({ runTool: mocks.runTool }));
vi.mock('../fsUtil', () => ({ isFile: vi.fn(async () => true) }));

import { checkToolchain } from '../toolchain';

const output = { append: vi.fn(), appendLine: vi.fn() } as never;

describe('toolchain checks', () => {
  it('requires no external tools for P2 MIPS projects', async () => {
    mocks.profile = 'P2';
    mocks.runTool.mockReset();

    await expect(checkToolchain(output)).resolves.toEqual([]);
    expect(mocks.runTool).not.toHaveBeenCalled();
  });

  it('keeps Java and Logisim checks for Logisim profiles', async () => {
    mocks.profile = 'P3';
    mocks.runTool.mockReset().mockResolvedValue({
      ok: true,
      stdout: '',
      stderr: 'openjdk version 21',
      exitCode: 0,
      timedOut: false
    });

    await expect(checkToolchain(output)).resolves.toEqual([
      expect.objectContaining({ name: 'Java', ok: true }),
      expect.objectContaining({ name: 'Logisim', ok: true })
    ]);
    expect(mocks.runTool).toHaveBeenCalledTimes(1);
    expect(mocks.runTool.mock.calls[0][1]).toEqual(['-version']);
  });

  it.each(['auto', 'builtin', 'mars', 'verify-both'])(
    'never launches an external MIPS tool for P7 with %s engine setting', async (mode) => {
      mocks.profile = 'P7';
      mocks.mode = mode;
      mocks.runTool.mockReset();

      const checks = await checkToolchain(output);
      expect(mocks.runTool).not.toHaveBeenCalled();
      expect(checks.map((check) => check.name)).toEqual(['Verilog simulator']);
    }
  );
});
