export type P7StressMode = 'anchor' | 'probe' | 'hybrid' | 'off';
export type P7ProbeReturnVariant = 'direct' | 'load-jr' | 'branch-delay' | 'jal-delay' | 'mdu';
export type P7ProbeShard = 'all' | 'core' | 'timer' | 'mmio' | 'priority' | 'mdu' | 'hazard'
  | 'return' | 'special-priority' | 'special-mdu' | 'special-hazard';
export type P7ProbeScope = 'standard' | 'special-timer-exl';
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

export interface P7ProbeHandlerCommitExpectation {
  pc: number;
  kind: 'grf' | 'dm';
  target: number;
  targetStride?: number;
  value: number | 'status' | 'cause' | 'epc';
  valueStride?: number;
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
  /** Follow a real interrupt's acknowledged handler through its unique eret boundary. */
  afterReturnOf?: { scenarioId: number; eretPc: number };
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
  /** Wrong-path or younger instructions which must never commit, even after the handler. */
  forbiddenCommitPcs?: number[];
}

export interface P7ProbeMetadata {
  version: 1;
  /** Internal deterministic partition used to keep strongest coverage within the P7 text window. */
  shard?: P7ProbeShard;
  /** Scope of the pending-Timer EXL/EPC construction; absent in historical manifests. */
  scope?: P7ProbeScope;
  logBase: number;
  recordWords: number;
  /** Raw CP0 reset reads stored before the first mtc0 or exception; absent in historical probes. */
  initialCp0?: Partial<Record<'status' | 'cause' | 'epc', P7ProbeCommitExpectation>>;
  scenarios: P7ProbeScenario[];
  /** Additional whole-program obligations for the real interrupt/eret/reinterrupt lane. */
  returnBoundary?: {
    variant: P7ProbeReturnVariant;
    mainCommits: P7ProbeCommitExpectation[];
    handlerCommits: P7ProbeHandlerCommitExpectation[];
    ackPc: number;
    /** A jal retried because BD=1 may legitimately write the same link more than once. */
    replayedLink?: P7ProbeCommitExpectation;
  };
}

export interface P7ProbeOptions {
  p7StressMode?: P7StressMode;
  timerInterrupt?: boolean;
  externalInterruptIntensity?: number;
  timerIntensity?: number;
  probeScenarioCount?: number;
  /** Internal only; automatic testing expands probe mode into deterministic shards. */
  probeShard?: P7ProbeShard;
  /** Internal deterministic coverage, emitted as individual automatic cases. */
  probeReturnVariant?: P7ProbeReturnVariant;
}
