// @index mips-core — 执行覆盖率分箱：指令、分支双向、字节车道、地址边界与 P7 异常/中断场景
import { CourseExecutionProfile } from '../profiles/profile';
import { hex8 } from '../values';
import { CommitEvent } from './commitEvent';

/**
 * 生产侧覆盖率投影。它服务于报告与诊断，**不是** conformance 的证据分箱：
 * 独立 harness 必须自己分箱，否则实现与测试会共享同一张错误表（计划第 7.1 节）。
 *
 * bin id 采用与 `evidence-gates.json` 相同的 `{idPrefix}.{member}` 展开规则，
 * 便于人工核对两侧是否覆盖了同一组语义，而不是共享代码。
 */

export interface CoverageBin {
  readonly id: string;
  readonly hits: number;
}

export const executionCoverageRevision = 1 as const;

export class ExecutionCoverageCollector {
  private readonly counts = new Map<string, number>();

  constructor(private readonly profile: CourseExecutionProfile) {}

  observe(event: CommitEvent): void {
    if (event.mnemonic) {
      this.hit(`execution.instruction.${this.profile.id}.${event.mnemonic}`);
    }
    if (event.delaySlot) {
      this.hit(event.kind === 'instruction'
        ? 'execution.delay-slot.committed'
        : 'execution.delay-slot.victim');
    }
    if (event.branchTaken !== undefined && event.mnemonic) {
      this.hit(`execution.branch.${event.mnemonic}.${event.branchTaken ? 'taken' : 'not-taken'}`);
    }
    for (const write of event.memoryWrites) {
      this.observeLanes('store', event.mnemonic, write.byteMask);
      this.observeBoundary(write.wordAddress);
    }
    for (const read of event.memoryReads ?? []) {
      this.observeLanes('load', event.mnemonic, laneMaskForWidth(read.address, read.width));
      this.observeBoundary(read.wordAddress);
    }
    for (const write of event.hiLoWrites) {
      this.hit(`execution.hilo.write-${write.register}`);
    }
    for (const write of event.cp0Writes) {
      this.hit(`execution.cp0-write.${write.register}`);
    }
    if (event.trap) {
      if (event.trap.kind === 'interrupt') {
        this.hit('execution.interrupt.accepted');
        for (const source of interruptSources(event.trap.hardwareInterrupts ?? 0, this.profile)) {
          this.hit(`execution.interrupt.${source}`);
        }
      } else {
        this.hit(`execution.exception.${event.trap.name}.${event.trap.stage ?? 'unknown'}`);
      }
      this.hit(`execution.trap-bd.${event.trap.branchDelay ? 'delay-slot' : 'normal'}`);
    }
    for (const device of event.deviceEvents) {
      this.hit(`execution.device.${device.device}.${device.kind}`);
    }
  }

  bins(): readonly CoverageBin[] {
    return [...this.counts.entries()]
      .map(([id, hits]) => ({ id, hits }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  hits(id: string): number {
    return this.counts.get(id) ?? 0;
  }

  private observeLanes(kind: 'load' | 'store', mnemonic: string | undefined, byteMask: number): void {
    if (!mnemonic) {
      return;
    }
    for (let lane = 0; lane < 4; lane++) {
      if ((byteMask >>> lane) & 1) {
        this.hit(`execution.${kind}-lane.${mnemonic}.${lane}`);
      }
    }
  }

  private observeBoundary(wordAddress: number): void {
    for (const region of this.profile.memoryRegions) {
      if (wordAddress === region.range.start) {
        this.hit(`execution.address-boundary.${region.id}.first`);
      }
      if (wordAddress === ((region.range.endInclusive - 3) >>> 0)) {
        this.hit(`execution.address-boundary.${region.id}.last`);
      }
    }
    for (const region of this.profile.deviceRegions) {
      if (wordAddress >= region.range.start && wordAddress <= region.range.endInclusive) {
        this.hit(`execution.address-boundary.${region.id}.${hex8(wordAddress - region.range.start)}`);
      }
    }
  }

  private hit(id: string): void {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
  }
}

function laneMaskForWidth(address: number, width: number): number {
  const offset = address & 3;
  if (width >= 4) {
    return 0b1111;
  }
  if (width === 2) {
    return offset < 2 ? 0b0011 : 0b1100;
  }
  return 1 << offset;
}

function interruptSources(
  hardwareInterrupts: number,
  profile: CourseExecutionProfile
): readonly string[] {
  const wiring = profile.exceptions?.wiring;
  if (!wiring) {
    return [];
  }
  const sources: string[] = [];
  if ((hardwareInterrupts >>> wiring.timer0Bit) & 1) {
    sources.push('timer0');
  }
  if ((hardwareInterrupts >>> wiring.timer1Bit) & 1) {
    sources.push('timer1');
  }
  if ((hardwareInterrupts >>> wiring.interruptGeneratorBit) & 1) {
    sources.push('external');
  }
  return sources;
}
