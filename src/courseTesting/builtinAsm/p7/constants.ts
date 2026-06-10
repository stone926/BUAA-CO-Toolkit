export const p7UserTextBaseAddress = 0x3000;
export const p7ExceptionHandlerAddress = 0x4180;
export const p7ProbeLogBase = 0x2800;
export const p7ProbeRecordWords = 8;

export const p7ProbeStateScenarioId = 0x27e0;
export const p7ProbeStateKind = 0x27e4;
export const p7ProbeStateDonePc = 0x27e8;
export const p7ProbeStateRecordPtr = 0x27ec;

export const p7StatusEnableAllCourseInterrupts = 0x1c01;
export const p7ExternalInterruptAckAddress = 0x7f20;

export const p7Timer0Ctrl = 0x7f00;
export const p7Timer0Preset = 0x7f04;
export const p7Timer0Count = 0x7f08;
export const p7Timer1Ctrl = 0x7f10;
export const p7Timer1Preset = 0x7f14;
export const p7Timer1Count = 0x7f18;

export const p7CauseIpTimer0Mask = 0x0400;
export const p7CauseIpTimer1Mask = 0x0800;
export const p7CauseIpExternalMask = 0x1000;
export const p7CauseExcCodeMask = 0x007c;

export const p7ProbeMagic = 0xc0a70001;
export const p7ProbeKindExternal = 1;
export const p7ProbeKindTimer0 = 2;
export const p7ProbeKindTimer1 = 3;
export const p7ProbeKindInternal = 4;
export const p7ProbeTimerPreset = 32;
export const p7ProbeTimerCtrlStart = 0x9;

