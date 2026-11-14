// @index mips-host — Repeatability guard for trusted script callbacks with recorded architectural reads
import type { CustomInstructionContext, CustomInstructionDefinition, CustomInstructionEffect } from '../core/custom/api';
import { validateCustomInstructionEffect } from '../core/custom/effects';
import { canonicalJson, type CanonicalJson } from '../core/canonicalJson';

type ReadMethod = 'readGpr' | 'readHi' | 'readLo' | 'load';
interface RecordedRead { readonly method: ReadMethod; readonly args: readonly unknown[]; readonly value?: number; readonly error?: unknown; readonly threw: boolean }

/**
 * Repeatability is a contract check, not a proof of arbitrary JavaScript purity.
 * Both evaluations see the same frozen input; only the first can prepare memory
 * or MMIO. The detached first effect prevents a shared result object from hiding
 * mutation during the second evaluation.
 */
export function guardScriptInstructionDefinition(definition: CustomInstructionDefinition): CustomInstructionDefinition {
  const authorExecute = definition.execute;
  const invalid = (detail: string): Error => new Error(`${definition.mnemonic}: execute 必须仅依赖context/fields且无持久可变状态（${detail}）`);
  return { ...definition, execute(context, fields) {
    const reads: RecordedRead[] = [];
    let phase: 'first' | 'second' | 'finished' = 'first';
    let cursor = 0;
    const read = (method: ReadMethod, args: readonly unknown[]): number => {
      if (phase === 'finished') throw invalid('回调返回后不能继续读取context');
      if (args.some(argument => argument !== undefined && typeof argument !== 'number' && typeof argument !== 'boolean')) throw invalid('context访问参数必须是数值或布尔值');
      if (phase === 'second') {
        const recorded = reads[cursor++];
        if (!recorded || recorded.method !== method || recorded.args.length !== args.length || recorded.args.some((argument, index) => !Object.is(argument, args[index]))) {
          throw invalid('相同输入产生了不同的context访问顺序或参数');
        }
        if (recorded.threw) throw recorded.error;
        return recorded.value!;
      }
      try {
        const value = Reflect.apply(context[method], context, args) as number;
        reads.push({ method, args: [...args], value, threw: false });
        return value;
      } catch (error) {
        reads.push({ method, args: [...args], error, threw: true });
        throw error;
      }
    };
    const input: CustomInstructionContext = Object.freeze({
      pc: context.pc, delaySlot: context.delaySlot, linkAddress: context.linkAddress,
      readGpr: (register: number) => read('readGpr', [register]),
      readHi: () => read('readHi', []), readLo: () => read('readLo', []),
      load: (address: number, width: 1 | 2 | 4, signed?: boolean, addressOverflow?: boolean) => read('load', [address, width, signed, addressOverflow])
    });
    const inputFields = Object.freeze({ ...fields });
    const evaluate = (): CustomInstructionEffect => {
      const effect = Reflect.apply(authorExecute, definition, [input, inputFields]) as CustomInstructionEffect;
      try {
        validateCustomInstructionEffect(effect, definition);
        const detached = detachEffect(effect);
        validateCustomInstructionEffect(detached, definition);
        return detached;
      } catch (error) { throw invalid(`必须同步返回有效effect: ${error instanceof Error ? error.message : String(error)}`); }
    };
    try {
      const first = evaluate();
      const expected = canonicalJson(first as unknown as CanonicalJson);
      phase = 'second';
      const second = evaluate();
      if (cursor !== reads.length || canonicalJson(second as unknown as CanonicalJson) !== expected) throw invalid('相同输入产生了不同的effect或context访问');
      return first;
    } finally { phase = 'finished'; }
  } };
}

/** Copy only schema fields without invoking JSON hooks from the author's realm. */
function detachEffect(effect: CustomInstructionEffect): CustomInstructionEffect {
  const writes = effect.gprWrites?.map(write => Object.freeze({ register: write.register, value: write.value }));
  const hiLo = effect.hiLoWrites?.map(write => Object.freeze({ register: write.register, value: write.value }));
  const store = effect.store;
  const control = effect.control;
  const trap = effect.trap;
  return Object.freeze({
    ...(writes ? { gprWrites: Object.freeze(writes) } : {}),
    ...(hiLo ? { hiLoWrites: Object.freeze(hiLo) } : {}),
    ...(store ? { store: Object.freeze({ address: store.address, width: store.width, value: store.value,
      ...(store.addressOverflow === undefined ? {} : { addressOverflow: store.addressOverflow }) }) } : {}),
    ...(control ? { control: Object.freeze({ target: control.target, taken: control.taken,
      ...(control.annulDelaySlot === undefined ? {} : { annulDelaySlot: control.annulDelaySlot }) }) } : {}),
    ...(trap ? { trap: Object.freeze({ name: trap.name, ...(trap.message === undefined ? {} : { message: trap.message }) }) } : {})
  });
}
