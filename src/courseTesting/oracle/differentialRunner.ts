// @index course-testing-oracle — executor shadow 差分：架构写 trace、结构化 first-diff、确定性摘要

import {
  CommitEvent
} from '../../mips/core/events/commitEvent';
import {
  compareTraceIterables,
  firstTraceDiffSnapshot,
  type NeutralTraceDiffSnapshot,
  type TraceDiffResult
} from '../../language/mips/traceCompare';
import type { CpuTraceEvent } from '../../language/mips/traceParser';
import { sha256Canonical, type CanonicalJson } from '../../mips/replay/canonical';
import { commitEventStreamDigest, findCommitEventAtPc, projectCommitEvent } from './commitProjection';
import {
  classifyShadowDifference,
  ShadowClassification,
  ShadowDisposition
} from './shadowPolicy';

/** One side of the shadow lane, normalized to provider-neutral evidence. */
export interface ShadowExecutionEvidence {
  readonly engineId: string;
  readonly ok: boolean;
  readonly rawText: string;
  readonly traceEvents?: readonly CpuTraceEvent[];
  readonly events?: readonly CommitEvent[];
  readonly eventDigest?: string;
  readonly finalStateDigest?: string;
  readonly stopReason?: string;
  readonly stopKind?: string;
  readonly diagnosticCode?: string;
  readonly diagnosticMessage?: string;
}

export interface ExecutorShadowDifferential {
  readonly matched: boolean;
  readonly disposition: ShadowDisposition;
  readonly classification?: ShadowClassification;
  readonly traceDiff?: TraceDiffResult;
  readonly firstDiff?: NeutralTraceDiffSnapshot;
  readonly firstDiffCommitEvent?: ReturnType<typeof projectCommitEvent>;
  readonly legacyTraceDigest: string;
  readonly builtinTraceDigest: string;
  readonly legacyCommitDigest?: string;
  readonly builtinCommitDigest?: string;
  readonly legacyFinalTraceDigest?: string;
  readonly builtinFinalTraceDigest?: string;
  readonly legacyEvents: number;
  readonly builtinEvents: number;
  readonly notComparableReason?: string;
}

export interface ExecutorShadowDifferentialOptions {
  /** Limit retained diff entries; the first diff is always retained. */
  readonly retainedDiffEntries?: number;
  /** Course profile, used by divergence classification. */
  readonly profile?: string;
}

export function compareExecutorShadow(
  legacy: ShadowExecutionEvidence,
  builtin: ShadowExecutionEvidence,
  options: ExecutorShadowDifferentialOptions = {}
): ExecutorShadowDifferential {
  const retained = options.retainedDiffEntries ?? 1;
  const legacyTrace = legacy.traceEvents ?? [];
  const builtinTrace = builtin.traceEvents ?? [];
  const legacyTraceDigest = traceStreamDigest(legacyTrace);
  const builtinTraceDigest = traceStreamDigest(builtinTrace);
  const base = {
    legacyTraceDigest,
    builtinTraceDigest,
    ...(legacy.eventDigest ? { legacyCommitDigest: legacy.eventDigest } : {}),
    ...(builtin.events ? { builtinCommitDigest: commitEventStreamDigest(builtin.events) } : {}),
    ...(builtin.eventDigest ? { builtinCommitDigest: builtin.eventDigest } : {}),
    ...(legacyTrace.length ? { legacyFinalTraceDigest: traceFinalStateDigest(legacyTrace) } : {}),
    ...(builtinTrace.length ? { builtinFinalTraceDigest: traceFinalStateDigest(builtinTrace) } : {}),
    legacyEvents: legacyTrace.length,
    builtinEvents: builtinTrace.length
  };

  if (!legacy.ok && !builtin.ok) {
    return {
      ...base,
      matched: false,
      disposition: 'not-comparable',
      notComparableReason: '两侧 oracle 均未完成执行'
    };
  }
  if (!legacy.ok) {
    return {
      ...base,
      matched: false,
      disposition: 'not-comparable',
      notComparableReason: `legacy oracle 未完成：${legacy.diagnosticCode ?? legacy.stopKind ?? 'unknown'}`
    };
  }
  if (!builtin.ok) {
    return {
      ...base,
      matched: false,
      disposition: 'not-comparable',
      notComparableReason: `builtin oracle 未完成：${builtin.diagnosticCode ?? builtin.stopKind ?? 'unknown'}`
    };
  }
  if (!legacy.traceEvents || !builtin.traceEvents) {
    return {
      ...base,
      matched: false,
      disposition: 'not-comparable',
      notComparableReason: 'shadow 比较需要两侧都提供 course architectural-write trace'
    };
  }

  const traceDiff = compareTraceIterables(legacyTrace, builtinTrace, {
    compareCycles: false,
    retainedEntryLimit: retained
  });
  if (traceDiff.matched) {
    return {
      ...base,
      matched: true,
      disposition: 'matched',
      traceDiff
    };
  }

  const firstDiff = firstTraceDiffSnapshot(traceDiff);
  const firstPc = firstDiff?.oracle?.pc ?? firstDiff?.dut?.pc;
  const builtinEvent = firstPc
    ? findCommitEventAtPc(builtin.events ?? [], Number.parseInt(firstPc, 16))
    : undefined;
  const classification = classifyShadowDifference({
    profile: options.profile,
    firstDiff: traceDiff,
    builtinEvents: builtin.events
  });
  return {
    ...base,
    matched: false,
    disposition: classification.disposition,
    classification,
    traceDiff,
    ...(firstDiff ? { firstDiff } : {}),
    ...(builtinEvent ? { firstDiffCommitEvent: projectCommitEvent(builtinEvent) } : {})
  };
}

/** Canonical digest of the ordered projected trace. */
export function traceStreamDigest(events: readonly CpuTraceEvent[]): string {
  return sha256Canonical(events.map((event) => ({
    ...(event.cycle === undefined ? {} : { cycle: event.cycle }),
    pc: event.pc.toUpperCase(),
    kind: event.kind,
    target: event.target.toUpperCase(),
    value: event.value.toUpperCase()
  })) as unknown as CanonicalJson);
}

/** Last-write-wins digest over the projected trace; equals the legacy observability domain. */
export function traceFinalStateDigest(events: readonly CpuTraceEvent[]): string {
  const gpr: Record<string, string> = {};
  const dm: Record<string, string> = {};
  for (const event of events) {
    const target = event.target.toUpperCase();
    const value = event.value.toUpperCase();
    if (event.kind === 'grf') gpr[target] = value;
    else dm[target] = value;
  }
  return sha256Canonical({ gpr, dm } as unknown as CanonicalJson);
}
