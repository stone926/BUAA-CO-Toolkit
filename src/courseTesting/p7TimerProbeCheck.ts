// @index p7-timer-probe-check — Ordered Timer counter and interrupt observations
import type { CpuTraceEvent } from '../language/mips/traceParser';
import type {
  P7ProbeCommitExpectation, P7ProbeRegisterSample, P7ProbeScenario
} from './builtinAsm/types';
import {
  p7CauseIpTimer0Mask, p7CauseIpTimer1Mask,
  p7ProbeTimerDisablePreset, p7ProbeTimerReloadPreset
} from './builtinAsm/p7/constants';
import { maximumCourseTraceClocks } from './pipeline/executionBudget';
import { parseProbeHexWord, parseProbeRegister } from './p7ProbeTraceWord';
import { readP7ProbeCapture } from './p7ProbeCapture';

type EventsAtPc = (pc: number) => readonly CpuTraceEvent[];
type ReportFailure = (message: string, observed?: true) => void;

export function timerIpCoverageMarker(
  scenario: P7ProbeScenario,
  atPc: EventsAtPc
): CpuTraceEvent | undefined {
  const observation = scenario.timerObservation;
  if (observation?.kind !== 'mode1' || !observation.ipSampling) return;
  const expected = observation.ipSampling.exhausted;
  const samples = atPc(expected.pc);
  return samples.length === 1 && matchesCommit(samples[0], expected) ? samples[0] : undefined;
}

export function checkTimerCounter(
  scenario: P7ProbeScenario,
  atPc: EventsAtPc,
  beforeLine: number,
  report: ReportFailure
): void {
  const observation = scenario.timerObservation;
  let lastLine = 0;
  if (observation?.kind === 'disable-reload') {
    const active = observation.activeCount.map(readCount);
    const stopped = observation.stoppedCount.map(readCount);
    const reloaded = readCount(observation.reloadedCount);
    if ([...active, ...stopped].some(value => value !== undefined
      && !isWithinPeriod(value, p7ProbeTimerDisablePreset))) {
      report('定时器 COUNT 未处于首次装载的计数范围内', true);
    }
    if (active[0] !== undefined && active[1] !== undefined && active[0] <= active[1]) {
      report('定时器启用后 COUNT 未递减', true);
    }
    if (stopped[0] !== undefined && active[1] !== undefined && stopped[0] > active[1]) {
      report('定时器停用时 COUNT 高于停用前的活动样本', true);
    }
    if (stopped[0] !== undefined && stopped[1] !== undefined && stopped[0] !== stopped[1]) {
      report('定时器停用期间 COUNT 发生变化', true);
    }
    if (reloaded !== undefined && !isWithinPeriod(reloaded, p7ProbeTimerReloadPreset)) {
      report('重新启用后定时器 COUNT 未从新 PRESET 装载', true);
    }
  } else if (observation?.kind === 'mode1') {
    const count = readCount(observation.count);
    if (count !== undefined && count > (scenario.timerPreset ?? 0)) {
      report('模式 1 定时器 COUNT 超出 PRESET 范围', true);
    }
    const stopped = observation.stoppedCount && readCount(observation.stoppedCount);
    if (count !== undefined && stopped !== undefined && count !== stopped) {
      report('停用后的模式 1 定时器 COUNT 发生变化', true);
    }
  }

  function readCount(sample: P7ProbeRegisterSample): number | undefined {
    const events = atPc(sample.pc);
    const value = events.length === 1 ? readRegister(events[0], sample.register) : undefined;
    if (value === undefined) {
      report(`定时器 COUNT 应在 PC 0x${sample.pc.toString(16)} 恰好读取一次`);
      return;
    }
    if (events[0].lineNumber <= lastLine || events[0].lineNumber >= beforeLine) {
      report(`定时器 COUNT 样本顺序不符（PC 0x${sample.pc.toString(16)}）`);
    }
    lastLine = events[0].lineNumber;
    return value;
  }
}

