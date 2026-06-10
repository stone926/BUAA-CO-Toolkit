import { Random } from '../../random';
import { P7ProbeScenario, P7ProbeScenarioKind } from '../types';
import {
  p7CauseIpExternalMask,
  p7CauseIpTimer0Mask,
  p7CauseIpTimer1Mask
} from './constants';

export interface ProbeScenarioPlanOptions {
  count: number;
  externalInterrupt: boolean;
  timerInterrupt: boolean;
  externalIntensity: number;
  timerIntensity: number;
}

export function planProbeScenarioKinds(options: ProbeScenarioPlanOptions, rng: Random): P7ProbeScenarioKind[] {
  const count = Math.max(1, Math.floor(options.count));
  const result: P7ProbeScenarioKind[] = [];
  if (options.externalInterrupt && options.externalIntensity > 0) {
    result.push('external');
  }
  if (options.timerInterrupt && options.timerIntensity > 0) {
    result.push('timer0', 'timer1');
  }
  if (!result.length) {
    result.push('internal');
  }
  while (result.length < count) {
    const candidates: P7ProbeScenarioKind[] = [];
    if (options.externalInterrupt && rng.chance(options.externalIntensity)) {
      candidates.push('external');
    }
    if (options.timerInterrupt && rng.chance(options.timerIntensity)) {
      candidates.push(rng.chance(0.5) ? 'timer0' : 'timer1');
    }
    if (!candidates.length) {
      candidates.push('internal');
    }
    result.push(rng.pick(candidates));
  }
  return result.slice(0, count);
}

export function expectedIpMask(kind: P7ProbeScenarioKind): number {
  switch (kind) {
    case 'external':
      return p7CauseIpExternalMask;
    case 'timer0':
      return p7CauseIpTimer0Mask;
    case 'timer1':
      return p7CauseIpTimer1Mask;
    case 'internal':
      return 0;
  }
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
    allowedEpc: waitPc === undefined ? [] : [waitPc],
    donePc,
    waitPc
  };
}

