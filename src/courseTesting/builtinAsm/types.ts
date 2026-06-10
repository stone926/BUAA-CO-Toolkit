export type P7StressMode = 'anchor' | 'probe' | 'hybrid' | 'off';
export type P7ProbeScenarioKind = 'external' | 'timer0' | 'timer1' | 'adel' | 'ades' | 'syscall' | 'ri' | 'ov' | 'internal';

export interface P7ProbeScenario {
  id: number;
  kind: P7ProbeScenarioKind;
  expectedIpMask: number;
  expectedExcCode?: number;
  allowedEpc: number[];
  donePc: number;
  waitPc?: number;
  timerPreset?: number;
  armAddress?: number;
  armValue?: number;
  externalDelayCycles?: number;
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
