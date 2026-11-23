export * from '../../p7Hardware';

export const p7ProbeFlagResumeInterruptEpc = 1 << 0;
export const p7ProbeFlagRecordHiLo = 1 << 1;
export const p7ProbeFlagRetryInterruptEpc = 1 << 2;
export const p7ProbeFlagRecordTimer0Ctrl = 1 << 3;
export const p7ProbeFlagRecordTimer0Preset = 1 << 4;
export const p7ProbeFlagRecordTimer0Count = 1 << 5;
export const p7ProbeFlagRecordTimer1Ctrl = 1 << 6;
export const p7ProbeFlagRecordTimer1Preset = 1 << 7;
export const p7ProbeFlagRecordTimer1Count = 1 << 8;
export const p7ProbeFlagRepeatTimerInterrupt = 1 << 9;
export const p7ProbeFlagRepeatTimerCaptured = 1 << 10;
export const p7ProbeFlagRepeatTimerFreshArmed = 1 << 11;

/**
 * The repeat handler writes this when it is entered again before the next
 * interrupt is armed. Historical probes also use it for an invalid read-back.
 */
export const p7ProbeMode1FailureMarker = 0xbad1_0001;
export const p7ProbeMode1DeassertMarkerBase = 0x7100;
export const p7ProbeMode1UnobservedMarkerBase = 0x7200;
export const p7ProbeTimerDisablePreset = 0x4000_0000;
export const p7ProbeTimerReloadPreset = 0x8000_0000;
