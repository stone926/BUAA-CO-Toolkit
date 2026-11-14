// @index mips-core — Validated immutable instruction registries with scoped encoding and decoding
import { isaInstructions, isaInstructionByMnemonic } from '../generated/isaCatalog';
import { marsInstructionByMnemonic } from '../assembler/marsInstructionFacts';
import { marsIntegerExtensionMnemonics } from '../assembler/marsIntegerInstructionFacts';
import { isSupportedAssemblerMnemonic } from '../assembler/capabilities';
import { marsFpMemoryOpcodes } from '../assembler/marsInstructionFacts';
import { validateCustomMetadata } from './metadataValidation';
import type { CustomInstructionDefinition, CustomInstructionMetadata, CustomInstructionMode } from './api';

export interface CustomEncodingField { readonly name: string; readonly width: number; readonly shift: number }
interface CompiledInstruction {
  readonly definition: CustomInstructionDefinition;
  readonly metadata: CustomInstructionMetadata;
  readonly fields: readonly CustomEncodingField[];
  readonly mask: number;
  readonly value: number;
}
const modes = ['mars', 'P3', 'P4', 'P5', 'P6', 'P7'];
const maskFor = (width: number): number => width === 32 ? 0xffff_ffff : 2 ** width - 1;
export class CustomInstructionRegistry {
  private readonly entries: readonly CompiledInstruction[];
  constructor(definitions: readonly CustomInstructionDefinition[]) {
    if (!Array.isArray(definitions) || definitions.length > 256) throw new Error('Custom instruction definitions must be an array of at most 256 entries');
    const entries: CompiledInstruction[] = [];
    for (const candidate of definitions) {
      const compiled = compile(candidate);
      const definition = compiled.definition;
      for (const other of entries) {
        if (!definition.modes.some(mode => other.definition.modes.includes(mode))) continue;
        if ([definition.mnemonic, ...(definition.aliases ?? [])].some(name => [other.definition.mnemonic, ...(other.definition.aliases ?? [])].includes(name))) throw new Error(`Duplicate custom instruction ${definition.mnemonic}`);
        if ((((compiled.value ^ other.value) & compiled.mask & other.mask) >>> 0) === 0) {
          throw new Error(`Ambiguous custom instruction encodings: ${definition.mnemonic} and ${other.definition.mnemonic}`);
        }
      }
      if (!definition.override) {
        for (const name of [definition.mnemonic, ...(definition.aliases ?? [])]) {
          if (definition.modes.some(mode => isSupportedAssemblerMnemonic(name, mode))) throw new Error(`Custom instruction ${name} collides with a native mnemonic; set override explicitly`);
        }
        if (isaInstructionByMnemonic.has(definition.mnemonic) || marsInstructionByMnemonic.has(definition.mnemonic)
          || marsIntegerExtensionMnemonics.includes(definition.mnemonic)) throw new Error(`Custom instruction ${definition.mnemonic} collides with a native mnemonic; set override explicitly`);
        for (const native of isaInstructions) {
          if (!definition.modes.some(mode => mode === 'mars' || native.profiles.includes(mode))) continue;
          if ((((compiled.value ^ native.runtimeMatchValue) & compiled.mask & native.runtimeMatchMask) >>> 0) === 0) {
            throw new Error(`Custom instruction ${definition.mnemonic} overlaps native ${native.mnemonic}; set override explicitly`);
          }
        }
        // COP1 uses opcode 17; its ordinary-mode selector space belongs to MARS.
        if (definition.modes.includes('mars') && (((compiled.value ^ 0x44000000) & compiled.mask & 0xfc000000) >>> 0) === 0) {
          throw new Error(`Custom instruction ${definition.mnemonic} overlaps MARS COP1; set override explicitly`);
        }
        if (definition.modes.includes('mars')) {
          const ordinary = [
            { mask: 0xfc00003f, value: 1, name: 'movf/movt' },
            ...Object.entries(marsFpMemoryOpcodes).map(([name, opcode]) => ({ mask: 0xfc000000, value: (opcode << 26) >>> 0, name }))
          ];
          for (const native of ordinary) if ((((compiled.value ^ native.value) & compiled.mask & native.mask) >>> 0) === 0) throw new Error(`Custom instruction ${definition.mnemonic} overlaps MARS ${native.name}; set override explicitly`);
        }
      }
      entries.push(compiled);
    }
    this.entries = Object.freeze(entries);
  }
  metadata(mode?: CustomInstructionMode): readonly CustomInstructionMetadata[] {
    return Object.freeze(this.entries.filter(entry => !mode || entry.definition.modes.includes(mode)).map(entry => entry.metadata));
  }
  get(mnemonic: string, mode: CustomInstructionMode): CustomInstructionDefinition | undefined {
    return this.find(mnemonic, mode)?.definition;
  }
  encodings(mode?: CustomInstructionMode): readonly { readonly mnemonic: string; readonly mask: number; readonly value: number; readonly template: string }[] {
    return Object.freeze(this.entries.filter(entry => !mode || entry.definition.modes.includes(mode)).map(entry => Object.freeze({
      mnemonic: entry.definition.mnemonic, mask: entry.mask, value: entry.value,
      template: `${entry.definition.mnemonic} ${entry.definition.operands.map(operand => operand.kind === 'memory' ? `${operand.offsetField}($${operand.baseField})` : operand.kind === 'register' ? `$${operand.field}` : operand.field).join(', ')}`.trim()
    })));
  }
  fields(mnemonic: string, mode: CustomInstructionMode): readonly CustomEncodingField[] { return this.find(mnemonic, mode)?.fields ?? []; }
  decode(word: number, mode: CustomInstructionMode): { readonly definition: CustomInstructionDefinition; readonly fields: Readonly<Record<string, number>> } | undefined {
    const entry = this.entries.find(item => item.definition.modes.includes(mode) && ((word & item.mask) >>> 0) === item.value);
    if (!entry) return undefined;
    const fields: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const field of entry.fields) fields[field.name] = (word >>> field.shift) & maskFor(field.width);
    return { definition: entry.definition, fields: Object.freeze(fields) };
  }
  encode(mnemonic: string, fields: Readonly<Record<string, number>>, mode: CustomInstructionMode): number {
    const entry = this.find(mnemonic, mode);
    if (!entry) throw new Error(`Unknown custom instruction ${mnemonic} in ${mode}`);
    for (const key of Object.keys(fields)) if (!entry.fields.some(field => field.name === key)) throw new Error(`${mnemonic}: unknown field ${key}`);
    let word = entry.value;
    for (const field of entry.fields) {
      const value = fields[field.name];
      if (!Number.isSafeInteger(value) || value < -(2 ** (field.width - 1)) || value > maskFor(field.width)) throw new Error(`${mnemonic}: field ${field.name} is outside ${field.width} bits`);
      word = (word | ((value & maskFor(field.width)) << field.shift)) >>> 0;
    }
    return word;
  }
  private find(mnemonic: string, mode: CustomInstructionMode): CompiledInstruction | undefined {
    const name = mnemonic.toLowerCase();
    return this.entries.find(entry => (entry.definition.mnemonic === name || entry.definition.aliases?.includes(name)) && entry.definition.modes.includes(mode));
  }
}

