// @index mips-core — CommitEvent 到课程架构写 trace 的投影（P3/P4 无时间前缀，P5+ 由 DUT 提供）
import { CourseExecutionProfile } from '../profiles/profile';
import { hex8, u32 } from '../values';
import { CommitEvent } from './commitEvent';

/**
 * 课程 GRF/DM 模块的输出格式（[P4-7]、[P5-5-2]、官方 tb）：
 *
 * ```
 * P3/P4  $display("@%h: $%d <= %h",     WPC, Waddr, WData)
 *        $display("@%h: *%h <= %h",     pc,  addr,  din)
 * P5–P7  $display("%d@%h: $%d <= %h",   $time, WPC, Waddr, WData)
 *        $display("%d@%h: *%h <= %h",   $time, pc,  addr,  din)
 * ```
 *
 * oracle 没有周期域，因此永远不生成 `$time` 前缀；比较端忽略该前缀。
 * 只有满足 `w_grf_we && w_grf_addr != 0` 的 GRF 写与 DM 字节使能有效的写会出现：
 * HI/LO、CP0 与外设事务都不进入这条 trace（P7-2-6"写入时无需 display"）。
 *
 * 官方 tb 记录的是 `m_data_addr & ~3` 与按 byte enable 合并后的整字，因此 `sb/sh`
 * 投影为对齐地址加合并 word，而不是原始地址与原始值（计划第 5.4 节）。
 */

export type ArchitecturalWriteKind = 'grf' | 'dm';

export interface ArchitecturalWriteRecord {
  /** 8-digit uppercase hex PC of the instruction that produced the write. */
  readonly pc: string;
  readonly kind: ArchitecturalWriteKind;
  /** Decimal register number for `grf`, 8-digit uppercase hex address for `dm`. */
  readonly target: string;
  /** 8-digit uppercase hex written value. */
  readonly value: string;
}

/** Project one commit event into the course architectural write records it produces. */
export function projectCommitEvent(
  event: CommitEvent,
  profile: CourseExecutionProfile
): ArchitecturalWriteRecord[] {
  const records: ArchitecturalWriteRecord[] = [];
  const pc = upperHex8(event.pcBefore);
  for (const write of event.gprWrites) {
    if (profile.trace.suppressZeroRegisterWrites && write.register === 0) {
      continue;
    }
    records.push({
      pc,
      kind: 'grf',
      target: String(write.register),
      value: upperHex8(write.value)
    });
  }
  for (const write of event.memoryWrites) {
    // Only the data memory port is wired to the course DM module; timer and
    // interrupt-generator transactions travel over the bridge's device ports.
    if (write.region !== 'data') {
      continue;
    }
    const address = profile.trace.wordAlignedStores ? write.wordAddress : write.address;
    const value = profile.trace.wordAlignedStores ? write.valueAfter : write.rawValue;
    records.push({
      pc,
      kind: 'dm',
      target: upperHex8(address),
      value: upperHex8(value)
    });
  }
  return records;
}

/** Project a whole event stream. */
export function projectCommitEvents(
  events: Iterable<CommitEvent>,
  profile: CourseExecutionProfile
): ArchitecturalWriteRecord[] {
  const records: ArchitecturalWriteRecord[] = [];
  for (const event of events) {
    records.push(...projectCommitEvent(event, profile));
  }
  return records;
}

/**
 * Render one record in the canonical course form. `cycle` is only supplied when a
 * DUT-side trace is being reproduced; the oracle never invents one.
 */
export function formatArchitecturalWrite(
  record: ArchitecturalWriteRecord,
  cycle?: number
): string {
  const prefix = cycle === undefined ? '' : String(cycle);
  const marker = record.kind === 'grf' ? '$' : '*';
  return `${prefix}@${record.pc}: ${marker}${record.target} <= ${record.value}`;
}

/** Render a whole projected trace, one record per line. */
export function formatArchitecturalWrites(
  records: readonly ArchitecturalWriteRecord[]
): string {
  return records.map((record) => formatArchitecturalWrite(record)).join('\n');
}

/** Revision of this projection; participates in the execution evidence fingerprint. */
export const traceProjectionRevision = 1 as const;

function upperHex8(value: number): string {
  return hex8(u32(value)).toUpperCase();
}
