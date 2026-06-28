// @index generator-catalog — 内置 ASM 生成器指令集/分类资源加载
import * as fs from 'fs';
import * as path from 'path';
import { instructions } from '../language/mips/resources';

export type CpuProfile = 'P3' | 'P4' | 'P5' | 'P6' | 'P7';

export interface GeneratorInstructionCatalog {
  profiles: Record<CpuProfile, string[]>;
  categories: Record<GeneratorInstructionCategory, string[]>;
  falseTrapImmediateOperands: Record<string, [string, string]>;
  memoryAlignment: Record<string, number>;
  mduBusyCycles: Record<string, number>;
}

export type GeneratorInstructionCategory =
  | 'supported'
  | 'control'
  | 'branch'
  | 'linkBranch'
  | 'jumpLink'
  | 'divide'
  | 'hiLoWrite'
  | 'hiLoRead'
  | 'longLatencyHiLoWrite'
  | 'load'
  | 'store'
  | 'cp0';

export const generatorInstructionCatalog = loadGeneratorInstructionCatalog();

function loadGeneratorInstructionCatalog(): GeneratorInstructionCatalog {
  const filePath = path.join(__dirname, '..', '..', 'resources', 'mips', 'generatorProfiles.json');
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  validateCatalog(parsed);
  return parsed;
}

function validateCatalog(value: unknown): asserts value is GeneratorInstructionCatalog {
  if (!isRecord(value)) {
    throw new Error('Generator instruction catalog must be an object.');
  }
  const profiles = recordAt(value, 'profiles');
  const categories = recordAt(value, 'categories');
  const falseTrapImmediateOperands = recordAt(value, 'falseTrapImmediateOperands');
  const memoryAlignment = recordAt(value, 'memoryAlignment');
  const mduBusyCycles = recordAt(value, 'mduBusyCycles');

  for (const profile of ['P3', 'P4', 'P5', 'P6', 'P7']) {
    stringArrayAt(profiles, profile);
  }
  for (const category of [
    'supported', 'control', 'branch', 'linkBranch', 'jumpLink', 'divide',
    'hiLoWrite', 'hiLoRead', 'longLatencyHiLoWrite', 'load', 'store', 'cp0'
  ]) {
    stringArrayAt(categories, category);
  }
  for (const mnemonic of categories.supported as string[]) {
    if (mnemonic !== 'nop' && !instructions[mnemonic]) {
      throw new Error(`Generator catalog contains unsupported mnemonic: ${mnemonic}.`);
    }
  }
  for (const mnemonics of Object.values(profiles)) {
    for (const mnemonic of mnemonics as string[]) {
      if (!(categories.supported as string[]).includes(mnemonic)) {
        throw new Error(`Generator profile contains unsupported mnemonic: ${mnemonic}.`);
      }
    }
  }
  for (const [mnemonic, operands] of Object.entries(falseTrapImmediateOperands)) {
    if (!Array.isArray(operands) || operands.length !== 2 || operands.some((operand) => typeof operand !== 'string')) {
      throw new Error(`Invalid false trap operands for ${mnemonic}.`);
    }
  }
  for (const [mnemonic, alignment] of Object.entries(memoryAlignment)) {
    if (typeof alignment !== 'number' || !Number.isInteger(alignment) || alignment <= 0) {
      throw new Error(`Invalid memory alignment for ${mnemonic}.`);
    }
  }
  for (const [mnemonic, cycles] of Object.entries(mduBusyCycles)) {
    if (typeof cycles !== 'number' || !Number.isInteger(cycles) || cycles <= 0) {
      throw new Error(`Invalid MDU busy cycle count for ${mnemonic}.`);
    }
  }
}

function recordAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (!isRecord(value)) {
    throw new Error(`Generator instruction catalog ${key} must be an object.`);
  }
  return value;
}

function stringArrayAt(parent: Record<string, unknown>, key: string): string[] {
  const value = parent[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`Generator instruction catalog ${key} must be a string array.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
