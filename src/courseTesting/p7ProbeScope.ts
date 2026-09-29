// @index p7-probe-scope — classify legacy pending-Timer EXL/EPC probe cases and explain their evidence scope
import type { P7ProbeMetadata, P7ProbeScope } from './builtinAsm/types';

export const specialTimerExlNotice =
  '特殊压力场景：软件构造 EXL/EPC，并通过 jal→eret 释放待处理 Timer 中断。其课程官方保证范围尚未确认；单凭此场景失败，不能判定课程 CPU 不合格。失败与工具错误仍如实保留。';

export function isSpecialTimerExlShard(shard: string | undefined): boolean {
  return shard === 'special-priority' || shard === 'special-mdu' || shard === 'special-hazard';
}

/** Old mixed probes lack a scope field, so inspect their actual scenario catalog. */
export function probeScope(probe: unknown): P7ProbeScope | undefined {
  if (!probe || typeof probe !== 'object') return undefined;
  const candidate = probe as Partial<Pick<P7ProbeMetadata, 'scope' | 'shard' | 'scenarios'>>;
  if (!Array.isArray(candidate.scenarios)) return undefined;
  if (candidate.scope === 'special-timer-exl') return candidate.scope;
  if (isSpecialTimerExlShard(candidate.shard)) return 'special-timer-exl';
  if (candidate.scenarios.some((scenario) =>
    scenario !== null && typeof scenario === 'object'
      && (scenario.kind === 'timer0' || scenario.kind === 'timer1')
      && /^(priority-|mdu-|hazard-)/.test(scenario.variant ?? '')
  )) return 'special-timer-exl';
  return 'standard';
}

export function probeScopeFromCase(probe: unknown, metadata: Record<string, string> | undefined): P7ProbeScope | undefined {
  if (metadata?.['source.probeScope'] === 'special-timer-exl') return 'special-timer-exl';
  return probeScope(probe);
}
