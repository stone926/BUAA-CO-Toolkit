import { CpuTraceEvent } from './traceParser';

export type TraceDiffStatus = 'ok' | 'diff' | 'cycle-diff' | 'mars-only' | 'sim-only';

export interface TraceCompareOptions {
  compareCycles?: boolean;
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
  entries: TraceDiffEntry[];
  summary: {
    marsEvents: number;
    simEvents: number;
    matchedEvents: number;
    diffEvents: number;
  };
}

export function firstTraceDiffSnapshot(diff: TraceDiffResult): TraceDiffSnapshot | undefined {
  if (diff.firstDiffIndex < 0) {
    return undefined;
  }
  return traceDiffSnapshot(diff.entries[diff.firstDiffIndex]);
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
  const entries: TraceDiffEntry[] = [];
  const maxLength = Math.max(marsEvents.length, simEvents.length);
  let firstDiffIndex = -1;
  let matchedEvents = 0;
  let diffEvents = 0;

  for (let i = 0; i < maxLength; i++) {
    const mars = marsEvents[i];
    const sim = simEvents[i];
    const entry = compareAtIndex(i, mars, sim, options);
    entries.push(entry);

    if (entry.status === 'ok') {
      matchedEvents++;
    } else {
      diffEvents++;
      if (firstDiffIndex < 0) {
        firstDiffIndex = i;
      }
    }
  }

  return {
    matched: firstDiffIndex < 0,
    firstDiffIndex,
    entries,
    summary: {
      marsEvents: marsEvents.length,
      simEvents: simEvents.length,
      matchedEvents,
      diffEvents
    }
  };
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
