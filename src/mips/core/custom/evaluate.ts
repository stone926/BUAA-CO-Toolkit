// @index mips-core — Declarative custom effects normalized into atomic architectural transitions
import { executionDiagnostic } from '../events/commitEvent';
import { controlTransferTargets, InstructionEffect, TransitionContext, withFault } from '../machine/transition';
import { MemoryFault, PreparedMemoryAccess } from '../machine/memoryBus';
import { u32 } from '../values';
import { CustomInstructionContext, CustomInstructionDefinition, CustomInstructionEffect } from './api';
import { validateCustomInstructionEffect } from './effects';

export function evaluateCustomInstruction(context: TransitionContext, base: InstructionEffect & { readonly word: number }, definition: CustomInstructionDefinition, fields: Readonly<Record<string, number>>): InstructionEffect {
  const decoded = { ...base, mnemonic: definition.mnemonic };
  const failure = (message: string): InstructionEffect => ({ ...decoded, ...(prepared?.device ? { deviceAccess: prepared.device } : {}), outOfDomain: executionDiagnostic('unsupported-instruction', `${definition.mnemonic}: ${message}`, { pc: base.pcBefore, instructionWord: base.word }) });
  if (base.delaySlot && context.profile.delaySlot && definition.controlFlow) return { ...decoded, outOfDomain: executionDiagnostic('double-delay-slot', `${definition.mnemonic} executes control flow in a delay slot`, { pc: base.pcBefore, instructionWord: base.word }) };
  let prepared: PreparedMemoryAccess | undefined;
  let fault: MemoryFault | undefined;
  let accesses = 0;
  let load: InstructionEffect['load'];
  const integer = (value: number, label: string): number => {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a finite safe integer`);
    return value;
  };
  const register = (value: number): number => {
    integer(value, 'register'); if (value < 0 || value > 31) throw new Error('GPR index must be in 0..31'); return value;
  };
  const addressValue = (value: number): number => { integer(value, 'address'); if (value < -0x80000000 || value > 0xffffffff) throw new Error('address must be a 32-bit integer'); return u32(value); };
  const widthValue = (value: number): 1 | 2 | 4 => { if (value !== 1 && value !== 2 && value !== 4) throw new Error('memory width must be 1, 2 or 4'); return value; };
  const sdk: CustomInstructionContext = Object.freeze({
    pc: base.pcBefore, delaySlot: base.delaySlot, linkAddress: u32(base.pcBefore + context.profile.linkOffset),
    readGpr: (index: number) => context.state.gpr.read(register(index)),
    readHi: () => { if (!context.state.hiDefined && context.undefinedBehavior === 'fail-closed') throw new Error('HI is undefined'); return context.state.hi; },
    readLo: () => { if (!context.state.loDefined && context.undefinedBehavior === 'fail-closed') throw new Error('LO is undefined'); return context.state.lo; },
    load(address: number, width: 1 | 2 | 4, signed = false, addressOverflow = false): number {
      if (typeof signed !== 'boolean' || typeof addressOverflow !== 'boolean') throw new Error('Load signed/overflow flags must be boolean');
      if (++accesses !== 1) throw new Error('At most one architectural memory access is permitted');
      const result = context.memory.prepare({ kind: 'load', address: addressValue(address), width: widthValue(width), addressOverflow });
      if ('reason' in result) { fault = result; return 0; }
      prepared = result;
      const value = context.memory.read(result, signed);
      load = { prepared: result, wordValue: context.memory.readWord(result), value };
      return value;
    }
  });
  try {
    const effect: CustomInstructionEffect = definition.execute(sdk, fields);
    validateCustomInstructionEffect(effect, definition);
    const gprWrites = (effect.gprWrites ?? []).map(write => ({ register: write.register, value: u32(write.value) }));
    const hiLoWrites = (effect.hiLoWrites ?? []).map(write => ({ register: write.register, value: u32(write.value) }));
    let result: InstructionEffect = { ...decoded, gprWrites, hiLoWrites };
    if (effect.control) {
      const target = addressValue(effect.control.target);
      result = { ...result, controlTransfer: true, ...controlTransferTargets(context.profile, base.pcBefore, u32(base.pcBefore + 4), target, effect.control.taken) };
      if (effect.control.annulDelaySlot && !effect.control.taken && context.profile.delaySlot) result = { ...result, nextPc: u32(base.pcBefore + 8), pendingBranch: undefined };
    }
    if (effect.trap) {
      if (!context.profile.exceptions) return failure(`Architectural trap ${effect.trap.name} is unavailable in this profile`);
      return { ...decoded, ...(prepared?.device ? { deviceAccess: prepared.device } : {}), exception: { name: effect.trap.name, stage: 'execute', message: effect.trap.message ?? `${definition.mnemonic} raised ${effect.trap.name}` } };
    }
    if (effect.store) {
      if (++accesses !== 1) throw new Error('At most one architectural memory access is permitted');
      const store = effect.store;
      const rawValue = u32(integer(store.value, 'store value'));
      const access = context.memory.prepare({ kind: 'store', address: addressValue(store.address), width: widthValue(store.width), value: rawValue, addressOverflow: store.addressOverflow });
      if ('reason' in access) fault = access;
      else { prepared = access; result = { ...result, store: { prepared: access, rawValue, ...context.memory.storePreview(access, rawValue) } }; }
    }
    if (prepared?.device) result = { ...result, deviceAccess: prepared.device };
    if (fault) return withFault(result, context.profile, fault, fault.direction, fault.address);
    return { ...result, ...(load ? { load } : {}) };
  } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
}
