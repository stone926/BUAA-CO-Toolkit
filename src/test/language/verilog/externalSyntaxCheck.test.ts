import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultCoSettings } from '../../../language/common/settings';
import { runExternalVerilogSyntaxCheck } from '../../../language/verilog/externalSyntaxCheck';
import { runIseSyntaxCheck } from '../../../language/verilog/iseSyntaxCheck';
import { runIverilogSyntaxCheck } from '../../../language/verilog/iverilogSyntaxCheck';

vi.mock('../../../language/verilog/iseSyntaxCheck', () => ({
  runIseSyntaxCheck: vi.fn()
}));

vi.mock('../../../language/verilog/iverilogSyntaxCheck', () => ({
  runIverilogSyntaxCheck: vi.fn()
}));

function baseOptions(isePath: string) {
  return {
    workspaceFolders: [],
    triggerUri: 'file:///workspace/top.v',
    extensionRoot: 'C:/extension',
    isePath,
    topModule: 'top',
    timeoutMs: 5000,
    settings: defaultCoSettings
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    diagnosticsByUri: new Map(),
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides
  };
}

describe('external Verilog syntax dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runIverilogSyntaxCheck).mockResolvedValue(result());
    vi.mocked(runIseSyntaxCheck).mockResolvedValue(result());
  });

  it('selects bundled Icarus by default even when isePath is configured', async () => {
    const actual = await runExternalVerilogSyntaxCheck(baseOptions('D:/ISE/14.7/ISE_DS/ISE'));
    expect(actual.backend).toBe('iverilog');
    expect(runIverilogSyntaxCheck).toHaveBeenCalledOnce();
    expect(runIseSyntaxCheck).not.toHaveBeenCalled();
  });

  it('selects ISE only for an explicit backend request', async () => {
    const signal = new AbortController().signal;
    const actual = await runExternalVerilogSyntaxCheck({
      ...baseOptions('D:/ISE/14.7/ISE_DS/ISE'),
      backend: 'isim',
      signal
    });
    expect(actual.backend).toBe('isim');
    expect(runIseSyntaxCheck).toHaveBeenCalledWith(expect.objectContaining({ signal }));
    expect(runIverilogSyntaxCheck).not.toHaveBeenCalled();
  });

  it('reports an invalid explicit ISE path and never falls back to Icarus', async () => {
    vi.mocked(runIseSyntaxCheck).mockResolvedValue(result({
      ok: false,
      skipped: 'missing-toolchain'
    }));

    const actual = await runExternalVerilogSyntaxCheck({
      ...baseOptions('D:/broken-ISE'),
      backend: 'isim'
    });

    expect(actual.backend).toBe('isim');
    expect(actual.toolchainError).toContain('不会回退到内置 Icarus');
    expect(actual.diagnosticsByUri.get('file:///workspace/top.v')?.[0]).toMatchObject({
      code: 'ise-toolchain',
      severity: 1
    });
    expect(runIverilogSyntaxCheck).not.toHaveBeenCalled();
  });

  it('converts ISE project setup errors into a diagnostic instead of rejecting', async () => {
    vi.mocked(runIseSyntaxCheck).mockRejectedValueOnce(new Error('EACCES writing .co/ise-check'));

    const actual = await runExternalVerilogSyntaxCheck({
      ...baseOptions('D:/ISE'),
      backend: 'isim'
    });

    expect(actual).toMatchObject({ backend: 'isim', ok: false, timedOut: false });
    expect(actual.toolchainError).toContain('EACCES');
    expect(actual.diagnosticsByUri.get('file:///workspace/top.v')?.[0]).toMatchObject({
      code: 'ise-toolchain',
      severity: 1
    });
    expect(runIverilogSyntaxCheck).not.toHaveBeenCalled();
  });
});