export function checkTimerIpSampling(
  scenario: P7ProbeScenario,
  atPc: EventsAtPc,
  marker: CpuTraceEvent | undefined,
  report: ReportFailure
): void {
  const observation = scenario.timerObservation;
  if (observation?.kind !== 'mode1' || !observation.ipSampling) return;
  const { sample, attempts, exhausted } = observation.ipSampling;
  const ipMask = scenario.kind === 'timer0' ? p7CauseIpTimer0Mask : p7CauseIpTimer1Mask;
  const polls = atPc(sample.pc);
  const values = polls.map(event => readRegister(event, sample.register));
  if (values.some(value => value !== undefined && value !== 0 && value !== ipMask)) {
    report('模式 1 定时器轮询的 Cause.IP 掩码结果不符', true);
  }
  const count = atPc(observation.count.pc)[0];
  if (count && polls.some(event => event.lineNumber <= count.lineNumber)) {
    report('模式 1 定时器的 Cause.IP 轮询早于 COUNT 样本');
  }
  if (marker) {
    if (values.length !== attempts || values.some(value => value !== ipMask)
      || polls.some(event => event.lineNumber >= marker.lineNumber)) {
      report('模式 1 定时器未观测标记与 Cause.IP 轮询记录不符', values.includes(0) ? true : undefined);
    }
    for (const expected of scenario.requiredPreHandlerCommits ?? []) {
      if (expected.pc >= exhausted.pc) continue;
      const events = atPc(expected.pc);
      if (events.length !== 1 || !matchesCommit(events[0], expected) || events[0].lineNumber >= marker.lineNumber) {
        report(`模式 1 定时器在轮询前的必要提交不符（PC 0x${expected.pc.toString(16)}）`,
          observedTimerReadback(events, expected, marker.lineNumber));
      }
    }
  } else if (atPc(exhausted.pc).length || !values.length || values.length > attempts
    || values.at(-1) !== 0 || values.slice(0, -1).some(value => value !== ipMask)) {
    report('模式 1 定时器缺少有效的 Cause.IP 去断言观测');
  }
}

export function observedTimerReadback(
  events: readonly CpuTraceEvent[],
  expected: P7ProbeCommitExpectation,
  beforeLine: number
): true | undefined {
  if (expected.kind !== 'grf' || events.length !== 1 || events[0].lineNumber >= beforeLine) return;
  const value = readRegister(events[0], expected.target);
  return value !== undefined && value !== expected.value ? true : undefined;
}

export function readFirstTimerCapture(
  scenario: P7ProbeScenario,
  atPc: EventsAtPc,
  afterLine: number,
  beforeLine: number,
  report: ReportFailure
): { status: number; cause: number; epc: number } | undefined {
  const observation = scenario.timerObservation;
  if (observation?.kind !== 'mode1') return;
  const { capture, invalid } = readP7ProbeCapture(atPc, observation.firstCapture, afterLine, beforeLine);
  if (!capture) {
    report('模式 1 定时器应在返回前依次记录首次中断的 Status、Cause 和 EPC',
      invalid || Number.isFinite(beforeLine) ? true : undefined);
  }
  return capture;
}

function isWithinPeriod(count: number, preset: number): boolean {
  return count >= preset - maximumCourseTraceClocks && count <= preset;
}

function readRegister(event: CpuTraceEvent, register: number): number | undefined {
  return event.kind === 'grf' && parseProbeRegister(event.target) === register ? parseWord(event.value) : undefined;
}

function matchesCommit(event: CpuTraceEvent, expected: P7ProbeCommitExpectation): boolean {
  return event.kind === expected.kind
    && (event.kind === 'grf' ? parseProbeRegister(event.target) : parseWord(event.target)) === expected.target
    && parseWord(event.value) === expected.value;
}

function parseWord(value: string): number | undefined {
  const word = parseProbeHexWord(value);
  return Number.isFinite(word) ? word : undefined;
}
