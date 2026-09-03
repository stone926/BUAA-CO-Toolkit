export type P7StressMode = 'anchor' | 'probe' | 'hybrid' | 'off';
export type P7ProbeShard = 'all' | 'core' | 'timer' | 'mmio' | 'priority' | 'mdu';
export type P7ProbeScenarioKind = 'external' | 'timer0' | 'timer1' | 'adel' | 'ades' | 'syscall' | 'ri' | 'ov' | 'internal';

export interface P7ProbeExpectedRecord {
  expectedIpMask: number;
  /** Alternative exact Cause.IP values when the source is architecturally pulse-shaped. */
  allowedIpMasks?: number[];
  expectedExcCode?: number;
  expectedBd?: boolean;
  allowedEpc: number[];
  /** Exact branch EPCs accepted when an asynchronous request lands in a delay slot. */
  allowedBdEpc?: number[];
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
  /** Macroscopic PC at which the probe testbench raises an armed external interrupt. */
  triggerPc?: number;
  waitPc?: number;
  timerPreset?: number;
  armAddress?: number;
  armValue?: number;
  externalDelayCycles?: number;
  /** Ordered CP0 observations; a replay probe packs its second Cause/EPC into aux0/aux1. */
  expectedRecords?: P7ProbeExpectedRecord[];
  /** DM scratch address containing the independently sampled second handler Status. */
  replayStatusAddress?: number;
  /** Require the generated done marker (`ori $1, $0, id`) after the final handler record. */
  requireCompletion?: boolean;
  /** Exact commits which must occur once, after this scenario's handler record. */
  requiredCommits?: P7ProbeCommitExpectation[];
  /** Exact commits which must occur once before this scenario's handler record. */
  requiredPreHandlerCommits?: P7ProbeCommitExpectation[];
}

export interface P7ProbeMetadata {
  version: 1;
  /** Internal deterministic partition used to keep strongest coverage within the P7 text window. */
  shard?: P7ProbeShard;
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
  /** Internal only; automatic testing expands probe mode into deterministic shards. */
  probeShard?: P7ProbeShard;
}
