import { TraceDiffResult } from './language/mips/traceCompare';
import { RunResult } from './types';

export function marsStageFailureMessage(prefix: string, result?: RunResult): string {
  const detail = firstNonEmptyLine(result?.stderr) ?? firstNonEmptyLine(result?.stdout);
  return detail ? `${prefix}: ${detail}` : prefix;
}

export function diffMessage(diff: TraceDiffResult): string {
  if (diff.matched) {
    return `${diff.summary.matchedEvents} events matched.`;
  }
  const first = diff.entries[diff.firstDiffIndex];
  return `First difference at event #${diff.firstDiffIndex + 1}: ${first.reason ?? first.status}.`;
}

function firstNonEmptyLine(text?: string): string | undefined {
  return text?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}
