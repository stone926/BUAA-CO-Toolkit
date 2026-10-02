// @index course-testing — 有界、可取消的写回事件比较视图模型，复用自动测试事件对齐
import { iterTraceDiffEntries, TraceDiffStatus } from '../language/mips/traceCompare';
import { CpuTraceEvent, parseCpuTraceLine } from '../language/mips/traceParser';
import { evidencePc, type FailureEvidence } from './failureEvidence';

export const maximumWritebackRows = 200_000;
const batchSize = 2048;
const batchCharacters = 128 * 1024;

export type WritebackEvent = Omit<CpuTraceEvent, 'raw'>;
export type WritebackChangedField = 'pc' | 'target' | 'value';

export interface WritebackRow {
  index: number;
  status: TraceDiffStatus;
  oracle?: WritebackEvent;
  dut?: WritebackEvent;
  reason?: string;
  changedFields: WritebackChangedField[];
}

export interface WritebackComparison {
  rows: WritebackRow[];
  differences: number[];
  /** Parsed counts are lower bounds when truncated. */
  oracleEvents: number;
  dutEvents: number;
  truncated: boolean;
}

export interface WritebackComparisonOptions {
  signal?: AbortSignal;
  yieldControl?: () => Promise<void>;
}

/** DM transaction indexes count only stores, while comparison indexes include GPR writes. */
export function initialWritebackFocus(model: WritebackComparison, evidence?: FailureEvidence): number {
  if (model.differences.length) return model.differences[0];
  if (evidence?.pc === undefined || evidence.index === undefined) return 0;
  let storeIndex = 0;
  for (const row of model.rows) {
    if (row.oracle?.kind !== 'dm') continue;
    if (storeIndex++ === evidence.index) return evidencePc(row.oracle.pc) === evidence.pc ? row.index : 0;
  }
  return 0;
}

/** Timestamps and incidental output never participate in architectural comparison. */
export async function buildWritebackComparison(
  oracleText: string,
  dutText: string,
  options: WritebackComparisonOptions = {}
): Promise<WritebackComparison> {
  const yieldControl = options.yieldControl ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const checkpoint = async () => {
    throwIfAborted(options.signal);
    await yieldControl();
    throwIfAborted(options.signal);
  };
  throwIfAborted(options.signal);
  const oracle = await parseEvents(oracleText, checkpoint);
  const dut = await parseEvents(dutText, checkpoint);
  const rows: WritebackRow[] = [];
  const differences: number[] = [];
  let truncated = false;
  for (const entry of iterTraceDiffEntries(oracle, dut)) {
    if (rows.length === maximumWritebackRows) {
      truncated = true;
      break;
    }
    rows.push({
      index: entry.index,
      status: entry.status,
      oracle: eventSnapshot(entry.oracle),
      dut: eventSnapshot(entry.dut),
      reason: entry.reason,
      changedFields: changedFields(entry.oracle, entry.dut)
    });
    if (entry.status !== 'ok') differences.push(entry.index);
    if (rows.length % batchSize === 0) await checkpoint();
  }
  throwIfAborted(options.signal);
  return { rows, differences, oracleEvents: oracle.length, dutEvents: dut.length, truncated };
}

async function parseEvents(text: string, checkpoint: () => Promise<void>): Promise<CpuTraceEvent[]> {
  const events: CpuTraceEvent[] = [];
  let lineStart = 0;
  let lineNumber = 1;
  let checkpointStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const event = parseCpuTraceLine(text.slice(lineStart, lineEnd), lineNumber);
    // Comparison only needs the semantic fields and source line; discard log text immediately.
    if (event) events.push({ ...event, raw: '' });
    // One additional event proves truncation and provides the shared aligner's swap lookahead.
    if (events.length > maximumWritebackRows) break;
    if (lineNumber % batchSize === 0 || lineEnd - checkpointStart >= batchCharacters) {
      await checkpoint();
      checkpointStart = lineEnd;
    }
    if (newline < 0) break;
    lineStart = newline + 1;
    lineNumber++;
  }
  return events;
}

function eventSnapshot(event: CpuTraceEvent | undefined): WritebackEvent | undefined {
  if (!event) return undefined;
  return {
    cycle: event.cycle,
    pc: event.pc,
    kind: event.kind,
    target: event.target,
    value: event.value,
    lineNumber: event.lineNumber
  };
}

function changedFields(oracle: CpuTraceEvent | undefined, dut: CpuTraceEvent | undefined): WritebackChangedField[] {
  if (!oracle || !dut) return [];
  const fields: WritebackChangedField[] = [];
  if (oracle.pc !== dut.pc) fields.push('pc');
  if (oracle.kind !== dut.kind || oracle.target !== dut.target) fields.push('target');
  if (oracle.value !== dut.value) fields.push('value');
  return fields;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('写回对比已取消。');
  error.name = 'AbortError';
  throw error;
}
