import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMipsEngine: vi.fn(() => 'mars'),
  runTool: vi.fn(),
  preflightIverilogRuntime: vi.fn(async () => ({ version: 'Icarus Verilog 13.0' }))
}));

vi.mock('vscode', () => ({
  workspace: {},
  window: {}
}));

vi.mock('../config', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config')>(),
  ensureConcreteProfile: vi.fn(async () => 'P7'),
  getHazardCalculator: vi.fn(() => ''),
  getIsePath: vi.fn(() => 'D:/stale-and-invalid-ISE'),
  getJava: vi.fn(() => 'SECRET_JAVA'),
  getLogisimJar: vi.fn(() => 'SECRET_LOGISIM'),
  getMarsJar: vi.fn(() => 'SECRET_MARS'),
  getMipsEngine: mocks.getMipsEngine,
  getProfile: vi.fn(() => 'P7'),
  resolvePython: vi.fn(async () => 'SECRET_PYTHON')
}));

vi.mock('../process', () => ({ runTool: mocks.runTool }));
vi.mock('../verilog/iverilogRuntime', () => ({
  IverilogRuntimeError: class IverilogRuntimeError extends Error {},
  preflightIverilogRuntime: mocks.preflightIverilogRuntime
}));

import { checkToolchain } from '../toolchain';

describe('automatic toolchain engine boundary', () => {
  it('does not inherit a workspace MARS rollback or launch legacy capability probes', async () => {
    const checks = await checkToolchain(
      { append: vi.fn(), appendLine: vi.fn() } as never,
      undefined,
      { nonInteractive: true, engineMode: 'builtin' }
    );

    expect(mocks.getMipsEngine).not.toHaveBeenCalled();
    expect(mocks.runTool).not.toHaveBeenCalled();
    expect(checks.map((check) => check.name)).not.toContain('MARS');
    expect(JSON.stringify(checks)).not.toContain('SECRET_MARS');
  });

  it('preflights bundled Icarus even when a stale ISE path is configured', async () => {
    const checks = await checkToolchain(
      { append: vi.fn(), appendLine: vi.fn() } as never,
      undefined,
      {
        nonInteractive: true,
        engineMode: 'builtin',
        extensionRoot: 'E:/extension'
      }
    );

    expect(mocks.preflightIverilogRuntime).toHaveBeenCalledWith('E:/extension', { timeoutMs: 10_000 });
    expect(checks).toContainEqual(expect.objectContaining({
      name: 'Verilog simulator',
      ok: true,
      detail: 'Icarus Verilog 13.0 (bundled)'
    }));
    expect(JSON.stringify(checks)).not.toContain('ISE');
  });
});
