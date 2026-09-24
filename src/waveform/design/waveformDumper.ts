// @index waveform-dumper — 生成“查看波形”专用的 Icarus 顶层 dump 模块：$printtimescale、$dumpfile、整棵 testbench 与小存储器逐字 $dumpvars

import { createHash } from 'crypto';
import * as path from 'path';
import { normalizePathKey } from '../../pathUtils';
import { renderResourceTemplate } from '../../templates/templateRegistry';
import type { MemoryDump } from './designHierarchy';

export const waveformDumperFileName = 'co_iverilog_wave.v';
export const waveformDumperMarker = 'CO_GENERATED_WAVEFORM_DUMPER';

export interface WaveformDumperInput {
  readonly moduleName: string;
  readonly testbench: string;
  /** Dump path as the simulator should open it (relative to the VVP working directory). */
  readonly dumpFile: string;
  readonly memories: readonly MemoryDump[];
}

/** Stable per-workspace module name, mirroring the watchdog's collision-resistant naming. */
export function waveformDumperModuleName(workspaceRoot: string): string {
  const digest = createHash('sha256').update(normalizePathKey(path.resolve(workspaceRoot))).digest('hex').slice(0, 16);
  return `__co_iverilog_wave_${digest}`;
}

export function buildWaveformDumper(input: WaveformDumperInput): string {
  const memoryDumps = input.memories.map((memory) =>
    `        for (__co_word = ${memory.first}; __co_word <= ${memory.last}; __co_word = __co_word + 1) $dumpvars(0, ${memory.path}[__co_word]);\n`
  ).join('');
  return renderResourceTemplate('verilog/waveform_dumper.v', {
    moduleName: input.moduleName,
    testbench: input.testbench,
    dumpFile: verilogStringLiteral(input.dumpFile),
    memoryDumps
  });
}

/** Relative, forward-slash path from the simulator's working directory to the dump. */
export function dumpFileArgument(workingDirectory: string, dumpPath: string): string {
  const relative = path.relative(workingDirectory, dumpPath);
  return (relative && !path.isAbsolute(relative) ? relative : dumpPath).replace(/\\/g, '/');
}

function verilogStringLiteral(value: string): string {
  return `"${value.replace(/[\\"]/g, (character) => `\\${character}`)}"`;
}
