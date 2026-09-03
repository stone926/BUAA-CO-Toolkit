import { Random } from '../../random';
import { P7ProbeScenario, P7ProbeScenarioKind, P7ProbeShard } from '../types';
import {
  p7CauseIpExternalMask,
  p7CauseIpTimer0Mask,
  p7CauseIpTimer1Mask,
  p7ExcCodeAdel,
  p7ExcCodeAdes,
  p7ExcCodeOv,
  p7ExcCodeRi,
  p7ExcCodeSyscall,
  p7ProbeDefaultScenarioCount,
  p7ProbeMaxScenarioCount
} from './constants';
import { probeVariantCount } from './probeVariants';

export interface ProbeScenarioPlanOptions {
  count: number;
  externalInterrupt: boolean;
  timerInterrupt: boolean;
  externalIntensity: number;
  timerIntensity: number;
  exceptionTypes: readonly string[];
  shard?: P7ProbeShard;
}

const probeExceptionCoverageOrder: P7ProbeScenarioKind[] = ['adel', 'ades', 'syscall', 'ri', 'ov'];

export function clampProbeScenarioCount(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return p7ProbeDefaultScenarioCount;
  }
  return Math.min(p7ProbeMaxScenarioCount, Math.max(1, Math.floor(value)));
}

export function planProbeScenarioKinds(options: ProbeScenarioPlanOptions, rng: Random): P7ProbeScenarioKind[] {
  const count = clampProbeScenarioCount(options.count);
  const enabledExceptions = enabledProbeExceptions(options.exceptionTypes);
  const requiredKinds: P7ProbeScenarioKind[] = [];
  const shard = options.shard ?? 'all';
  if (probeVariantCount('external', shard) && options.externalInterrupt && options.externalIntensity > 0) {
    requiredKinds.push('external');
  }
  if (probeVariantCount('timer0', shard)
    && (shard === 'timer' || (options.timerInterrupt && options.timerIntensity > 0))) {
    requiredKinds.push('timer0', 'timer1');
  }
  requiredKinds.push(...enabledExceptions.filter((kind) => probeVariantCount(kind, shard) > 0));
  if (!requiredKinds.length) {
    requiredKinds.push('syscall');
  }

  const result = shuffle(requiredKinds, rng).slice(0, count);
  if (result.length < count) {
    const variantCoverage = requiredKinds.flatMap((kind) =>
      Array.from({ length: Math.max(0, probeVariantCount(kind, shard) - 1) }, () => kind));
    for (const kind of shuffle(variantCoverage, rng)) {
      if (result.length >= count) {
        break;
      }
      result.push(kind);
    }
  }
  while (result.length < count) {
    // Fill spare core records with short RI cases; other shards remain within their
    // registered categories rather than silently introducing unrelated scenarios.
    result.push(shard === 'core' && requiredKinds.includes('ri')
      ? 'ri'
      : rng.pick(requiredKinds));
  }
  return shuffle(result, rng);
}

export function expectedIpMask(kind: P7ProbeScenarioKind): number {
  switch (kind) {
    case 'external':
      return p7CauseIpExternalMask;
    case 'timer0':
      return p7CauseIpTimer0Mask;
    case 'timer1':
      return p7CauseIpTimer1Mask;
    case 'adel':
    case 'ades':
    case 'syscall':
    case 'ri':
    case 'ov':
    case 'internal':
      return 0;
  }
}

export function expectedExcCode(kind: P7ProbeScenarioKind): number | undefined {
  switch (kind) {
    case 'adel':
      return p7ExcCodeAdel;
    case 'ades':
      return p7ExcCodeAdes;
    case 'syscall':
      return p7ExcCodeSyscall;
    case 'ri':
      return p7ExcCodeRi;
    case 'ov':
      return p7ExcCodeOv;
    case 'external':
    case 'timer0':
    case 'timer1':
      return 0;
    case 'internal':
      return undefined;
  }
}

export function isInternalProbeKind(kind: P7ProbeScenarioKind): boolean {
  return kind === 'internal' || expectedExcCode(kind) !== 0;
}

export function scenarioWithLocations(
  id: number,
  kind: P7ProbeScenarioKind,
  waitPc: number | undefined,
  donePc: number
): P7ProbeScenario {
  return {
    id,
    kind,
    expectedIpMask: expectedIpMask(kind),
    expectedExcCode: expectedExcCode(kind),
    allowedEpc: waitPc === undefined ? [] : [waitPc],
    donePc,
    waitPc
  };
}

function enabledProbeExceptions(values: readonly string[]): P7ProbeScenarioKind[] {
  const enabled = new Set(values.map((value) => String(value).trim().toLowerCase()));
  return probeExceptionCoverageOrder.filter((kind) => enabled.has(kind));
}

function shuffle<T>(items: readonly T[], rng: Random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
