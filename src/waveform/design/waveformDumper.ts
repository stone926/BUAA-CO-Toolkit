// @index waveform-dumper — 生成“查看波形”专用的 Icarus 顶层 dump 模块：$printtimescale、$dumpfile、整棵 testbench 与小存储器逐字 $dumpvars

import { createHash } from 'crypto';
import * as path from 'path';
import { normalizePathKey } from '../../pathUtils';
import { renderResourceTemplate } from '../../templates/templateRegistry';
import type { MemoryDump } from './designHierarchy';

export const waveformDumperFileName = 'co_iverilog_wave.v';
export const waveformDumperMarker = 'CO_GENERATED_WAVEFORM_DUMPER';

const wordsPerLine = 4;
const dumperDiagnosticPattern = /(?:^|[\\/])co_iverilog_wave\.v:(\d+): (error|warning): (.*)/gm;
const boundsWarningPrefix = "returning 'bx for out of bounds array access";

export interface WaveformDumperInput {
  readonly moduleName: string;
  readonly testbench: string;
  /** Dump path as the simulator should open it (relative to the VVP working directory). */
  readonly dumpFile: string;
  readonly memories: readonly MemoryDump[];
  /** Icarus stops recording at this byte budget while the normal trace keeps running. */
  readonly maximumDumpBytes?: number;
}

/** Stable per-workspace module name, mirroring the watchdog's collision-resistant naming. */
export function waveformDumperModuleName(workspaceRoot: string): string {
  const digest = createHash('sha256').update(normalizePathKey(path.resolve(workspaceRoot))).digest('hex').slice(0, 16);
  return `__co_iverilog_wave_${digest}`;
}

/**
 * Memory words are listed with constant indices, each line holding words of a
 * single memory. When the statically evaluated bounds are wrong, Icarus then
 * reports the out-of-range word while compiling instead of VVP aborting the whole
 * simulation once `$dumpvars` reaches it, and every diagnostic line names the
 * memory to blame (see `dumperRejection`).
 */
export function buildWaveformDumper(input: WaveformDumperInput): string {
  if (input.maximumDumpBytes !== undefined && (!Number.isSafeInteger(input.maximumDumpBytes) || input.maximumDumpBytes <= 0)) {
    throw new RangeError('maximumDumpBytes must be a positive safe integer');
  }
  const memoryDumps = input.memories.map((memory) => {
    const words: string[] = [];
    for (let index = memory.first; index <= memory.last; index++) {
      words.push(`${memory.path}[${index}]`);
    }
    const lines: string[] = [];
    for (let start = 0; start < words.length; start += wordsPerLine) {
      lines.push(words.slice(start, start + wordsPerLine).join(', '));
    }
    return `        $dumpvars(0,\n            ${lines.join(',\n            ')});\n`;
  }).join('');
  return renderResourceTemplate('verilog/waveform_dumper.v', {
    moduleName: input.moduleName,
    testbench: input.testbench,
    dumpFile: verilogStringLiteral(input.dumpFile),
    memoryDumps,
    dumpLimit: input.maximumDumpBytes === undefined ? '' : `        $dumplimit(${input.maximumDumpBytes});\n`
  });
}

export interface DumperRejection {
  /** Memories named on a rejected line of the dumper. */
  readonly memories: readonly MemoryDump[];
  /** Some diagnostic points at a dumper line that names no memory. */
  readonly unattributed: boolean;
}

/**
 * Compiler complaints about the generated dumper: any error, or a warning that a
 * dumped word lies outside its array (the static bounds were wrong). Undefined
 * when the dumper compiled cleanly.
 */
export function dumperRejection(compilerOutput: string, dumperText: string, memories: readonly MemoryDump[]): DumperRejection | undefined {
  const lines = dumperText.split(/\r?\n/);
  const rejected = new Set<MemoryDump>();
  let unattributed = false;
  let found = false;
  for (const match of compilerOutput.matchAll(dumperDiagnosticPattern)) {
    if (match[2] === 'warning' && !match[3].startsWith(boundsWarningPrefix)) {
      continue;
    }
    found = true;
    const line = lines[Number(match[1]) - 1] ?? '';
    const memory = memories.find((candidate) => line.split(/[\s,()]+/).some((word) => word.startsWith(`${candidate.path}[`)));
    if (memory) {
      rejected.add(memory);
    } else {
      unattributed = true;
    }
  }
  return found ? { memories: [...rejected], unattributed } : undefined;
}

/** Relative, forward-slash path from the simulator's working directory to the dump. */
export function dumpFileArgument(workingDirectory: string, dumpPath: string): string {
  const relative = path.relative(workingDirectory, dumpPath);
  return (relative && !path.isAbsolute(relative) ? relative : dumpPath).replace(/\\/g, '/');
}

function verilogStringLiteral(value: string): string {
  return `"${value.replace(/[\\"]/g, (character) => `\\${character}`)}"`;
}
