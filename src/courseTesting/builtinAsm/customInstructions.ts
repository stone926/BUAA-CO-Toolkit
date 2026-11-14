// @index custom-generator — Script instruction operands, pure semantic preview and precise generator-state effects
import type { CustomInstructionDefinition, CustomInstructionEffect } from '../../mips/core/custom/api';
import { validateCustomInstructionEffect } from '../../mips/core/custom/effects';
import type { HazardInstruction } from '../../hazardAnalysis/hazardInstruction';
import type { HazardObservationValues } from '../../hazardAnalysis/hazardPipeline';
import { CpuState, courseDataByteLength } from '../cpuState';
import { Random } from '../random';
import type { OperandSteer } from './hazard/operandSteer';

export interface CustomEmission {
  readonly text: string;
  readonly effect: CustomInstructionEffect;
  readonly hazard: HazardInstruction | undefined;
  /** Invoke before committing this effect, while CpuState still describes the real inputs. */
  readonly assess: NonNullable<HazardObservationValues['assess']>;
}
class RejectedCustomOperand extends Error {}

/** A rejected candidate cannot mutate CpuState: execute only sees this read-only adapter. */
export function previewCustomInstruction(
  definition: CustomInstructionDefinition, state: CpuState, rng: Random, pc: number,
  delaySlots: boolean, targetLabel: string, steer?: OperandSteer, fixedFields?: Readonly<Record<string, number>>
): CustomEmission | undefined {
  if (!definition.generation) return undefined;
  const widths = encodingFieldWidths(definition.encoding);
  const registerFields = new Set(definition.operands.flatMap((operand) => operand.kind === 'register'
    ? [operand.field] : operand.kind === 'memory' ? [operand.baseField] : []));
  const signedFields = new Set(definition.operands.flatMap((operand) => operand.kind === 'immediate' && operand.signed
    ? [operand.field] : operand.kind === 'memory' && operand.signed !== false ? [operand.offsetField] : []));
  const targetOperand = definition.operands.find((operand) => operand.kind === 'immediate' && operand.relocation);
  const targetField = definition.generation.control?.targetField
    ?? (targetOperand?.kind === 'immediate' ? targetOperand.field : undefined);
  if (definition.controlFlow && !targetField) return undefined;
  const target = pc + (delaySlots ? 12 : 8);
  const reads = definition.access?.reads ?? [];
  const writes = definition.access?.writes ?? [];
  for (let attempt = 0; attempt < 64; attempt++) {
    const fields: Record<string, number> = {};
    for (const [field, width] of widths) {
      const constraint = definition.generation.fields?.[field];
      if (registerFields.has(field)) {
        const role = definition.timing?.reads?.find((read) => read.field === field)?.role;
        const bound = role ? steer?.reads?.[role] : undefined;
        const isWrite = writes.includes(field) && !reads.includes(field);
        const candidates = Array.from({ length: isWrite ? 25 : 26 }, (_, index) => isWrite ? index + 1 : index)
          .filter((index) => (constraint?.min === undefined || index >= constraint.min) && (constraint?.max === undefined || index <= constraint.max)
            && (!constraint?.values?.length || constraint.values.includes(index)))
          .filter((index) => !isWrite || !steer?.avoidWrites?.has(`$${index}`))
          .filter((index) => {
            if (!constraint?.address) return true;
            const value = state.regValue(`$${index}`) >>> 0;
            return value % (constraint.address.alignment ?? constraint.address.width ?? 4) === 0
              && value + (constraint.address.width ?? 4) <= courseDataByteLength;
          });
        const preferred = fixedFields?.[field] !== undefined ? `$${fixedFields[field]}` : bound ?? (isWrite ? steer?.write : undefined);
        if (preferred && !candidates.includes(Number(preferred.slice(1)))) continue;
        const recent = state.recentWrites.filter((register) => candidates.includes(Number(register.slice(1))));
        if (!candidates.length) continue;
        fields[field] = preferred ? Number(preferred.slice(1))
          : reads.includes(field) && recent.length && rng.chance(0.7)
            ? Number(rng.pick(recent).slice(1)) : rng.pick(candidates);
      } else {
        const signed = signedFields.has(field);
        const minimum = constraint?.min ?? (signed ? -Math.pow(2, width - 1) : 0);
        const maximum = constraint?.max ?? Math.min(signed ? Math.pow(2, width - 1) - 1 : Math.pow(2, width) - 1, 0xffff);
        fields[field] = constraint?.values?.length ? rng.pick([...constraint.values])
          : steer?.immediate !== undefined ? steer.immediate : rng.int(minimum, maximum);
      }
    }
    if (Object.keys(fields).length !== widths.size) continue;
    for (const operand of definition.operands) {
      if (operand.kind !== 'memory') continue;
      const base = state.regValue(`$${fields[operand.baseField]}`);
      const width = definition.access?.width ?? 4;
      const address = steer?.address ?? rng.int(0, Math.floor((courseDataByteLength - width) / width)) * width;
      const offset = address - base;
      const bits = widths.get(operand.offsetField) ?? 16;
      const minimum = operand.signed !== false ? -Math.pow(2, bits - 1) : 0;
      const maximum = operand.signed !== false ? Math.pow(2, bits - 1) - 1 : Math.pow(2, bits) - 1;
      fields[operand.offsetField] = offset >= minimum && offset <= maximum ? offset : Number.NaN;
    }
    if (targetField) {
      const operand = definition.operands.find((entry) => entry.kind === 'immediate' && entry.field === targetField);
      const relocation = definition.generation.control?.relocation ?? (operand?.kind === 'immediate' ? operand.relocation : undefined);
      const shiftBy = definition.generation.control?.shiftBy;
      const scale = shiftBy ? Math.pow(2, state.regValue(`$${fields[shiftBy.field]}`) & shiftBy.mask) : 1;
      fields[targetField] = relocation === 'branch' ? (target - pc - 4) / (4 * scale) : relocation === 'jump' ? target >>> 2 : target;
    }
    if (Object.values(fields).some((value) => !Number.isInteger(value))) continue;
    try {
      const rawFields = Object.freeze(Object.fromEntries([...widths].map(([field, width]) => [field, fields[field] & (Math.pow(2, width) - 1)])));
      let accesses = 0;
      const context = Object.freeze({
        pc, delaySlot: false, linkAddress: pc + (delaySlots ? 8 : 4),
        readGpr: (index: number) => {
          if (!Number.isInteger(index) || index < 0 || index > 31) throw new Error('GPR index must be in 0..31');
          return state.regValue(`$${index}`) >>> 0;
        },
        readHi: () => { if (!state.hiInitialized) throw new RejectedCustomOperand('Uninitialized HI'); return state.hi >>> 0; },
        readLo: () => { if (!state.loInitialized) throw new RejectedCustomOperand('Uninitialized LO'); return state.lo >>> 0; },
        load: (address: number, width: 1 | 2 | 4, signed = false, overflow = false) => {
          if (++accesses > 1) throw new Error('Only one memory access is supported');
          assertLegalAddress(address, width, overflow);
          const value = width === 1 ? state.byteAt(address) : width === 2 ? state.halfAt(address) : state.wordAt(address);
          return (signed && width === 1 ? (value << 24) >> 24 : signed && width === 2 ? (value << 16) >> 16 : value) >>> 0;
        }
      });
      const effect = definition.execute(context, rawFields);
      validateCustomInstructionEffect(effect, definition);
      if (effect.trap) continue;
      if (effect.store) {
        if (++accesses > 1) continue;
        assertLegalAddress(effect.store.address, effect.store.width, effect.store.addressOverflow);
      }
      if (effect.control && (!definition.controlFlow || effect.control.target !== target)) continue;
      if (definition.controlFlow && !effect.control) continue;
      const write = effect.gprWrites?.[0];
      if (steer?.write && (!write || `$${write.register}` !== steer.write)) continue;
      if (steer?.accept && (!write || !steer.accept(write.value, `$${write.register}`))) continue;
      const assemblyField = (field: string): number => {
        const width = widths.get(field)!;
        const raw = rawFields[field];
        return signedFields.has(field) && raw >= Math.pow(2, width - 1) ? raw - Math.pow(2, width) : raw;
      };
      const operands = definition.operands.map((operand) => operand.kind === 'register' ? `$${fields[operand.field]}`
        : operand.kind === 'memory' ? `${assemblyField(operand.offsetField)}($${fields[operand.baseField]})`
          : operand.field === targetField && operand.relocation ? definition.generation?.control?.shiftBy
            ? String(operand.relocation === 'branch' ? assemblyField(operand.field) : rawFields[operand.field] * 4) : targetLabel
            : String(assemblyField(operand.field)));
      return { text: `${definition.mnemonic}${operands.length ? ' ' + operands.join(', ') : ''}`, effect,
        hazard: customHazardFacts(definition, fields, effect), assess: (alternative) => {
          const field = definition.timing?.reads?.find((read) => read.role === alternative.role)?.field;
          if (!field && !alternative.half) return 'unknown';
          if (field && definition.timing?.reads?.some((read) => read.role !== alternative.role && rawFields[read.field] === rawFields[field])) return 'unknown';
          try {
            accesses = 0;
            const changed = definition.execute(Object.freeze({ ...context,
              readGpr: (index: number) => field && index === rawFields[field] ? alternative.value >>> 0 : context.readGpr(index),
              readHi: () => alternative.half === 'hi' ? alternative.value >>> 0 : context.readHi(),
              readLo: () => alternative.half === 'lo' ? alternative.value >>> 0 : context.readLo()
            }), rawFields);
            validateCustomInstructionEffect(changed, definition);
            if (changed.store) assertLegalAddress(changed.store.address, changed.store.width, changed.store.addressOverflow);
            return effectIdentity(changed) === effectIdentity(effect) ? 'masked' : 'observable';
          } catch (error) { return error instanceof RejectedCustomOperand ? 'observable' : 'unknown'; }
        } };
    } catch (error) {
      // Legal operand failures reject this draw; broken callback code remains actionable.
      if (!(error instanceof RejectedCustomOperand)) throw new Error(`${definition.mnemonic}: custom generation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return undefined;
}

function effectIdentity(effect: CustomInstructionEffect): string {
  return JSON.stringify({ gprWrites: (effect.gprWrites ?? []).filter((write) => write.register !== 0).map((write) => [write.register, write.value | 0]),
    hiLoWrites: (effect.hiLoWrites ?? []).map((write) => [write.register, write.value | 0]),
    store: effect.store ? [effect.store.address >>> 0, effect.store.width,
      effect.store.value & (effect.store.width === 1 ? 0xff : effect.store.width === 2 ? 0xffff : -1)] : undefined,
    control: effect.control ? [effect.control.taken, effect.control.taken ? effect.control.target >>> 0 : undefined,
      !effect.control.taken && effect.control.annulDelaySlot === true] : undefined,
    trap: effect.trap?.name });
}

export function applyCustomEffect(state: CpuState, effect: CustomInstructionEffect): void {
  for (const write of effect.gprWrites ?? []) state.setRegister(`$${write.register}`, write.value);
  for (const write of effect.hiLoWrites ?? []) {
    state[write.register] = write.value | 0;
    if (write.register === 'hi') state.hiInitialized = true;
    else state.loInitialized = true;
  }
  if (effect.store) {
    for (let index = 0; index < effect.store.width; index++) state.writeByte(effect.store.address + index, effect.store.value >>> (index * 8));
  }
}

function assertLegalAddress(address: number, width: number, overflow = false): void {
  if (overflow || !Number.isInteger(address) || address < 0 || address + width > courseDataByteLength || address % width !== 0) {
    throw new RejectedCustomOperand('Custom generation address must be aligned inside course DM.');
  }
}

function encodingFieldWidths(encoding: string): Map<string, number> {
  return new Map(encoding.trim().split(/\s+/).flatMap((segment) => {
    const match = /^([a-zA-Z_]\w*):(\d+)$/.exec(segment);
    return match ? [[match[1], Number(match[2])] as const] : [];
  }));
}

function customHazardFacts(definition: CustomInstructionDefinition, fields: Record<string, number>, effect: CustomInstructionEffect): HazardInstruction | undefined {
  const timing = definition.timing;
  if (!timing?.hazardClass || (effect.gprWrites?.length ?? 0) > 1 || (effect.gprWrites?.length && !timing.readyStage)) return undefined;
  const write = effect.gprWrites?.[0];
  return { mnemonic: definition.mnemonic, hazardClass: timing.hazardClass,
    reads: (timing.reads ?? []).map((read) => ({ register: `$${fields[read.field]}`, role: read.role, useStage: read.useStage })),
    write: write && timing.readyStage ? { register: `$${write.register}`, readyStage: timing.readyStage } : undefined,
    hiLoReads: (definition.access?.reads ?? []).filter((field): field is 'hi' | 'lo' => field === 'hi' || field === 'lo'),
    hiLoWrites: (effect.hiLoWrites ?? []).map((entry) => entry.register), usesMdu: false, mduBusyCycles: 0 };
}
