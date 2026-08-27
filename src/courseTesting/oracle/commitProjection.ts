// @index course-testing-oracle — CommitEvent 诊断投影：first-diff 与结构化摘要（纯比较，不碰 vscode/fs）

import {
  CommitEvent,
  commitEventsCanonical,
  Cp0Write,
  DeviceEvent,
  HiLoWrite,
  MemoryRead,
  MemoryWrite,
  RegisterWrite
} from '../../mips/core/events/commitEvent';
import { hex8, hex8Address } from '../../mips/core/values';
import { canonicalJson, sha256Canonical, type CanonicalJson } from '../../mips/replay/canonical';

/** Human/JSON-stable view used by reports and first-diff snapshots. */
export interface CommitEventView {
  readonly sequence: number;
  readonly kind: CommitEvent['kind'];
  readonly pcBefore: string;
  readonly instructionWord?: string;
  readonly pcAfter: string;
  readonly delaySlot?: boolean;
  readonly branchOriginPc?: string;
  readonly mnemonic?: string;
  readonly gprWrites: readonly string[];
  readonly hiLoWrites: readonly string[];
  readonly cp0Writes: readonly string[];
  readonly memoryWrites: readonly string[];
  readonly memoryReads: readonly string[];
  readonly deviceEvents: readonly string[];
  readonly trap?: string;
  readonly haltReason?: string;
}

export interface CommitEventFirstDiff {
  readonly index: number;
  readonly left?: CommitEventView;
  readonly right?: CommitEventView;
  readonly reason: string;
}

/** Stable digest over the canonical structured commit stream. */
export function commitEventStreamDigest(events: readonly CommitEvent[]): string {
  return sha256Canonical(commitEventsCanonical(events) as CanonicalJson);
}

export function serializeCommitEvents(events: readonly CommitEvent[]): string {
  return canonicalJson(commitEventsCanonical(events) as CanonicalJson);
}

export function projectCommitEvent(event: CommitEvent): CommitEventView {
  return {
    sequence: event.sequence,
    kind: event.kind,
    pcBefore: hex8Address(event.pcBefore),
    ...(event.instructionWord === undefined
      ? {}
      : { instructionWord: hex8(event.instructionWord) }),
    pcAfter: hex8Address(event.pcAfter),
    ...(event.delaySlot === undefined ? {} : { delaySlot: event.delaySlot }),
    ...(event.branchOriginPc === undefined
      ? {}
      : { branchOriginPc: hex8Address(event.branchOriginPc) }),
    ...(event.mnemonic ? { mnemonic: event.mnemonic } : {}),
    gprWrites: event.gprWrites.map(formatRegisterWrite),
    hiLoWrites: event.hiLoWrites.map(formatHiLoWrite),
    cp0Writes: event.cp0Writes.map(formatCp0Write),
    memoryWrites: event.memoryWrites.map(formatMemoryWrite),
    memoryReads: (event.memoryReads ?? []).map(formatMemoryRead),
    deviceEvents: event.deviceEvents.map(formatDeviceEvent),
    ...(event.trap
      ? {
        trap: `${event.trap.kind}:${event.trap.name} victim=${hex8Address(event.trap.victimPc)}`
          + ` epc=${hex8Address(event.trap.epc)} bd=${event.trap.branchDelay}`
      }
      : {}),
    ...(event.haltReason ? { haltReason: event.haltReason } : {})
  };
}

/** Locate the first committed event at a PC (returning an instruction, exception, or interrupt victim). */
export function findCommitEventAtPc(
  events: readonly CommitEvent[],
  pc: number
): CommitEvent | undefined {
  const address = pc >>> 0;
  return events.find((event) => event.pcBefore === address);
}

/** First structured-stream difference; undefined when both canonical streams are identical. */
export function firstCommitEventDiff(
  left: readonly CommitEvent[],
  right: readonly CommitEvent[]
): CommitEventFirstDiff | undefined {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const leftEvent = left[index];
    const rightEvent = right[index];
    if (!leftEvent || !rightEvent) {
      return {
        index,
        ...(leftEvent ? { left: projectCommitEvent(leftEvent) } : {}),
        ...(rightEvent ? { right: projectCommitEvent(rightEvent) } : {}),
        reason: !leftEvent ? 'right has extra events' : 'left has extra events'
      };
    }
    const leftCanonical = commitEventsCanonical([leftEvent]) as CanonicalJson[];
    const rightCanonical = commitEventsCanonical([rightEvent]) as CanonicalJson[];
    if (canonicalJson(leftCanonical) !== canonicalJson(rightCanonical)) {
      return {
        index,
        left: projectCommitEvent(leftEvent),
        right: projectCommitEvent(rightEvent),
        reason: 'canonical commit event differs'
      };
    }
  }
  return undefined;
}

function formatRegisterWrite(write: RegisterWrite): string {
  return `$${write.register}<=${hex8(write.value)}${write.defined === false ? ' (undefined)' : ''}`;
}

function formatHiLoWrite(write: HiLoWrite): string {
  return `${write.register}<=${hex8(write.value)}${write.defined === false ? ' (undefined)' : ''}`;
}

function formatCp0Write(write: Cp0Write): string {
  return `cp0[${write.register}]: ${hex8(write.valueBefore)}->${hex8(write.value)}`;
}

function formatMemoryWrite(write: MemoryWrite): string {
  return `${write.region}[${hex8Address(write.address)}]`
    + ` word=${hex8Address(write.wordAddress)} mask=${hex8(write.byteMask)}`
    + ` ${hex8(write.valueBefore)}->${hex8(write.valueAfter)}`;
}

function formatMemoryRead(read: MemoryRead): string {
  return `${read.region}[${hex8Address(read.address)}] width=${read.width}`
    + ` word=${hex8(read.wordValue)} value=${hex8(read.value)}`;
}

function formatDeviceEvent(event: DeviceEvent): string {
  return `${event.device}:${event.kind}`
    + `${event.address === undefined ? '' : `@${hex8Address(event.address)}`}`
    + `${event.value === undefined ? '' : `=${event.value}`}`;
}
