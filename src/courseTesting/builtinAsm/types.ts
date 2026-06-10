export type P7StressMode = 'anchor' | 'probe' | 'hybrid' | 'off';
export type P7ProbeScenarioKind = 'external' | 'timer0' | 'timer1' | 'internal';

export interface P7ProbeScenario {
  id: number;
  kind: P7ProbeScenarioKind;
  expectedIpMask: number;
  allowedEpc: number[];
  donePc: number;
  waitPc?: number;
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

