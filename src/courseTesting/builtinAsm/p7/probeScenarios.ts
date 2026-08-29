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
  const includeCore = shard !== 'timer';
  const includeTimer = shard !== 'core';

  if (includeCore && options.externalInterrupt && options.externalIntensity > 0) {
    requiredKinds.push('external');
  }
  if (includeTimer && (shard === 'timer' || (options.timerInterrupt && options.timerIntensity > 0))) {
    requiredKinds.push('timer0', 'timer1');
  }
  if (includeCore) {
    requiredKinds.push(...enabledExceptions);
  }
  if (!requiredKinds.length) {
    requiredKinds.push('syscall');
  }

  const result = shuffle(requiredKinds, rng).slice(0, count);
  if (result.length < count) {
    const variantCoverage = requiredKinds.flatMap((kind) =>
      Array.from({ length: probeVariantCount(kind) - 1 }, () => kind));
    for (const kind of shuffle(variantCoverage, rng)) {
      if (result.length >= count) {
        break;
      }
      result.push(kind);
    }
  }
  while (result.length < count) {
    // Automatic core probes use all remaining record slots. RI is the shortest precise
    // exception scenario, so deterministic raw-word alternation keeps 64 records below
    // the 0x4180 text boundary without weakening explicit variant coverage.
    result.push(shard === 'core'
      ? 'ri'
      : pickFillerScenario(options, enabledExceptions, rng, shard));
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

function pickFillerScenario(
  options: ProbeScenarioPlanOptions,
  enabledExceptions: readonly P7ProbeScenarioKind[],
  rng: Random,
  shard: P7ProbeShard
): P7ProbeScenarioKind {
  const weighted: P7ProbeScenarioKind[] = [];
  if (shard !== 'timer' && options.externalInterrupt && rng.chance(options.externalIntensity)) {
    weighted.push('external');
  }
  if (shard !== 'core' && (shard === 'timer' || (options.timerInterrupt && rng.chance(options.timerIntensity)))) {
    weighted.push(rng.chance(0.5) ? 'timer0' : 'timer1');
  }
  if (shard !== 'timer' && (!weighted.length || rng.chance(0.65))) {
    weighted.push(rng.pick(enabledExceptions.length ? enabledExceptions : ['syscall']));
  }
  if (!weighted.length) {
    weighted.push(rng.chance(0.5) ? 'timer0' : 'timer1');
  }
  return rng.pick(weighted);
}

function shuffle<T>(items: readonly T[], rng: Random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
