// @index course-testing — 公开 DM 写事务与 oracle 原始地址、byte-enable 和有效字节的无时序比较
import type { NeutralTraceDiffSnapshot } from '../language/mips/traceCompare';
import type { CommitEvent, MemoryWrite } from '../mips/core/events/commitEvent';
import { hex8 } from '../mips/core/values';

interface ExpectedStore {
  pc: number;
  write: MemoryWrite;
}

/** Compare only ordered DM transactions, independent of GPR writeback timing. */
export function firstDmStoreDifference(
  events: readonly CommitEvent[],
  output: string
): NeutralTraceDiffSnapshot | undefined {
  const expected = expectedStores(events);
  const actual = output.matchAll(/^[ \t]*CO_DM_STORE\b[^\r\n]*/gm);
  for (let index = 0; ; index++) {
    const left = expected.next().value as ExpectedStore | undefined;
    const right = actual.next().value?.[0].trim();
    if (!left && right === undefined) return undefined;
    const difference = (reason: string): NeutralTraceDiffSnapshot => ({
      index,
      status: !left ? 'dut-only' : right === undefined ? 'oracle-only' : 'diff',
      reason: `DM 写事务 #${index + 1}${left ? ` (PC=0x${hex8(left.pc)})` : ''}：${reason}`
    });
    if (!left) return difference('DUT 多出有效写事务');
    if (right === undefined) return difference('缺少 DUT 原始写事务记录');
    const fields = /^CO_DM_STORE pc=([0-9a-f]{8}) addr=([0-9a-fxz]{8})(?: word=([0-9a-f]{8}))? byteen=([01]{4}) wdata=([0-9a-fxz]{8})(?: time=\d+)?$/i.exec(right);
    if (!fields) return difference('原始写事务字段未知或格式不合法');
    const pc = Number.parseInt(fields[1], 16);
    // A low ignored X bit renders a whole hex nibble as X. New observers carry
    // the separately aligned word address so known address bits are not lost.
    if (!fields[3] && !/^[0-9a-f]{8}$/i.test(fields[2])) {
      return difference('未知原始地址缺少确定的 word 地址');
    }
    const address = Number.parseInt(fields[3] ?? fields[2], 16);
    if (fields[3] && (address & 3)) return difference('记录的 word 地址未对齐');
    const mask = Number.parseInt(fields[4], 2);
    const { write } = left;
    if (pc !== left.pc) return difference(`PC 应为 0x${hex8(left.pc)}，实际为 0x${hex8(pc)}`);
    // The port addresses a word; SB/SH choose its bytes through byte-enable.
    // P6's table explicitly ignores SW's low two address bits and SH's bit 0.
    // Opcode/address-to-mask consistency is checked by the testbench itself.
    if ((address >>> 2) !== (write.wordAddress >>> 2)) {
      return difference(`目标 word 应为 0x${hex8(write.wordAddress)}，实际地址为 0x${hex8(address)}`);
    }
    if (mask !== write.byteMask) {
      return difference(`byte-enable 应为 ${write.byteMask.toString(2).padStart(4, '0')}，实际为 ${fields[4]}`);
    }
    // The merged oracle word contains the exact value of every enabled lane.
    // Ignore disabled lanes entirely, including X/Z and arbitrary known data.
    const value = fields[5].toLowerCase();
    const expectedValue = hex8(write.valueAfter).toLowerCase();
    for (let lane = 0; lane < 4; lane++) {
      if (!(mask & (1 << lane))) continue;
      const start = (3 - lane) * 2;
      if (value.slice(start, start + 2) !== expectedValue.slice(start, start + 2)) {
        return difference(`有效 byte lane ${lane} 应为 ${expectedValue.slice(start, start + 2)}，实际为 ${value.slice(start, start + 2)}`);
      }
    }
  }
}

function* expectedStores(events: readonly CommitEvent[]): Generator<ExpectedStore> {
  for (const event of events) {
    for (const write of event.memoryWrites) {
      if (write.region === 'data') yield { pc: event.pcBefore, write };
    }
  }
}
