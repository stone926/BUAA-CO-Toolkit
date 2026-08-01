import { describe, expect, it } from 'vitest';
import { CpuState, courseDataByteLength } from '../../courseTesting/cpuState';

describe('built-in generator CPU state', () => {
  it('models the complete 0x0000..0x2fff course data memory', () => {
    const state = new CpuState();

    expect(courseDataByteLength).toBe(0x3000);
    expect(state.memory.size).toBe(0x3000 / 4);
    expect(state.wordAt(0x2ffc)).toBe(0);
  });

  it('matches modified-MARS little-endian LWL/LWR merge semantics at every byte offset', () => {
    const state = new CpuState();
    state.memory.set(0x100, 0x44332211);
    const previous = 0xaabbccdd;

    expect([0, 1, 2, 3].map((offset) => state.loadWordLeft(0x100 + offset, previous) >>> 0))
      .toEqual([0x11bbccdd, 0x2211ccdd, 0x332211dd, 0x44332211]);
    expect([0, 1, 2, 3].map((offset) => state.loadWordRight(0x100 + offset, previous) >>> 0))
      .toEqual([0x44332211, 0xaa443322, 0xaabb4433, 0xaabbcc44]);
  });

  it('matches modified-MARS little-endian SWL/SWR byte placement at every offset', () => {
    const swl = [0, 1, 2, 3].map((offset) => {
      const state = new CpuState();
      state.storeWordLeft(0x100 + offset, 0xaabbccdd);
      return state.wordAt(0x100) >>> 0;
    });
    const swr = [0, 1, 2, 3].map((offset) => {
      const state = new CpuState();
      state.storeWordRight(0x100 + offset, 0xaabbccdd);
      return state.wordAt(0x100) >>> 0;
    });

    expect(swl).toEqual([0x000000aa, 0x0000aabb, 0x00aabbcc, 0xaabbccdd]);
    expect(swr).toEqual([0xaabbccdd, 0xbbccdd00, 0xccdd0000, 0xdd000000]);
  });

  it('does not treat HI or LO reset values as architecturally initialized', () => {
    const state = new CpuState();

    expect(state.hiInitialized).toBe(false);
    expect(state.loInitialized).toBe(false);
  });
});
