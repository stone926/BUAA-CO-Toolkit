// @index p7-hardware — 课程 P7 硬件布局资源加载与类型化常量
import * as fs from 'fs';
import * as path from 'path';

export interface P7HardwareConfig {
  memoryLayout: {
    userTextBaseAddress: number;
    exceptionHandlerAddress: number;
    probeLogBase: number;
    probeRecordWords: number;
    instructionMemoryWords: number;
    dataMemoryWords: number;
    mainTerminatorInstructionCount: number;
    probeState: {
      scenarioId: number;
      kind: number;
      donePc: number;
      recordPtr: number;
      flags: number;
      firstStatus: number;
      firstCause: number;
      firstEpc: number;
    };
    probeExternalArmAddress: number;
    exceptionFlushShadowSlots: number;
    interruptAnchorInstructionCount: number;
  };
  timer: {
    timer0: P7TimerRegisterConfig;
    timer1: P7TimerRegisterConfig;
    presetMin: number;
    presetMax: number;
    ctrlStartValue: number;
  };
  cp0: {
    status: {
      enableAllCourseInterrupts: number;
    };
    cause: {
      ipTimer0Mask: number;
      ipTimer1Mask: number;
      ipExternalMask: number;
      excCodeMask: number;
    };
    exceptionCodes: {
      adel: number;
      ades: number;
      syscall: number;
      ri: number;
      ov: number;
    };
  };
  interrupt: {
    externalAckAddress: number;
  };
  probe: {
    magic: number;
    kind: {
      external: number;
      timer0: number;
      timer1: number;
      internal: number;
      adel: number;
      ades: number;
      syscall: number;
      ri: number;
      ov: number;
    };
    defaultScenarioCount: number;
    maxScenarioCount: number;
  };
}

export interface P7TimerRegisterConfig {
  ctrl: number;
  preset: number;
  count: number;
}

export const p7Hardware = loadP7Hardware();

export const p7UserTextBaseAddress = p7Hardware.memoryLayout.userTextBaseAddress;
export const p7ExceptionHandlerAddress = p7Hardware.memoryLayout.exceptionHandlerAddress;
export const p7ProbeLogBase = p7Hardware.memoryLayout.probeLogBase;
export const p7ProbeRecordWords = p7Hardware.memoryLayout.probeRecordWords;
export const p7InstructionMemoryWords = p7Hardware.memoryLayout.instructionMemoryWords;
export const p7DataMemoryWords = p7Hardware.memoryLayout.dataMemoryWords;
export const p7MainTerminatorInstructionCount = p7Hardware.memoryLayout.mainTerminatorInstructionCount;
export const p7ExceptionFlushShadowSlots = p7Hardware.memoryLayout.exceptionFlushShadowSlots;
export const p7InterruptAnchorInstructionCount = p7Hardware.memoryLayout.interruptAnchorInstructionCount;
export const p7CourseInstructionCountMaximum =
  ((p7ExceptionHandlerAddress - p7UserTextBaseAddress) / 4) - p7MainTerminatorInstructionCount;
export const p7KernelTextDumpEndAddress =
  p7UserTextBaseAddress + p7InstructionMemoryWords * 4 - 4;

export const p7ProbeStateScenarioId = p7Hardware.memoryLayout.probeState.scenarioId;
export const p7ProbeStateKind = p7Hardware.memoryLayout.probeState.kind;
export const p7ProbeStateDonePc = p7Hardware.memoryLayout.probeState.donePc;
export const p7ProbeStateRecordPtr = p7Hardware.memoryLayout.probeState.recordPtr;
export const p7ProbeStateFlags = p7Hardware.memoryLayout.probeState.flags;
export const p7ProbeStateFirstStatus = p7Hardware.memoryLayout.probeState.firstStatus;
export const p7ProbeStateFirstCause = p7Hardware.memoryLayout.probeState.firstCause;
export const p7ProbeStateFirstEpc = p7Hardware.memoryLayout.probeState.firstEpc;
export const p7ProbeExternalArmAddress = p7Hardware.memoryLayout.probeExternalArmAddress;

export const p7StatusEnableAllCourseInterrupts = p7Hardware.cp0.status.enableAllCourseInterrupts;
export const p7ExternalInterruptAckAddress = p7Hardware.interrupt.externalAckAddress;

