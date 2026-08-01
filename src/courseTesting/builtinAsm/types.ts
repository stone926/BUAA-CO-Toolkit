export type P7StressMode = 'anchor' | 'probe' | 'hybrid' | 'off';
export type P7ProbeScenarioKind = 'external' | 'timer0' | 'timer1' | 'adel' | 'ades' | 'syscall' | 'ri' | 'ov' | 'internal';

export interface P7ProbeExpectedRecord {
  expectedIpMask: number;
  expectedExcCode?: number;
  expectedBd?: boolean;
  allowedEpc: number[];
  allowedAuxPairs?: Array<[number, number]>;
  /** Human-readable meaning of aux0/aux1 when they carry a state observation. */
  auxPairDescription?: string;
  /** Require aux0 (state before the victim) to equal aux1 (handler read-back). */
  requireEqualAuxPair?: boolean;
}

export interface P7ProbeCommitExpectation {
  pc: number;
  kind: 'grf' | 'dm';
  target: number;
  value: number;
}

export interface P7ProbeScenario {
  id: number;
  kind: P7ProbeScenarioKind;
  expectedIpMask: number;
  expectedExcCode?: number;
  expectedBd?: boolean;
  allowedEpc: number[];
  variant?: string;
  victimPc?: number;
  donePc: number;
  waitPc?: number;
  timerPreset?: number;
  armAddress?: number;
  armValue?: number;
  externalDelayCycles?: number;
  /** Ordered CP0 observations; a replay probe packs its second Cause/EPC into aux0/aux1. */
  expectedRecords?: P7ProbeExpectedRecord[];
  /** Require the generated done marker (`ori $1, $0, id`) after the final handler record. */
  requireCompletion?: boolean;
  /** Exact commits which must occur once, after this scenario's handler record. */
  requiredCommits?: P7ProbeCommitExpectation[];
}

export interface P7ProbeMetadata {
  version: 1;
  logBase: number;
  recordWords: number;
  scenarios: P7ProbeScenario[];
}

export interface P7ProbeOptions {
  p7StressMode?: P7StressMode;
  timerInterrupt?: boolean;
  externalInterruptIntensity?: number;
  timerIntensity?: number;
  probeScenarioCount?: number;
}
