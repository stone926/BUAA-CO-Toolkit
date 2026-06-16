import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => {
  const { URI } = await import('vscode-uri');
  return {
    Uri: {
      file: (file: string) => URI.file(file)
    },
    workspace: {
      workspaceFolders: [],
      fs: {
        createDirectory: vi.fn()
      },
      getWorkspaceFolder: vi.fn()
    },
    window: {}
  };
});

import { isimOutputFileName, samePath } from '../verilogIsimOutput';

describe('Verilog ISim output helpers', () => {
  it('uses the testbench name for default simulation output', () => {
    expect(isimOutputFileName('mips_tb')).toBe('mips_tb.sim.out');
  });

  it('keeps only the basename of configured simulation output', () => {
    expect(isimOutputFileName('mips_tb', 'logs/custom.out')).toBe('custom.out');
  });

  it('compares normalized filesystem paths', () => {
    const root = path.join('C:', 'workspace', 'cpu');

    expect(samePath(path.join(root, 'out', '..', 'code.txt'), path.join(root, 'code.txt'))).toBe(true);
  });
});