export const p7Timer0Ctrl = p7Hardware.timer.timer0.ctrl;
export const p7Timer0Preset = p7Hardware.timer.timer0.preset;
export const p7Timer0Count = p7Hardware.timer.timer0.count;
export const p7Timer1Ctrl = p7Hardware.timer.timer1.ctrl;
export const p7Timer1Preset = p7Hardware.timer.timer1.preset;
export const p7Timer1Count = p7Hardware.timer.timer1.count;

export const p7CauseIpTimer0Mask = p7Hardware.cp0.cause.ipTimer0Mask;
export const p7CauseIpTimer1Mask = p7Hardware.cp0.cause.ipTimer1Mask;
export const p7CauseIpExternalMask = p7Hardware.cp0.cause.ipExternalMask;
export const p7CauseExcCodeMask = p7Hardware.cp0.cause.excCodeMask;
export const p7StatusEnableExternalInterrupt = 1 | p7CauseIpExternalMask;

export const p7ProbeMagic = p7Hardware.probe.magic;
export const p7ProbeKindExternal = p7Hardware.probe.kind.external;
export const p7ProbeKindTimer0 = p7Hardware.probe.kind.timer0;
export const p7ProbeKindTimer1 = p7Hardware.probe.kind.timer1;
export const p7ProbeKindInternal = p7Hardware.probe.kind.internal;
export const p7ProbeKindAdel = p7Hardware.probe.kind.adel;
export const p7ProbeKindAdes = p7Hardware.probe.kind.ades;
export const p7ProbeKindSyscall = p7Hardware.probe.kind.syscall;
export const p7ProbeKindRi = p7Hardware.probe.kind.ri;
export const p7ProbeKindOv = p7Hardware.probe.kind.ov;
export const p7ProbeDefaultScenarioCount = p7Hardware.probe.defaultScenarioCount;
export const p7ProbeMaxScenarioCount = p7Hardware.probe.maxScenarioCount;
export const p7ProbeTimerPresetMin = p7Hardware.timer.presetMin;
export const p7ProbeTimerPresetMax = p7Hardware.timer.presetMax;
export const p7ProbeTimerCtrlStart = p7Hardware.timer.ctrlStartValue;

export const p7ExcCodeAdel = p7Hardware.cp0.exceptionCodes.adel;
export const p7ExcCodeAdes = p7Hardware.cp0.exceptionCodes.ades;
export const p7ExcCodeSyscall = p7Hardware.cp0.exceptionCodes.syscall;
export const p7ExcCodeRi = p7Hardware.cp0.exceptionCodes.ri;
export const p7ExcCodeOv = p7Hardware.cp0.exceptionCodes.ov;

export function p7Hex(value: number): string {
  return `0x${(value >>> 0).toString(16)}`;
}

function loadP7Hardware(): P7HardwareConfig {
  const filePath = path.join(__dirname, '..', '..', 'resources', 'co', 'p7Hardware.json');
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  validateP7Hardware(parsed);
  return parsed;
}

