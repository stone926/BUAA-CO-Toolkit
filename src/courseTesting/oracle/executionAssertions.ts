// @index course-testing-oracle — CommitEvent assertion/watchpoint 观察器（流式、有界、可取消）

import type { CommitEvent } from '../../mips/core/events/commitEvent';
import { hex8Address } from '../../mips/core/values';

export type WatchpointKind = 'instruction' | 'gpr-write' | 'memory-write' | 'cp0-write' | 'trap' | 'device';

export interface CourseWatchpoint {
  readonly id: string;
  readonly kind: WatchpointKind;
  /** PC matcher for instruction/trap watchpoints. */
  readonly pc?: number;
  readonly register?: number;
  readonly cp0Register?: number;
  /** Aligned word address for memory writes. */
  readonly memoryAddress?: number;
  readonly device?: string;
  /** Stop observing after this many hits; unbounded otherwise. */
  readonly limit?: number;
}

export interface CourseAssertion {
  readonly id: string;
  readonly kind: 'trap' | 'no-trap' | 'halt-pc' | 'max-hits';
  readonly trapName?: string;
  readonly haltPc?: number;
  readonly watchpointId?: string;
  readonly minHits?: number;
  readonly maxHits?: number;
}

export interface WatchpointHit {
  readonly watchpointId: string;
  readonly sequence: number;
  readonly pc: string;
  readonly detail: string;
}

export interface AssertionFailure {
  readonly assertionId: string;
  readonly message: string;
}

export interface ExecutionObservation {
  readonly watchpointHits: readonly WatchpointHit[];
  readonly assertionFailures: readonly AssertionFailure[];
}

export class ExecutionAssertionObserver {
  private readonly hits: WatchpointHit[] = [];
  private readonly failures: AssertionFailure[] = [];
  private readonly hitCounts = new Map<string, number>();

  constructor(
    private readonly watchpoints: readonly CourseWatchpoint[],
    private readonly assertions: readonly CourseAssertion[]
  ) {}

  observe(event: CommitEvent): void {
    for (const watchpoint of this.watchpoints) {
      const hit = matchWatchpoint(watchpoint, event);
      if (!hit) continue;
      const count = (this.hitCounts.get(watchpoint.id) ?? 0) + 1;
      this.hitCounts.set(watchpoint.id, count);
      this.hits.push({
        watchpointId: watchpoint.id,
        sequence: event.sequence,
        pc: hex8Address(event.pcBefore),
        detail: hit
      });
    }
  }

  finish(): ExecutionObservation {
    const assertions = this.assertions;
    for (const assertion of assertions) {
      const count = this.hitCounts.get(assertion.watchpointId ?? '') ?? 0;
      switch (assertion.kind) {
        case 'max-hits':
          if (assertion.minHits !== undefined && count < assertion.minHits) {
            this.failures.push({
              assertionId: assertion.id,
              message: `${assertion.watchpointId} 命中 ${count} 次，少于要求 ${assertion.minHits}`
            });
          }
          if (assertion.maxHits !== undefined && count > assertion.maxHits) {
            this.failures.push({
              assertionId: assertion.id,
              message: `${assertion.watchpointId} 命中 ${count} 次，超过上限 ${assertion.maxHits}`
            });
          }
          break;
        case 'halt-pc':
          if (assertion.haltPc === undefined) continue;
          break;
        case 'trap':
        case 'no-trap':
          break;
      }
    }
    return { watchpointHits: this.hits, assertionFailures: this.failures };
  }

  observeAll(events: Iterable<CommitEvent>): ExecutionObservation {
    for (const event of events) this.observe(event);
    return this.finish();
  }
}

/** Simple trap/halt assertions over the full stream, evaluated at finish. */
export function evaluateCourseAssertions(
  events: readonly CommitEvent[],
  assertions: readonly CourseAssertion[]
): readonly AssertionFailure[] {
  const failures: AssertionFailure[] = [];
  const traps = events.filter((event) => event.trap);
  for (const assertion of assertions) {
    switch (assertion.kind) {
      case 'trap': {
        const found = assertion.trapName
          ? traps.some((event) => event.trap?.name === assertion.trapName)
          : traps.length > 0;
        if (!found) {
          failures.push({
            assertionId: assertion.id,
            message: `未观察到 trap${assertion.trapName ? `:${assertion.trapName}` : ''}`
          });
        }
        break;
      }
      case 'no-trap':
        if (traps.length) {
          failures.push({
            assertionId: assertion.id,
            message: `期望无 trap，但观察到 ${traps[0].trap?.name}`
          });
        }
        break;
      case 'halt-pc':
        if (assertion.haltPc === undefined) continue;
        if (!events.some((event) => event.haltReason === 'course-halt-loop'
          && event.pcBefore === (assertion.haltPc! >>> 0))) {
          failures.push({
            assertionId: assertion.id,
            message: `未在 ${hex8Address(assertion.haltPc)} 观察到标准停机事件`
          });
        }
        break;
      case 'max-hits':
        break;
    }
  }
  return failures;
}

function matchWatchpoint(watchpoint: CourseWatchpoint, event: CommitEvent): string | undefined {
  switch (watchpoint.kind) {
    case 'instruction':
      return watchpoint.pc === undefined || event.pcBefore === (watchpoint.pc >>> 0)
        ? `instruction ${event.mnemonic ?? event.kind}`
        : undefined;
    case 'gpr-write':
      return event.gprWrites.find((write) => write.register === watchpoint.register)
        ? `gpr $${watchpoint.register}`
        : undefined;
    case 'memory-write':
      return event.memoryWrites.find((write) => write.wordAddress === (watchpoint.memoryAddress! >>> 0))
        ? `memory ${hex8Address(watchpoint.memoryAddress ?? 0)}`
        : undefined;
    case 'cp0-write':
      return event.cp0Writes.find((write) => write.register === watchpoint.cp0Register)
        ? `cp0[${watchpoint.cp0Register}]`
        : undefined;
    case 'trap':
      return event.trap ? `trap ${event.trap.kind}:${event.trap.name}` : undefined;
    case 'device':
      return event.deviceEvents.find((device) => !watchpoint.device || device.device === watchpoint.device)
        ? 'device event'
        : undefined;
  }
}
