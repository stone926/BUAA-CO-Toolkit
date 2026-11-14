// @index mips-core — Shared synchronous custom effect validation for execution and generation
import { architectureExceptionCodes } from '../profiles/profile';
import type { CustomInstructionEffect, CustomInstructionMetadata } from './api';

export function validateCustomInstructionEffect(value: unknown, definition?: CustomInstructionMetadata): asserts value is CustomInstructionEffect {
  const object = (item: unknown, label: string): Record<string, unknown> => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label} must be an object`);
    return item as Record<string, unknown>;
  };
  const integer = (item: unknown, label: string, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): void => {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < min || item > max) throw new Error(`${label} must be an integer in ${min}..${max}`);
  };
  const address = (item: unknown): void => integer(item, 'address', -0x80000000, 0xffffffff);
  const width = (item: unknown): void => { if (item !== 1 && item !== 2 && item !== 4) throw new Error('Memory width must be 1, 2 or 4'); };
  const optionalBoolean = (item: unknown, label: string): void => { if (item !== undefined && typeof item !== 'boolean') throw new Error(`${label} must be boolean`); };
  const effect = object(value, 'execute result');
  if ('then' in effect) throw new Error('execute must return a synchronous effect object');
  for (const key of Object.keys(effect)) if (!['gprWrites', 'hiLoWrites', 'store', 'control', 'trap'].includes(key)) throw new Error(`Unknown effect property ${key}`);
  for (const [key, maximum] of [['gprWrites', 32], ['hiLoWrites', 2]] as const) {
    const writes = effect[key]; if (writes === undefined) continue;
    if (!Array.isArray(writes) || writes.length > maximum) throw new Error(`${key} must be an array of at most ${maximum} writes`);
    const destinations = new Set<unknown>();
    for (const item of writes) {
      const write = object(item, key);
      if (key === 'gprWrites') integer(write.register, 'GPR index', 0, 31);
      else if (write.register !== 'hi' && write.register !== 'lo') throw new Error('Invalid HI/LO destination');
      integer(write.value, `${key} value`);
      if (destinations.has(write.register)) throw new Error(`Duplicate ${key} destination`);
      destinations.add(write.register);
    }
  }
  if (effect.store !== undefined) {
    const store = object(effect.store, 'store'); address(store.address); width(store.width); integer(store.value, 'store value'); optionalBoolean(store.addressOverflow, 'store.addressOverflow');
  }
  if (effect.control !== undefined) {
    const control = object(effect.control, 'control'); address(control.target);
    if (typeof control.taken !== 'boolean') throw new Error('control.taken must be boolean');
    optionalBoolean(control.annulDelaySlot, 'control.annulDelaySlot');
    if (definition && !definition.controlFlow) throw new Error('Control effect requires declared controlFlow');
  }
  if (effect.trap !== undefined) {
    const trap = object(effect.trap, 'trap');
    if (typeof trap.name !== 'string' || !Object.prototype.hasOwnProperty.call(architectureExceptionCodes, trap.name)) throw new Error('Invalid architectural trap name');
    if (trap.message !== undefined && typeof trap.message !== 'string') throw new Error('Trap message must be a string');
  }
  if (definition?.controlFlow && effect.control === undefined && effect.trap === undefined) throw new Error('Declared control flow requires a control or trap effect');
}
