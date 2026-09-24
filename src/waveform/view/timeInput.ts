// @index waveform-time-input — 解析用户输入的跳转目标：带单位时间、#原始 tick、c/周期 序号

import { isTimeUnit, TimeScale, TimeUnit, ticksFromPhysical } from '../model/timeScale';

export type TimeInputTarget =
  | { readonly kind: 'time'; readonly ticks: number }
  | { readonly kind: 'cycle'; readonly cycle: number };

/**
 * Accepts `474ns`, `1.5 us`, `2µs`, `474` (in `defaultUnit`), `#474000` (raw dump
 * ticks) and `c118` / `cycle 118` / `周期 118` (the 118th rising clock edge).
 */
export function parseTimeInput(text: string, scale: TimeScale, defaultUnit: TimeUnit): TimeInputTarget | undefined {
  const input = text.trim().toLowerCase().replace(/µ/g, 'u').replace(/\s+/g, ' ');
  if (!input) {
    return undefined;
  }
  const raw = /^#\s*(\d+)$/.exec(input);
  if (raw) {
    return { kind: 'time', ticks: Number(raw[1]) };
  }
  const cycle = /^(?:c|cycle|周期|第)\s*(\d+)\s*(?:周期)?$/.exec(input);
  if (cycle) {
    return { kind: 'cycle', cycle: Number(cycle[1]) };
  }
  const time = /^(-?\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)$/.exec(input);
  if (!time) {
    return undefined;
  }
  const unitText = time[2] || defaultUnit;
  if (!isTimeUnit(unitText)) {
    return undefined;
  }
  const ticks = ticksFromPhysical(Number(time[1]), unitText as TimeUnit, scale);
  return Number.isFinite(ticks) ? { kind: 'time', ticks: Math.round(ticks) } : undefined;
}