function validateP7Hardware(value: unknown): asserts value is P7HardwareConfig {
  if (!isRecord(value)) {
    throw new Error('P7 hardware resource must be a JSON object.');
  }
  const memoryLayout = recordAt(value, 'memoryLayout');
  const probeState = recordAt(memoryLayout, 'probeState');
  const timer = recordAt(value, 'timer');
  const timer0 = recordAt(timer, 'timer0');
  const timer1 = recordAt(timer, 'timer1');
  const cp0 = recordAt(value, 'cp0');
  const status = recordAt(cp0, 'status');
  const cause = recordAt(cp0, 'cause');
  const exceptionCodes = recordAt(cp0, 'exceptionCodes');
  const interrupt = recordAt(value, 'interrupt');
  const probe = recordAt(value, 'probe');
  const kind = recordAt(probe, 'kind');

  integerAt(memoryLayout, 'userTextBaseAddress');
  integerAt(memoryLayout, 'exceptionHandlerAddress');
  integerAt(memoryLayout, 'probeLogBase');
  integerAt(memoryLayout, 'probeRecordWords');
  integerAt(memoryLayout, 'instructionMemoryWords');
  integerAt(memoryLayout, 'dataMemoryWords');
  integerAt(memoryLayout, 'mainTerminatorInstructionCount');
  integerAt(memoryLayout, 'probeExternalArmAddress');
  integerAt(memoryLayout, 'exceptionFlushShadowSlots');
  integerAt(memoryLayout, 'interruptAnchorInstructionCount');
  integerAt(probeState, 'scenarioId');
  integerAt(probeState, 'kind');
  integerAt(probeState, 'donePc');
  integerAt(probeState, 'recordPtr');
  integerAt(probeState, 'flags');
  integerAt(probeState, 'firstStatus');
  integerAt(probeState, 'firstCause');
  integerAt(probeState, 'firstEpc');

  for (const registers of [timer0, timer1]) {
    integerAt(registers, 'ctrl');
    integerAt(registers, 'preset');
    integerAt(registers, 'count');
  }
  integerAt(timer, 'presetMin');
  integerAt(timer, 'presetMax');
  integerAt(timer, 'ctrlStartValue');
  integerAt(status, 'enableAllCourseInterrupts');
  integerAt(cause, 'ipTimer0Mask');
  integerAt(cause, 'ipTimer1Mask');
  integerAt(cause, 'ipExternalMask');
  integerAt(cause, 'excCodeMask');
  integerAt(exceptionCodes, 'adel');
  integerAt(exceptionCodes, 'ades');
  integerAt(exceptionCodes, 'syscall');
  integerAt(exceptionCodes, 'ri');
  integerAt(exceptionCodes, 'ov');
  integerAt(interrupt, 'externalAckAddress');
  integerAt(probe, 'magic');
  integerAt(probe, 'defaultScenarioCount');
  integerAt(probe, 'maxScenarioCount');
  for (const key of ['external', 'timer0', 'timer1', 'internal', 'adel', 'ades', 'syscall', 'ri', 'ov']) {
    integerAt(kind, key);
  }

  const userText = memoryLayout.userTextBaseAddress as number;
  const handler = memoryLayout.exceptionHandlerAddress as number;
  const probeLogBase = memoryLayout.probeLogBase as number;
  const probeRecordWords = memoryLayout.probeRecordWords as number;
  const instructionMemoryWords = memoryLayout.instructionMemoryWords as number;
  const dataMemoryWords = memoryLayout.dataMemoryWords as number;
  const mainTerminatorInstructionCount = memoryLayout.mainTerminatorInstructionCount as number;
  const userInstructionSlots = (handler - userText) / 4;
  if (handler <= userText || (handler - userText) % 4 !== 0) {
    throw new Error('P7 exception handler must be word-aligned after user text.');
  }
  if (probeLogBase >= userText || probeRecordWords <= 0 || instructionMemoryWords <= 0 || dataMemoryWords <= 0 || mainTerminatorInstructionCount <= 0) {
    throw new Error('Invalid P7 memory layout bounds.');
  }
  if (mainTerminatorInstructionCount >= userInstructionSlots) {
    throw new Error('Invalid P7 terminator reservation.');
  }
  if ((memoryLayout.exceptionHandlerAddress as number) > userText + instructionMemoryWords * 4 - 4) {
    throw new Error('P7 exception handler must be inside instruction memory.');
  }
  if ((timer.presetMin as number) > (timer.presetMax as number)) {
    throw new Error('Invalid P7 timer preset range.');
  }
  validateHexAnnotations(value);
}

function recordAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (!isRecord(value)) {
    throw new Error(`Invalid P7 hardware resource: ${key} must be an object.`);
  }
  return value;
}

function integerAt(parent: Record<string, unknown>, key: string): void {
  const value = parent[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid P7 hardware resource: ${key} must be a non-negative integer.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateHexAnnotations(value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    if (key.startsWith('_') && key.endsWith('_hex') && typeof fieldValue === 'string') {
      const targetKey = key.slice(1, -4);
      const targetValue = value[targetKey];
      const parsed = Number.parseInt(fieldValue, 16);
      if (typeof targetValue === 'number' && Number.isInteger(parsed) && parsed !== targetValue) {
        throw new Error(`Invalid P7 hardware resource: ${key} does not match ${targetKey}.`);
      }
    }
    validateHexAnnotations(fieldValue);
  }
}
