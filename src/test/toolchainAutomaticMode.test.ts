import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMipsEngine: vi.fn(() => 'mars'),
  runTool: vi.fn()
}));

vi.mock('vscode', () => ({
  workspace: {},
  window: {}
}));

vi.mock('../config', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config')>(),
  ensureConcreteProfile: vi.fn(async () => 'P7'),
  getHazardCalculator: vi.fn(() => ''),
  getIsePath: vi.fn(() => ''),
  getJava: vi.fn(() => 'SECRET_JAVA'),
  getLogisimJar: vi.fn(() => 'SECRET_LOGISIM'),
  getMarsJar: vi.fn(() => 'SECRET_MARS'),
  getMipsEngine: mocks.getMipsEngine,
  getProfile: vi.fn(() => 'P7'),
  resolvePython: vi.fn(async () => 'SECRET_PYTHON')
}));

vi.mock('../process', () => ({ runTool: mocks.runTool }));

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
});
