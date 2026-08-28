// @index course-testing-oracle — CommitEvent assertion/watchpoint 观察器（流式、有界、可取消）

import type { CommitEvent } from '../../mips/core/events/commitEvent';
import { hex8Address } from '../../mips/core/values';

export type WatchpointKind = 'instruction' | 'gpr-write' | 'memory-write' | 'cp0-write' | 'trap' | 'device';

export interface CourseWatchpoint {
  readonly id: string;
  readonly kind: WatchpointKind;
  /** PC matcher for instruction/trap watchpoints. */
  readonly pc?: number;
  /** GPR matcher; omitted to watch any GPR write. */
  readonly register?: number;
  /** CP0 matcher; omitted to watch any CP0 write. */
  readonly cp0Register?: number;
  /** Aligned word address for memory writes; omitted to watch any memory write. */
  readonly memoryAddress?: number;
  /** Device id matcher; omitted to watch any device event. */
  readonly device?: string;
  /** Retain at most this many hits while continuing to count matches. */
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
  private readonly hitCounts = new Map<string, number>();
  private readonly trapNames = new Set<string>();
  private firstTrapName: string | undefined;
  private readonly haltPcs = new Set<number>();

  constructor(
    private readonly watchpoints: readonly CourseWatchpoint[],
    private readonly assertions: readonly CourseAssertion[]
  ) {}

  observe(event: CommitEvent): void {
    if (event.trap) {
      this.firstTrapName ??= event.trap.name;
      this.trapNames.add(event.trap.name);
    }
    if (event.haltReason === 'course-halt-loop') {
      const haltPc = event.delaySlot && event.branchOriginPc !== undefined
        ? event.branchOriginPc
        : event.pcBefore;
      this.haltPcs.add(haltPc >>> 0);
    }
    for (const watchpoint of this.watchpoints) {
      const hit = matchWatchpoint(watchpoint, event);
      if (!hit) continue;
      const count = (this.hitCounts.get(watchpoint.id) ?? 0) + 1;
      this.hitCounts.set(watchpoint.id, count);
      if (watchpoint.limit !== undefined && count > watchpoint.limit) continue;
      this.hits.push({
        watchpointId: watchpoint.id,
        sequence: event.sequence,
        pc: hex8Address(event.pcBefore),
        detail: hit
      });
    }
  }

  finish(): ExecutionObservation {
    const failures: AssertionFailure[] = [];
    for (const assertion of this.assertions) {
      const count = this.hitCounts.get(assertion.watchpointId ?? '') ?? 0;
      switch (assertion.kind) {
        case 'max-hits':
          if (assertion.minHits !== undefined && count < assertion.minHits) {
            failures.push({
              assertionId: assertion.id,
              message: `${assertion.watchpointId} 命中 ${count} 次，少于要求 ${assertion.minHits}`
            });
          }
          if (assertion.maxHits !== undefined && count > assertion.maxHits) {
            failures.push({
              assertionId: assertion.id,
              message: `${assertion.watchpointId} 命中 ${count} 次，超过上限 ${assertion.maxHits}`
            });
          }
          break;
        case 'halt-pc':
          if (assertion.haltPc === undefined) continue;
          if (!this.haltPcs.has(assertion.haltPc >>> 0)) {
            failures.push({
              assertionId: assertion.id,
              message: `未在 ${hex8Address(assertion.haltPc)} 观察到标准停机事件`
            });
          }
          break;
        case 'trap': {
          const found = assertion.trapName
            ? this.trapNames.has(assertion.trapName)
            : this.firstTrapName !== undefined;
          if (!found) {
            failures.push({
              assertionId: assertion.id,
              message: `未观察到 trap${assertion.trapName ? `:${assertion.trapName}` : ''}`
            });
          }
          break;
        }
        case 'no-trap':
          if (this.firstTrapName !== undefined) {
            failures.push({
              assertionId: assertion.id,
              message: `期望无 trap，但观察到 ${this.firstTrapName}`
            });
          }
          break;
      }
    }
    return { watchpointHits: this.hits, assertionFailures: failures };
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
  return new ExecutionAssertionObserver(
    [],
    assertions.filter((assertion) => assertion.kind !== 'max-hits')
  ).observeAll(events).assertionFailures;
}

function matchWatchpoint(watchpoint: CourseWatchpoint, event: CommitEvent): string | undefined {
  switch (watchpoint.kind) {
    case 'instruction':
      return event.kind === 'instruction'
        && (watchpoint.pc === undefined || event.pcBefore === (watchpoint.pc >>> 0))
        ? `instruction ${event.mnemonic ?? event.kind}`
        : undefined;
    case 'gpr-write': {
      const write = event.gprWrites.find((candidate) => watchpoint.register === undefined
        || candidate.register === watchpoint.register);
      return write ? `gpr $${write.register}` : undefined;
    }
    case 'memory-write': {
      const write = event.memoryWrites.find((candidate) => watchpoint.memoryAddress === undefined
        || candidate.wordAddress === (watchpoint.memoryAddress >>> 0));
      return write ? `memory ${hex8Address(write.wordAddress)}` : undefined;
    }
    case 'cp0-write': {
      const write = event.cp0Writes.find((candidate) => watchpoint.cp0Register === undefined
        || candidate.register === watchpoint.cp0Register);
      return write ? `cp0[${write.register}]` : undefined;
    }
    case 'trap':
      return event.trap
        && (watchpoint.pc === undefined || event.trap.victimPc === (watchpoint.pc >>> 0))
        ? `trap ${event.trap.kind}:${event.trap.name}`
        : undefined;
    case 'device':
      return event.deviceEvents.find((device) => !watchpoint.device || device.device === watchpoint.device)
        ? 'device event'
        : undefined;
  }
}
