// @index waveform-defaults — 课程感知的默认值：指令类信号自动用 MIPS 反汇编、时钟识别、首开默认信号集与 GRF 寄存器别名

import { gprNames } from '../../mips/core/assembler/registers';
import type { Radix } from '../model/radix';
import { changeCount } from '../model/signalValues';
import type { WaveformData, WaveVar } from '../model/waveformData';

const instructionName = /(^|[^a-z])(ir|ins|inst|instr|instruction)([^a-z]|$)/i;
const addressLike = /(addr|pc|adr)/i;
const clockNames = ['clk', 'clock', 'clk_i', 'sys_clk', 'clk_in'];
const memoryWordPattern = /^(.+)\[(-?\d+)\]$/;
/** Default signals taken from the top scope on first open. */
const maximumDefaultSignals = 40;

/** Instruction-carrying 32-bit signals (D_ins, IR_E, i_inst_rdata…) default to disassembly. */
export function defaultRadix(variable: WaveVar): Radix {
  if (variable.width === 32 && instructionName.test(variable.name) && !addressLike.test(variable.name)) {
    return 'instr';
  }
  return 'hex';
}

/** Prefer a 1-bit clock-named signal in the shallowest scope that actually toggles. */
export function detectClock(data: WaveformData): number | undefined {
  let best: { index: number; depth: number; rank: number } | undefined;
  data.vars.forEach((variable, index) => {
    if (variable.width !== 1) {
      return;
    }
    const rank = clockNames.indexOf(variable.name.toLowerCase());
    if (rank < 0 || changeCount(data.tracks, variable.track) < 4) {
      return;
    }
    const depth = scopeDepth(data, variable.scope);
    if (!best || depth < best.depth || (depth === best.depth && rank < best.rank)) {
      best = { index, depth, rank };
    }
  });
  return best?.index;
}

function scopeDepth(data: WaveformData, scope: number): number {
  let depth = 0;
  for (let current = scope; current >= 0 && depth < 1000; current = data.scopes[current].parent) {
    depth++;
  }
  return depth;
}

export interface DefaultSignalPlan {
  /** Top-scope signals shown as plain rows. */
  readonly signals: readonly number[];
  /** A register-file-shaped memory (32 words) offered as a collapsed group. */
  readonly registerFile?: { readonly name: string; readonly words: readonly number[] };
}

/**
 * First-open signal set: the testbench scope's own nets/regs (not parameters,
 * loop integers or memory words), plus a GRF-like array if the dump has one.
 */
export function defaultSignalPlan(data: WaveformData): DefaultSignalPlan {
  const scopesWithVars = new Set(data.vars.map((variable) => variable.scope));
  const root = data.scopes.findIndex((scope, index) => scope.parent < 0 && scopesWithVars.has(index));
  const signals = root < 0 ? [] : data.vars
    .map((variable, index) => ({ variable, index }))
    .filter(({ variable }) => variable.scope === root
      && variable.kind !== 'parameter'
      && variable.kind !== 'integer'
      && !memoryWordPattern.test(variable.name))
    .sort((left, right) => signalOrder(left.variable) - signalOrder(right.variable)
      || left.variable.name.localeCompare(right.variable.name, 'en', { numeric: true }))
    .slice(0, maximumDefaultSignals)
    .map(({ index }) => index);
  const registerFile = findRegisterFile(data);
  return registerFile ? { signals, registerFile } : { signals };
}

/** Clock and reset first, then everything else. */
function signalOrder(variable: WaveVar): number {
  const name = variable.name.toLowerCase();
  if (clockNames.includes(name)) {
    return 0;
  }
  if (/^(reset|rst|rst_n|resetn|clr)$/.test(name)) {
    return 1;
  }
  if (name === 'interrupt') {
    return 2;
  }
  return 3;
}

/** The dumped memory with exactly 32 words of 32 bits (the GPR file), if unique enough to guess. */
export function findRegisterFile(data: WaveformData): { name: string; words: number[] } | undefined {
  const groups = new Map<string, number[]>();
  data.vars.forEach((variable, index) => {
    const word = memoryWordPattern.exec(variable.name);
    if (!word || variable.width !== 32) {
      return;
    }
    const key = `${data.scopes[variable.scope].path}.${word[1]}`;
    const members = groups.get(key) ?? [];
    members.push(index);
    groups.set(key, members);
  });
  for (const [key, members] of groups) {
    const indexes = members.map((index) => Number(memoryWordPattern.exec(data.vars[index].name)![2]));
    if (members.length === 32 && indexes.every((value) => value >= 0 && value < 32)) {
      members.sort((left, right) => wordNumber(data.vars[left]) - wordNumber(data.vars[right]));
      return { name: key.slice(key.lastIndexOf('.') + 1), words: members };
    }
  }
  return undefined;
}

function wordNumber(variable: WaveVar): number {
  return Number(memoryWordPattern.exec(variable.name)?.[2] ?? 0);
}

/**
 * MIPS register alias (`$sp`) for a word of a 32×32 register file, so GRF rows read
 * like the course trace. Returns undefined for anything else.
 */
export function registerAlias(data: WaveformData, variable: WaveVar): string | undefined {
  const word = memoryWordPattern.exec(variable.name);
  if (!word || variable.width !== 32) {
    return undefined;
  }
  const index = Number(word[2]);
  if (!(index >= 0 && index < 32)) {
    return undefined;
  }
  const siblings = registerFileSize(data, variable, word[1]);
  return siblings === 32 ? gprNames[index].names[0] : undefined;
}

const registerFileSizeCache = new WeakMap<WaveformData, Map<string, number>>();

function registerFileSize(data: WaveformData, variable: WaveVar, base: string): number {
  let sizes = registerFileSizeCache.get(data);
  if (!sizes) {
    sizes = new Map();
    for (const candidate of data.vars) {
      const word = memoryWordPattern.exec(candidate.name);
      if (word && candidate.width === 32) {
        const key = `${candidate.scope}:${word[1]}`;
        sizes.set(key, (sizes.get(key) ?? 0) + 1);
      }
    }
    registerFileSizeCache.set(data, sizes);
  }
  return sizes.get(`${variable.scope}:${base}`) ?? 0;
}
