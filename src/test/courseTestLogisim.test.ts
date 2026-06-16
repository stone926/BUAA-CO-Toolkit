import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {},
  workspace: {}
}));

import { p3LogisimRomCapacityError } from '../courseTestLogisim';
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
});
