import { CpuTraceEvent } from './traceParser';

export type TraceDiffStatus = 'ok' | 'diff' | 'cycle-diff' | 'mars-only' | 'sim-only';

export interface TraceCompareOptions {
  compareCycles?: boolean;
  retainedEntryLimit?: number;
}

export interface TraceDiffEntry {
  index: number;
  status: TraceDiffStatus;
  mars?: CpuTraceEvent;
  sim?: CpuTraceEvent;
  reason?: string;
}

export interface TraceEventSnapshot {
  cycle?: number;
  pc: string;
  kind: CpuTraceEvent['kind'];
  target: string;
  value: string;
  raw: string;
  lineNumber: number;
}

export interface TraceDiffSnapshot {
  index: number;
  status: TraceDiffStatus;
  reason?: string;
  mars?: TraceEventSnapshot;
  sim?: TraceEventSnapshot;
}

export interface TraceDiffResult {
  matched: boolean;
  firstDiffIndex: number;
  firstDiffEntry?: TraceDiffEntry;
  entriesTruncated?: boolean;
  entries: TraceDiffEntry[];
  summary: {
    marsEvents: number;
    simEvents: number;
    matchedEvents: number;
    diffEvents: number;
  };
}

export function firstTraceDiffSnapshot(diff: TraceDiffResult): TraceDiffSnapshot | undefined {
  return traceDiffSnapshot(firstTraceDiffEntry(diff));
}

export function firstTraceDiffEntry(diff: TraceDiffResult): TraceDiffEntry | undefined {
  if (diff.firstDiffIndex < 0) {
    return undefined;
  }
  return diff.firstDiffEntry ?? diff.entries.find((entry) => entry.index === diff.firstDiffIndex);
}

export function traceDiffSnapshot(entry: TraceDiffEntry | undefined): TraceDiffSnapshot | undefined {
  if (!entry) {
    return undefined;
  }
  return {
    index: entry.index,
    status: entry.status,
    reason: entry.reason,
    mars: traceEventSnapshot(entry.mars),
    sim: traceEventSnapshot(entry.sim)
  };
}

export function compareTraces(
  marsEvents: readonly CpuTraceEvent[],
  simEvents: readonly CpuTraceEvent[],
  options: TraceCompareOptions = {}
): TraceDiffResult {
  return compareTraceIterables(marsEvents, simEvents, options);
}

export function compareTraceIterables(
  marsEvents: Iterable<CpuTraceEvent>,
  simEvents: Iterable<CpuTraceEvent>,
  options: TraceCompareOptions = {}
): TraceDiffResult {
  const marsState = iteratorState(marsEvents);
  const simState = iteratorState(simEvents);
  const entries: TraceDiffEntry[] = [];
  const retainedEntryLimit = normalizedRetainedEntryLimit(options.retainedEntryLimit);
  let firstDiffIndex = -1;
  let firstDiffEntry: TraceDiffEntry | undefined;
  let entriesTruncated = false;
  let matchedEvents = 0;
  let diffEvents = 0;
  let index = 0;

  while (true) {
    const mars = currentIteratorEvent(marsState);
    const sim = currentIteratorEvent(simState);
    if (!mars && !sim) {
      break;
    }
    const entry = compareAtIndex(index, mars, sim, options);

    if (entry.status !== 'ok') {
      const swapped = compareAdjacentSwapAt(
        index,
        mars,
        nextIteratorEvent(marsState),
        sim,
        nextIteratorEvent(simState),
        options
      );
      if (swapped) {
        for (const swappedEntry of swapped) {
          entriesTruncated = retainEntry(entries, swappedEntry, retainedEntryLimit) || entriesTruncated;
          matchedEvents++;
        }
        advanceIteratorState(marsState, 2);
        advanceIteratorState(simState, 2);
        index += 2;
        continue;
      }
    }

    entriesTruncated = retainEntry(entries, entry, retainedEntryLimit) || entriesTruncated;

    if (entry.status === 'ok') {
      matchedEvents++;
    } else {
      diffEvents++;
      if (firstDiffIndex < 0) {
        firstDiffIndex = index;
        firstDiffEntry = entry;
      }
    }
    advanceIteratorState(marsState, 1);
    advanceIteratorState(simState, 1);
    index++;
  }

  return {
    matched: firstDiffIndex < 0,
    firstDiffIndex,
    firstDiffEntry,
    entriesTruncated,
    entries,
    summary: {
      marsEvents: marsState.seen,
      simEvents: simState.seen,
      matchedEvents,
      diffEvents
    }
  };
}

interface IteratorState {
  iterator: Iterator<CpuTraceEvent>;
  current?: CpuTraceEvent;
  next?: CpuTraceEvent;
  hasCurrent: boolean;
  hasNext: boolean;
  done: boolean;
  seen: number;
}

function iteratorState(events: Iterable<CpuTraceEvent>): IteratorState {
  return {
    iterator: events[Symbol.iterator](),
    hasCurrent: false,
    hasNext: false,
    done: false,
    seen: 0
  };
}

