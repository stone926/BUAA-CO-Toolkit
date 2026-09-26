import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runExternalVerilogSyntaxCheck } from '../../../language/verilog/externalSyntaxCheck';
import { runIverilogSyntaxCheck } from '../../../language/verilog/iverilogSyntaxCheck';

vi.mock('../../../language/verilog/iverilogSyntaxCheck', () => ({
  runIverilogSyntaxCheck: vi.fn()
}));

const options = {
  workspaceFolders: [],
  triggerUri: 'file:///workspace/top.v',
  extensionRoot: 'C:/extension',
  timeoutMs: 5000
};

describe('external Verilog syntax check', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs bundled Icarus and preserves diagnostics', async () => {
    const signal = new AbortController().signal;
    const diagnosticsByUri = new Map([['file:///workspace/top.v', []]]);
    vi.mocked(runIverilogSyntaxCheck).mockResolvedValue({
      ok: true,
      diagnosticsByUri,
      stdout: '',
      stderr: '',
      timedOut: false
    });

    await expect(runExternalVerilogSyntaxCheck({ ...options, signal })).resolves.toMatchObject({
      backend: 'iverilog', ok: true, diagnosticsByUri
    });
    expect(runIverilogSyntaxCheck).toHaveBeenCalledWith(expect.objectContaining({ signal }));
  });

  it('reports an Icarus startup error as a diagnostic', async () => {
    vi.mocked(runIverilogSyntaxCheck).mockRejectedValueOnce(new Error('EACCES'));

    const result = await runExternalVerilogSyntaxCheck(options);

    expect(result).toMatchObject({ backend: 'iverilog', ok: false, timedOut: false });
    expect(result.toolchainError).toContain('EACCES');
    expect(result.diagnosticsByUri.get(options.triggerUri)?.[0]).toMatchObject({
      code: 'iverilog-toolchain', severity: 1
    });
  });
});
