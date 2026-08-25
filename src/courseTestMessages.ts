import { firstTraceDiffEntry, TraceDiffResult } from './language/mips/traceCompare';

/** Accepts both legacy RunResult and provider-neutral EngineRunStatus. */
export function engineStageFailureMessage(prefix: string, result?: { stdout: string; stderr: string }): string {
  const detail = firstNonEmptyLine(result?.stderr) ?? firstNonEmptyLine(result?.stdout);
  return detail ? `${prefix}: ${detail}` : prefix;
}

export function engineRunWasCancelled(
  result?: { stopped?: boolean; stopReason?: string },
  signal?: AbortSignal
): boolean {
  if (result !== undefined) {
    return result.stopped === true && result.stopReason === 'aborted';
  }
  return signal?.aborted === true;
}

/** @deprecated Compatibility export for callers not yet migrated to provider-neutral naming. */
export const marsStageFailureMessage = engineStageFailureMessage;

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
