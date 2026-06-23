import { firstTraceDiffEntry, TraceDiffResult } from './language/mips/traceCompare';
import { RunResult } from './types';

export function marsStageFailureMessage(prefix: string, result?: RunResult): string {
  const detail = firstNonEmptyLine(result?.stderr) ?? firstNonEmptyLine(result?.stdout);
  return detail ? `${prefix}: ${detail}` : prefix;
}

export function diffMessage(diff: TraceDiffResult): string {
  if (diff.matched) {
    return `${diff.summary.matchedEvents} 个事件匹配`;
  }
  const first = firstTraceDiffEntry(diff);
  return `第 ${diff.firstDiffIndex + 1} 个事件首次出现差异：${first?.reason ?? first?.status ?? 'unknown diff'}`;
}

function firstNonEmptyLine(text?: string): string | undefined {
  return text?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}
