import { describe, expect, it, vi } from 'vitest';
import type { CustomInstructionContext, CustomInstructionDefinition } from '../../mips/core/custom/api';
import { guardScriptInstructionDefinition } from '../../mips/host/scriptInstructionDeterminism';

function definition(execute: CustomInstructionDefinition['execute']): CustomInstructionDefinition {
  return { apiVersion: 1, mnemonic: 'guarded', modes: ['P6'], encoding: '011111 rs:5 rt:5 immediate:16', operands: [], execute };
}
function context(): CustomInstructionContext {
  return { pc: 0x3000, delaySlot: false, linkAddress: 0x3008, readGpr: vi.fn(index => index * 4), readHi: vi.fn(() => 1), readLo: vi.fn(() => 2), load: vi.fn(() => 0x12345678) };
}
describe('script callback repeatability contract', () => {
  it('rejects a closure counter before returning any effect for a machine or generator to commit', () => {
    let counter = 0;
    const guarded = guardScriptInstructionDefinition(definition(() => ({ gprWrites: [{ register: 3, value: counter++ }] })));
    expect(() => guarded.execute(context(), {})).toThrow('execute 必须仅依赖context/fields且无持久可变状态');
  });
  it('preserves the immutable definition receiver for deterministic metadata reads', () => {
    const original = definition(function (this: CustomInstructionDefinition, _ctx, fields) { return { gprWrites: [{ register: fields.rt, value: this.mnemonic.length }] }; });
    const guarded = guardScriptInstructionDefinition(Object.freeze(original));
    expect(guarded.execute(context(), { rt: 3 })).toEqual({ gprWrites: [{ register: 3, value: 7 }] });
  });
  it('prepares memory once and replays all architectural reads during the second evaluation', () => {
    const input = context();
    const guarded = guardScriptInstructionDefinition(definition((ctx, fields) => ({ gprWrites: [{ register: fields.rt, value: ctx.load(ctx.readGpr(fields.rs), 4) + ctx.readHi() + ctx.readLo() }] })));
    expect(guarded.execute(input, { rs: 2, rt: 3 })).toEqual({ gprWrites: [{ register: 3, value: 0x1234567b }] });
    expect(input.load).toHaveBeenCalledTimes(1);
    expect(input.readGpr).toHaveBeenCalledTimes(1);
    expect(input.readHi).toHaveBeenCalledTimes(1);
    expect(input.readLo).toHaveBeenCalledTimes(1);
  });
  it('detects access sequence changes without performing a second MMIO preparation', () => {
    let counter = 0;
    const input = context();
    const guarded = guardScriptInstructionDefinition(definition(ctx => ({ gprWrites: [{ register: 3, value: ctx.load(counter++ * 4, 4) }] })));
    expect(() => guarded.execute(input, {})).toThrow('不同的context访问');
    expect(input.load).toHaveBeenCalledTimes(1);
  });
  it('detaches the first result before a reused object can mutate it on the second call', () => {
    const shared = { gprWrites: [{ register: 3, value: 1 }] };
    let calls = 0;
    const guarded = guardScriptInstructionDefinition(definition(() => { if (calls++) shared.gprWrites[0].value = 2; return shared; }));
    expect(() => guarded.execute(context(), {})).toThrow('不同的effect');
  });
  it.each([
    ['async', async () => ({})],
    ['nonfinite', () => ({ gprWrites: [{ register: 3, value: Number.NaN }] })],
    ['unregistered', () => ({ unexpected: true })]
  ])('rejects %s effects with the shared core schema', (_name, execute) => {
    const guarded = guardScriptInstructionDefinition(definition(execute as unknown as CustomInstructionDefinition['execute']));
    expect(() => guarded.execute(context(), {})).toThrow('必须同步返回有效effect');
  });
});
