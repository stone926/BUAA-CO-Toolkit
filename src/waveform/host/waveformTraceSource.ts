// @index waveform-trace — 波形旁的 $display trace 关联：同名 .sim.out 须声明打开了该 VCD，按 $printtimescale 把事件时间换算为 dump tick

import { readFile, stat } from 'fs/promises';
import * as path from 'path';
import { parseCpuTraceOutput } from '../../language/mips/traceParser';
import type { WaveformTraceData, WaveformTraceEvent } from '../model/protocol';
import { parseTimeScale, TimeScale } from '../model/timeScale';

/** Traces are bounded by the simulator's 16 MiB stdout ceiling; refuse anything much larger. */
const maximumTraceBytes = 32 * 1024 * 1024;
/** The trace is written right after the simulator exits, never long before the dump was closed. */
const staleToleranceMs = 2000;

const dumpfileOpenedPattern = /^VCD info: dumpfile (.+) opened for output\.?\s*$/m;
const timescaleLinePattern = /^Time scale of \((.+?)\) is (\d+\s*[a-z]+)\s*\/\s*(\d+\s*[a-z]+)/m;

/** The trace file that belongs to a dump: `<stem>.sim.out` next to `<stem>.vcd`. */
export function traceFileForVcd(vcdPath: string): string {
  const parsed = path.parse(vcdPath);
  return path.join(parsed.dir, `${parsed.name}.sim.out`);
}

/**
 * Read the sibling trace of `vcdPath` if it provably comes from the run that wrote
 * the dump. Returns undefined when there is no such trace.
 */
export async function loadTraceForVcd(vcdPath: string, dumpScale: TimeScale): Promise<WaveformTraceData | undefined> {
  const tracePath = traceFileForVcd(vcdPath);
  let traceStat;
  let vcdStat;
  try {
    [traceStat, vcdStat] = await Promise.all([stat(tracePath), stat(vcdPath)]);
  } catch {
    return undefined;
  }
  if (!traceStat.isFile() || traceStat.size > maximumTraceBytes || traceStat.mtimeMs + staleToleranceMs < vcdStat.mtimeMs) {
    return undefined;
  }
  const text = await readFile(tracePath, 'utf8');
  return traceFromSimulationOutput(text, path.basename(vcdPath), dumpScale, path.basename(tracePath));
}

/**
 * Pure core: validate that `text` opened `vcdFileName`, then place its course trace
 * lines (`%d@%h: $%d <= %h`, `*%h <= %h`) on the dump's tick axis.
 */
export function traceFromSimulationOutput(
  text: string,
  vcdFileName: string,
  dumpScale: TimeScale,
  sourceName: string
): WaveformTraceData | undefined {
  const opened = dumpfileOpenedPattern.exec(text);
  if (!opened || !sameFileName(path.basename(opened[1].trim().replace(/\\/g, '/')), vcdFileName)) {
    return undefined;
  }
  const events = parseCpuTraceOutput(text);
  if (!events.length) {
    return undefined;
  }
  const unit = timescaleUnit(text);
  if (!unit) {
    return { source: sourceName, events: [], note: '仿真输出缺少 testbench 时间单位（$printtimescale），无法把 trace 对齐到波形时间轴' };
  }
  const ticksPerUnit = unit.femtoseconds / dumpScale.femtoseconds;
  const placed: WaveformTraceEvent[] = [];
  let unplaced = 0;
  for (const event of events) {
    if (event.cycle === undefined) {
      unplaced++;
      continue;
    }
    // Lower-case hex to match the waveform's value rendering.
    placed.push({
      time: Math.round(event.cycle * ticksPerUnit),
      kind: event.kind,
      pc: event.pc.toLowerCase(),
      target: event.target.toLowerCase(),
      value: event.value.toLowerCase()
    });
  }
  placed.sort((left, right) => left.time - right.time);
  const note = unplaced === 0
    ? undefined
    : placed.length === 0
      ? 'trace 行没有打印仿真时间（如 P4 的 @pc: 格式），无法定位到波形时间轴'
      : `${unplaced} 行 trace 没有仿真时间，已省略`;
  return { source: sourceName, events: placed, ...(note ? { note } : {}) };
}

function timescaleUnit(text: string): TimeScale | undefined {
  const match = timescaleLinePattern.exec(text);
  return match ? parseTimeScale(match[2]) : undefined;
}

function sameFileName(left: string, right: string): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