function currentIteratorEvent(state: IteratorState): CpuTraceEvent | undefined {
  if (!state.hasCurrent) {
    const value = readIteratorEvent(state);
    state.current = value;
    state.hasCurrent = true;
  }
  return state.current;
}

function nextIteratorEvent(state: IteratorState): CpuTraceEvent | undefined {
  currentIteratorEvent(state);
  if (!state.hasNext) {
    const value = readIteratorEvent(state);
    state.next = value;
    state.hasNext = true;
  }
  return state.next;
}

function advanceIteratorState(state: IteratorState, count: 1 | 2): void {
  if (count === 1 && state.hasNext) {
    state.current = state.next;
    state.hasCurrent = true;
    state.next = undefined;
    state.hasNext = false;
    return;
  }
  state.current = undefined;
  state.hasCurrent = false;
  if (count === 2) {
    state.next = undefined;
    state.hasNext = false;
  }
}

function readIteratorEvent(state: IteratorState): CpuTraceEvent | undefined {
  if (state.done) {
    return undefined;
  }
  const next = state.iterator.next();
  if (next.done) {
    state.done = true;
    return undefined;
  }
  state.seen++;
  return next.value;
}

function normalizedRetainedEntryLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
}

function retainEntry(entries: TraceDiffEntry[], entry: TraceDiffEntry, limit: number | undefined): boolean {
  if (limit === undefined || entries.length < limit) {
    entries.push(entry);
    return false;
  }
  return true;
}

function compareAdjacentSwapAt(
  index: number,
  mars: CpuTraceEvent | undefined,
  marsNext: CpuTraceEvent | undefined,
  sim: CpuTraceEvent | undefined,
  simNext: CpuTraceEvent | undefined,
  options: TraceCompareOptions
): [TraceDiffEntry, TraceDiffEntry] | undefined {
  if (!mars || !marsNext || !sim || !simNext) {
    return undefined;
  }
  if (!canReorderAdjacentPair(mars, marsNext, sim, simNext)) {
    return undefined;
  }

  const first = compareAtIndex(index, mars, simNext, options);
  const second = compareAtIndex(index + 1, marsNext, sim, options);
  return first.status === 'ok' && second.status === 'ok' ? [first, second] : undefined;
}

function compareAtIndex(
  index: number,
  mars: CpuTraceEvent | undefined,
  sim: CpuTraceEvent | undefined,
  options: TraceCompareOptions
): TraceDiffEntry {
  if (!mars && sim) {
    return { index, status: 'sim-only', sim, reason: 'Simulator has an extra event.' };
  }
  if (mars && !sim) {
    return { index, status: 'mars-only', mars, reason: 'MARS has an extra event.' };
  }
  if (!mars || !sim) {
    return { index, status: 'ok' };
  }

  const reason = firstSemanticDifference(mars, sim);
  if (reason) {
    return { index, status: 'diff', mars, sim, reason };
  }
  if (options.compareCycles && mars.cycle !== sim.cycle) {
    return { index, status: 'cycle-diff', mars, sim, reason: 'Cycle/time differs.' };
  }
  return { index, status: 'ok', mars, sim };
}

function firstSemanticDifference(mars: CpuTraceEvent, sim: CpuTraceEvent): string | undefined {
  if (mars.pc !== sim.pc) {
    return 'PC differs.';
  }
  if (mars.kind !== sim.kind) {
    return 'Write target kind differs.';
  }
  if (mars.target !== sim.target) {
    return 'Write target differs.';
  }
  if (mars.value !== sim.value) {
    return 'Write value differs.';
  }
  return undefined;
}

function canReorderAdjacentPair(
  mars: CpuTraceEvent,
  marsNext: CpuTraceEvent,
  sim: CpuTraceEvent,
  simNext: CpuTraceEvent
): boolean {
  const marsHasCycles = hasCycle(mars) || hasCycle(marsNext);
  const simHasCycles = hasCycle(sim) || hasCycle(simNext);
  if (!marsHasCycles && !simHasCycles) {
    return false;
  }
  if (marsHasCycles && !sameTraceMoment(mars, marsNext)) {
    return false;
  }
  if (simHasCycles && !sameTraceMoment(sim, simNext)) {
    return false;
  }
  return true;
}

function sameTraceMoment(left: CpuTraceEvent, right: CpuTraceEvent): boolean {
  return left.cycle !== undefined && left.cycle === right.cycle;
}

function hasCycle(event: CpuTraceEvent): boolean {
  return event.cycle !== undefined;
}

function traceEventSnapshot(event: CpuTraceEvent | undefined): TraceEventSnapshot | undefined {
  if (!event) {
    return undefined;
  }
  return {
    cycle: event.cycle,
    pc: event.pc,
    kind: event.kind,
    target: event.target,
    value: event.value,
    raw: event.raw,
    lineNumber: event.lineNumber
  };
}
