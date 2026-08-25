import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {},
  workspace: {}
}));

import { p3LogisimRomCapacityError, runP3LogisimTraceCase } from '../courseTestLogisim';
import type { LogisimRomTarget } from '../language/logisim/rom';

describe('course test Logisim helpers', () => {
  it('reports the course IFU capacity limit first', () => {
    const target = { index: 0, addrWidth: 20 } as LogisimRomTarget;

    expect(p3LogisimRomCapacityError(target, 5000)).toBe('P3 Logisim 机器码共有 5000 words，超过教程 IFU 4096 words 容量');
  });

  it('reports selected ROM address capacity limits', () => {
    const target = { index: 0, addrWidth: 4 } as LogisimRomTarget;

    expect(p3LogisimRomCapacityError(target, 17)).toBe('所选 Logisim ROM 地址宽度为 4，容量 16 words，小于本用例 17 words');
  });

  it('accepts unknown or large ROM capacities', () => {
    expect(p3LogisimRomCapacityError({ index: 0 } as LogisimRomTarget, 128)).toBeUndefined();
    expect(p3LogisimRomCapacityError({ index: 0, addrWidth: 31 } as LogisimRomTarget, 4096)).toBeUndefined();
  });

  it('returns a neutral DUT-stage result for an unsupported stdin case', async () => {
    const result = await runP3LogisimTraceCase(
      { output: { appendLine: vi.fn() } } as never,
      {
        asm: { fsPath: 'E:/workspace/test.asm' } as never,
        stdin: { fsPath: 'E:/workspace/test.in' } as never
      }
    );

    expect(result).toMatchObject({
      asm: 'E:/workspace/test.asm',
      stdin: 'E:/workspace/test.in',
      status: 'error',
      stage: 'dut'
    });
    expect(result).not.toHaveProperty('logisimOut');
    expect(result).not.toHaveProperty('simOut');
  });
});
