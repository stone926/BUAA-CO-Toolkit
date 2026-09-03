import { describe, expect, it } from 'vitest';
import { firstDmStoreDifference } from '../../courseTesting/dmStoreCheck';
import type { CommitEvent, MemoryWrite } from '../../mips/core/events/commitEvent';

function store(overrides: Partial<MemoryWrite> = {}, pc = 0x3000): CommitEvent {
  return {
    sequence: 0, kind: 'instruction', pcBefore: pc, pcAfter: pc + 4,
    gprWrites: [], hiLoWrites: [], cp0Writes: [], deviceEvents: [],
    memoryWrites: [{
      address: 1, wordAddress: 0, byteMask: 2, rawValue: 0x11,
      valueBefore: 0x11111111, valueAfter: 0x11111111, region: 'data', ...overrides
    }]
  };
}

describe('public DM store transaction comparison', () => {
  it('rejects a full-word read-modify-write sb even when the merged memory word is unchanged', () => {
    expect(firstDmStoreDifference([store()],
      'CO_DM_STORE pc=00003000 addr=00000001 byteen=1111 wdata=11111111'
    )?.reason).toContain('byte-enable 应为 0010');
  });

  it('rejects a wrong byte address even when equal bytes hide it in the merged word', () => {
    expect(firstDmStoreDifference([store()],
      'CO_DM_STORE pc=00003000 addr=00000002 byteen=0100 wdata=11111111'
    )?.reason).toContain('byte-enable 应为 0010');
  });

  it('compares the word address without requiring ignored SW address bits to be zero', () => {
    const word = store({ address: 0, byteMask: 15 });
    expect(firstDmStoreDifference([word],
      'CO_DM_STORE pc=00003000 addr=00000003 byteen=1111 wdata=11111111'
    )).toBeUndefined();
    expect(firstDmStoreDifference([word],
      'CO_DM_STORE pc=00003000 addr=00000004 byteen=1111 wdata=11111111'
    )?.reason).toContain('目标 word 应为 0x00000000');
  });

  it('uses the explicit word address when irrelevant raw low bits are unknown', () => {
    expect(firstDmStoreDifference([store({ address: 4, wordAddress: 4, byteMask: 15 })],
      'CO_DM_STORE pc=00003000 addr=0000000x word=00000004 byteen=1111 wdata=11111111'
    )).toBeUndefined();
    expect(firstDmStoreDifference([store({ address: 6, wordAddress: 4, byteMask: 12 })],
      'CO_DM_STORE pc=00003000 addr=0000000x word=00000004 byteen=1100 wdata=1111xxxx'
    )).toBeUndefined();
    expect(firstDmStoreDifference([store()],
      'CO_DM_STORE pc=00003000 addr=0000000x byteen=0010 wdata=11111111'
    )?.reason).toContain('缺少确定的 word 地址');
  });

  it.each(['xxxx11xx', 'zzzz11zz', 'abcd11ef'])('accepts arbitrary disabled lanes: %s', (value) => {
    expect(firstDmStoreDifference([store()],
      `CO_DM_STORE pc=00003000 addr=00000001 byteen=0010 wdata=${value}`
    )).toBeUndefined();
  });

  it.each(['xxxx22xx', 'xxxx1xxx', 'xxxxzzxx'])('rejects incorrect or unknown enabled lanes: %s', (value) => {
    expect(firstDmStoreDifference([store()],
      `CO_DM_STORE pc=00003000 addr=00000001 byteen=0010 wdata=${value}`
    )?.reason).toContain('有效 byte lane 1');
  });

  it('compares high halfword and partial-word store lanes without imposing unused lane values', () => {
    const writes = [
      store({ address: 2, byteMask: 12, valueAfter: 0xaabb1111 }),
      store({ address: 1, byteMask: 3, valueAfter: 0xaabbccdd }, 0x3004),
      store({ address: 1, byteMask: 14, valueAfter: 0x123456dd }, 0x3008)
    ];
    expect(firstDmStoreDifference(writes, [
      'CO_DM_STORE pc=00003000 addr=00000002 byteen=1100 wdata=aabbxxxx',
      'CO_DM_STORE pc=00003004 addr=00000001 byteen=0011 wdata=zzzzccdd',
      'CO_DM_STORE pc=00003008 addr=00000001 byteen=1110 wdata=123456xx'
    ].join('\r\n'))).toBeUndefined();
  });

  it('rejects missing, duplicated, malformed and reordered transactions', () => {
    const row = 'CO_DM_STORE pc=00003000 addr=00000001 byteen=0010 wdata=11111111';
    expect(firstDmStoreDifference([store()], '')?.status).toBe('oracle-only');
    expect(firstDmStoreDifference([store()], `${row}\n${row}`)?.status).toBe('dut-only');
    expect(firstDmStoreDifference([store()], row.replace('0010', '00x0'))?.reason).toContain('字段未知');
    expect(firstDmStoreDifference([store()], row.replace('pc=00003000', 'pc=00003004'))?.reason).toContain('PC 应为');
  });

  it('ignores GPR timing and device writes while keeping repeated DM writes at the same PC', () => {
    const row = 'CO_DM_STORE pc=00003000 addr=00000001 byteen=0010 wdata=11111111';
    expect(firstDmStoreDifference([
      store({ region: 'timer0', address: 0x7f00 }), store(), store()
    ], `${row}\n10@00003008: $2 <= 00000001\n${row} time=500`)).toBeUndefined();
  });
});