export function validateScriptInstructionDefinitions(value: unknown): readonly CustomInstructionDefinition[] {
  if (!Array.isArray(value)) throw new Error('An instruction module must export an instruction array');
  const registry = new CustomInstructionRegistry(value as CustomInstructionDefinition[]);
  return Object.freeze(registry.metadata().map(item => registry.get(item.mnemonic, item.modes[0])!));
}

/** A formatting/ISA-facts view which deliberately cannot execute instructions. */
export function createCustomInstructionMetadataRegistry(metadata: readonly CustomInstructionMetadata[]): CustomInstructionRegistry {
  return new CustomInstructionRegistry(metadata.map(item => ({ ...item, execute() { throw new Error('A metadata-only custom instruction registry cannot execute instructions'); } })));
}

function compile(input: CustomInstructionDefinition): CompiledInstruction {
  if (!input || typeof input !== 'object' || input.apiVersion !== 1 || typeof input.mnemonic !== 'string'
    || !/^[a-z][a-z0-9_.]*$/.test(input.mnemonic) || input.mnemonic.length > 64) throw new Error('Custom instruction requires apiVersion 1 and a lowercase mnemonic');
  const name = input.mnemonic;
  if (input.aliases !== undefined && (!Array.isArray(input.aliases) || input.aliases.length > 32 || input.aliases.some(alias => typeof alias !== 'string' || !/^[a-z][a-z0-9_.]*$/.test(alias) || alias.length > 64) || new Set([name, ...input.aliases]).size !== input.aliases.length + 1)) throw new Error(`${name}: invalid aliases`);
  if (!Array.isArray(input.modes) || input.modes.length === 0 || input.modes.some(mode => !modes.includes(mode)) || new Set(input.modes).size !== input.modes.length) throw new Error(`${name}: invalid modes`);
  if (typeof input.execute !== 'function') throw new Error(`${name}: execute must be a function`);
  if (typeof input.encoding !== 'string') throw new Error(`${name}: encoding must be a bit pattern`);
  let remaining = 32, mask = 0, value = 0;
  const fields: CustomEncodingField[] = [];
  for (const token of input.encoding.trim().split(/\s+/)) {
    if (/^[01]+$/.test(token)) {
      remaining -= token.length;
      if (remaining < 0) throw new Error(`${name}: encoding exceeds 32 bits`);
      mask = (mask | (maskFor(token.length) << remaining)) >>> 0;
      value = (value | (parseInt(token, 2) << remaining)) >>> 0;
    } else {
      const match = /^([A-Za-z][A-Za-z0-9_]*):([1-9][0-9]?)$/.exec(token);
      if (!match || Number(match[2]) > 31) throw new Error(`${name}: invalid encoding token ${token}`);
      const width = Number(match[2]); remaining -= width;
      if (remaining < 0 || fields.some(field => field.name === match[1])) throw new Error(`${name}: duplicate field or encoding exceeds 32 bits`);
      fields.push(Object.freeze({ name: match[1], width, shift: remaining }));
    }
  }
  if (remaining !== 0 || mask === 0) throw new Error(`${name}: encoding must total 32 bits with fixed selector bits`);
  if (!Array.isArray(input.operands) || input.operands.length > 8) throw new Error(`${name}: invalid operands`);
  const consumed = new Set<string>();
  const requireField = (field: string, register = false): void => {
    const found = fields.find(item => item.name === field);
    if (!found || (register && found.width !== 5) || consumed.has(field)) throw new Error(`${name}: invalid or repeated operand field ${field}`);
    consumed.add(field);
  };
  for (const operand of input.operands) {
    if (!operand || typeof operand !== 'object') throw new Error(`${name}: invalid operand`);
    if (operand.kind === 'register') requireField(operand.field, true);
    else if (operand.kind === 'immediate') {
      requireField(operand.field);
      if (operand.relocation !== undefined && !['branch', 'jump'].includes(operand.relocation)) throw new Error(`${name}: invalid relocation`);
    } else if (operand.kind === 'memory') { requireField(operand.baseField, true); requireField(operand.offsetField); }
    else throw new Error(`${name}: invalid operand kind`);
  }
  if (consumed.size !== fields.length) throw new Error(`${name}: every variable encoding field must have an operand`);
  if (input.controlFlow !== undefined && typeof input.controlFlow !== 'boolean') throw new Error(`${name}: controlFlow must be boolean`);
  if (input.override !== undefined && typeof input.override !== 'boolean') throw new Error(`${name}: override must be boolean`);
  validateCustomMetadata(input, fields);
  // Copy metadata through JSON to reject functions/cycles and detach module-owned mutable objects.
  const { execute, ...rawMetadata } = input;
  const metadata = JSON.parse(JSON.stringify(rawMetadata, (_key, item: unknown) => {
    if (typeof item === 'function' || typeof item === 'bigint' || (typeof item === 'number' && !Number.isFinite(item))) throw new Error(`${name}: metadata must be JSON data`);
    return item;
  })) as CustomInstructionMetadata;
  deepFreeze(metadata);
  const definition = Object.freeze({ ...metadata, execute });
  return Object.freeze({ definition, metadata, mask, value, fields: Object.freeze(fields) });
}
function deepFreeze(value: unknown): void {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
}
