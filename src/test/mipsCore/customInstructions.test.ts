import { describe, expect, it, vi } from 'vitest';
import type { DeviceBusPort } from '../../mips/core/devices/deviceBus';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { assembleMarsSource } from '../../mips/core/assembler/marsAssembler';
import type { CustomInstructionDefinition } from '../../mips/core/custom/api';
import { addSigned32, oneExtend, signExtend } from '../../mips/core/custom/bits';
import { CustomInstructionRegistry, createCustomInstructionMetadataRegistry } from '../../mips/core/custom/registry';
import { validateCustomInstructionEffect } from '../../mips/core/custom/effects';
import { disassembleDebugInstruction } from '../../mips/core/debug/disassembly';
import { MachineSession } from '../../mips/core/machine/session';
import { resolveCourseProfile } from '../../mips/core/profiles/courseProfiles';
import { createMarsProfile } from '../../mips/core/mars/profile';
import { textImage, op } from './programFixtures';

// Independent transcriptions of the 2022 P5 exercise statements in cscore/加指令练习.
const addei: CustomInstructionDefinition = {
  apiVersion: 1, mnemonic: 'addei', aliases: ['addei_alias'], modes: ['P3', 'P4', 'P5', 'P6', 'P7', 'mars'],
  encoding: '110011 rs:5 rt:5 immediate:16',
  operands: [{ kind: 'register', field: 'rt' }, { kind: 'register', field: 'rs' }, { kind: 'immediate', field: 'immediate' }],
  execute(ctx, fields) {
    const extended = oneExtend(fields.immediate, 16);
    const sum = addSigned32(ctx.readGpr(fields.rs), extended);
    return { gprWrites: [{ register: fields.rt, value: sum.overflow ? extended : sum.result }] };
  }
};
const lhogez: CustomInstructionDefinition = {
  apiVersion: 1, mnemonic: 'lhogez', modes: ['P5', 'P7'], encoding: '110011 base:5 rt:5 offset:16',
  operands: [{ kind: 'register', field: 'rt' }, { kind: 'memory', baseField: 'base', offsetField: 'offset', signed: true }],
  execute(ctx, fields) {
    const value = ctx.load(ctx.readGpr(fields.base) + signExtend(fields.offset, 16), 2, true);
    let ones = 0; for (let bit = 0; bit < 16; bit++) ones += (value >>> bit) & 1;
    return { gprWrites: [{ register: ones >= 8 ? fields.rt : 31, value: ones >= 8 ? value : ctx.pc + 4 }] };
  }
};
const blztal: CustomInstructionDefinition = {
  apiVersion: 1, mnemonic: 'blztal', modes: ['P5', 'P7'], encoding: '100111 rs:5 rt:5 offset:16', controlFlow: true,
  operands: [{ kind: 'register', field: 'rs' }, { kind: 'register', field: 'rt' }, { kind: 'immediate', field: 'offset', signed: true }],
  execute(ctx, fields) {
    const taken = (ctx.readGpr(fields.rs) | 0) < 0;
    return { control: { target: ctx.pc + 4 + signExtend(fields.offset, 16) * 2 ** (2 + (ctx.readGpr(fields.rt) & 3)), taken },
      gprWrites: taken ? [{ register: 31, value: ctx.pc + 8 }] : [] };
  }
};
const bonall: CustomInstructionDefinition = {
  apiVersion: 1, mnemonic: 'bonall', modes: ['P5', 'P7'], encoding: '011001 rs:5 rt:5 offset:16', controlFlow: true,
  operands: [{ kind: 'register', field: 'rs' }, { kind: 'register', field: 'rt' }, { kind: 'immediate', field: 'offset', signed: true, relocation: 'branch' }],
  execute(ctx, fields) {
    const taken = (ctx.readGpr(fields.rs) | 0) + (ctx.readGpr(fields.rt) | 0) === 0;
    return { control: { target: ctx.pc + 4 + signExtend(fields.offset, 16) * 4, taken, annulDelaySlot: true }, gprWrites: [{ register: 31, value: ctx.pc + 8 }] };
  }
};
function session(definition: CustomInstructionDefinition, fields: Record<string, number>, profile: 'P3' | 'P5' | 'P7' = 'P5', dataWords?: number[]) {
  const registry = new CustomInstructionRegistry([definition]);
  return new MachineSession({ profile: resolveCourseProfile(profile), image: textImage([registry.encode(definition.mnemonic, fields, profile), op('nop'), op('nop'), op('nop'), op('nop')], { dataWords }), customInstructions: registry });
}

describe('custom instruction registry and assembly', () => {
  it('pins course encoding, alias semantics, modes and metadata immutability', () => {
    const registry = new CustomInstructionRegistry([addei]);
    expect(registry.encode('addei', { rs: 1, rt: 3, immediate: 2 }, 'P5')).toBe(0xcc230002);
    expect(registry.encode('addei_alias', { rs: 1, rt: 3, immediate: 2 }, 'P5')).toBe(0xcc230002);
    expect(registry.decode(0xcc230002, 'P5')?.fields).toEqual({ rs: 1, rt: 3, immediate: 2 });
    expect(registry.encodings('P5')).toEqual([{ mnemonic: 'addei', mask: 0xfc000000, value: 0xcc000000, template: 'addei $rt, $rs, immediate' }]);
    expect(Object.isFrozen(registry.metadata()[0].operands)).toBe(true);
    expect(JSON.stringify(registry.metadata())).not.toContain('execute');
  });
  it('rejects native and ambiguous collisions, even between different semantic callbacks', () => {
    expect(() => new CustomInstructionRegistry([{ ...addei, mnemonic: 'addu' }])).toThrow(/native/);
    expect(() => new CustomInstructionRegistry([{ ...addei, encoding: '001101 rs:5 rt:5 immediate:16' }])).toThrow(/overlaps native ori/);
    expect(() => new CustomInstructionRegistry([addei, lhogez])).toThrow(/Ambiguous/);
    expect(() => new CustomInstructionRegistry([{ ...addei, encoding: '110011 rs:5 rt:5 immediate:15' }])).toThrow(/32 bits/);
    expect(() => new CustomInstructionRegistry([{ ...addei, modes: ['mars'], encoding: '110001 rs:5 rt:5 immediate:16' }])).toThrow(/MARS lwc1/);
  });
  it('validates generation/timing metadata before entering runtime or generator', () => {
    expect(() => new CustomInstructionRegistry([{ ...addei, generation: { fields: { missing: { min: 0 } } } }])).toThrow(/Unknown field/);
    expect(() => new CustomInstructionRegistry([{ ...addei, generation: { cases: [{ registerValues: { immediate: 1 } }] } }])).toThrow(/GPR field/);
    expect(() => new CustomInstructionRegistry([{ ...addei, timing: { reads: [{ field: 'immediate', role: 'rs', useStage: 'E' }] } }])).toThrow(/GPR field/);
    expect(() => validateCustomInstructionEffect({ gprWrites: [{ register: 1, value: 3 }, { register: 1, value: 4 }] })).toThrow(/Duplicate/);
    expect(() => validateCustomInstructionEffect(Promise.resolve({}))).toThrow(/synchronous/);
  });
  it('reuses metadata-only registries for custom disassembly without executing callbacks', () => {
    const registry = createCustomInstructionMetadataRegistry(new CustomInstructionRegistry([bonall]).metadata());
    expect(disassembleDebugInstruction(0x6422ffff, 0x3000, { kind: 'course', profile: 'P5' }, registry)).toBe('bonall $at, $v0, -1');
    expect(() => registry.get('bonall', 'P5')!.execute({} as never, {})).toThrow(/metadata-only/);
  });
  it('assembles expressions, memory operands and forward branch relocations with useful errors', () => {
    const registry = new CustomInstructionRegistry([bonall]);
    const result = assembleCourseSource({ id: 'custom.asm', text: '.text\nbonall $1,$2,end\nnop\nend:nop' }, { profile: 'P5', customInstructions: registry });
    expect(result.diagnostics).toEqual([]);
    expect(result.image?.segments[0].words[0]).toBe(0x64220001);
    expect(assembleCourseSource({ id: 'bad', text: 'bonall $1,$2,missing' }, { profile: 'P5', customInstructions: registry }).diagnostics[0].code).toBe('asm.symbol.undefined');
    expect(assembleCourseSource({ id: 'bad', text: 'bonall $1,$2,0x70000' }, { profile: 'P5', customInstructions: registry }).diagnostics[0].code).toBe('asm.immediate.out-of-range');
    const load = assembleCourseSource({ id: 'memory', text: 'lhogez $3,-2($1)' }, { profile: 'P5', customInstructions: new CustomInstructionRegistry([lhogez]) });
    expect(load.diagnostics).toEqual([]); expect(load.image?.segments[0].words[0]).toBe(0xcc23fffe);
    expect(assembleCourseSource({ id: 'wrongmode', text: 'lhogez $3,0($1)' }, { profile: 'P3', customInstructions: new CustomInstructionRegistry([lhogez]) }).ok).toBe(false);
    expect(assembleMarsSource({ id: 'mars', text: 'addei $3,$1,2' }, { customInstructions: new CustomInstructionRegistry([addei]) }).ok).toBe(true);
  });
});
describe('declarative custom architecture effects', () => {
  it.each(['P3', 'P5', 'P7'] as const)('addei one-extension and overflow fallback in %s', profile => {
    const machine = session(addei, { rs: 1, rt: 3, immediate: 2 }, profile);
    machine.state.gpr.write(1, 1); expect(machine.stepInstruction().status).toBe('committed'); expect(machine.state.gpr.read(3)).toBe(0xffff0003);
    const overflow = session(addei, { rs: 1, rt: 3, immediate: 2 }, profile);
    overflow.state.gpr.write(1, 0x80000000); overflow.stepInstruction(); expect(overflow.state.gpr.read(3)).toBe(0xffff0002);
  });
  it('lhogez selects the actual destination and links PC+4 on P5', () => {
    const positive = session(lhogez, { base: 0, rt: 3, offset: 0 }, 'P5', [0x0000ffff]);
    positive.stepInstruction(); expect(positive.state.gpr.read(3)).toBe(0xffffffff); expect(positive.state.gpr.read(31)).toBe(0);
    const negative = session(lhogez, { base: 0, rt: 3, offset: 2 }, 'P5', [0x0000ffff]);
    negative.stepInstruction(); expect(negative.state.gpr.read(3)).toBe(0); expect(negative.state.gpr.read(31)).toBe(0x3004);
  });
  it('blztal reads the multiplier, conditionally links and consumes the real delay slot', () => {
    const taken = session(blztal, { rs: 1, rt: 2, offset: 1 });
    taken.state.gpr.write(1, 0xffffffff); taken.state.gpr.write(2, 1);
    taken.stepInstruction(); expect(taken.state.gpr.read(31)).toBe(0x3008); expect(taken.state.pc).toBe(0x3004);
    taken.stepInstruction(); expect(taken.state.pc).toBe(0x300c);
    const absent = session(blztal, { rs: 1, rt: 2, offset: 1 }); absent.state.gpr.write(31, 42);
    absent.stepInstruction(); absent.stepInstruction(); expect(absent.state.gpr.read(31)).toBe(42); expect(absent.state.pc).toBe(0x3008);
  });
  it('bonall always links, annuls false slots, and excludes signed minimum opposite-number overflow', () => {
    const machine = session(bonall, { rs: 1, rt: 2, offset: 2 });
    machine.state.gpr.write(1, 0x80000000); machine.state.gpr.write(2, 0x80000000);
    machine.stepInstruction(); expect(machine.state.gpr.read(31)).toBe(0x3008); expect(machine.state.pc).toBe(0x3008); expect(machine.state.pendingBranch).toBeUndefined();
    const taken = session(bonall, { rs: 1, rt: 2, offset: 2 }); taken.state.gpr.write(1, 7); taken.state.gpr.write(2, -7);
    taken.stepInstruction(); expect(taken.state.pc).toBe(0x3004); taken.stepInstruction(); expect(taken.state.pc).toBe(0x300c);
  });
  it('P7 load faults suppress dynamic writes and retain delay-slot BD/EPC', () => {
    const registry = new CustomInstructionRegistry([lhogez]);
    const machine = new MachineSession({ profile: resolveCourseProfile('P7'), image: textImage([op('beq', { rs: 0, rt: 0, immediate: 2 }), registry.encode('lhogez', { base: 0, rt: 3, offset: 1 }, 'P7')]), customInstructions: registry });
    machine.stepInstruction(); const result = machine.stepInstruction();
    expect(result.event?.trap?.name).toBe('adel'); expect(result.event?.trap?.branchDelay).toBe(true); expect(machine.state.cp0?.epc).toBe(0x3000);
    expect(machine.state.gpr.read(31)).toBe(0); expect(machine.state.gpr.read(3)).toBe(0); expect(machine.state.pc).toBe(0x4180);
  });
  it('execute-stage traps precede memory faults, SDK errors never partially commit', () => {
    const trapped = session({ ...lhogez, execute(ctx) { ctx.load(1, 4); return { trap: { name: 'ov' }, gprWrites: [{ register: 3, value: 1 }] }; } }, { base: 0, rt: 3, offset: 0 }, 'P7');
    expect(trapped.stepInstruction().event?.trap?.name).toBe('ov'); expect(trapped.state.gpr.read(3)).toBe(0);
    const invalid = session({ ...addei, execute() { return { gprWrites: [{ register: 3, value: 1 }, { register: 32, value: 2 }] }; } }, { rs: 0, rt: 3, immediate: 0 });
    expect(invalid.stepInstruction().status).toBe('out-of-domain'); expect(invalid.state.gpr.read(3)).toBe(0);
  });
  it('rejects custom control flow in a delay slot before invoking its callback', () => {
    const execute = vi.fn(bonall.execute);
    const registry = new CustomInstructionRegistry([{ ...bonall, execute }]);
    const machine = new MachineSession({ profile: resolveCourseProfile('P7'), image: textImage([op('beq', { rs: 0, rt: 0, immediate: 2 }), registry.encode('bonall', { rs: 0, rt: 0, offset: 2 }, 'P7')]), customInstructions: registry });
    machine.stepInstruction(); const result = machine.stepInstruction();
    expect(result.diagnostic?.reason).toBe('double-delay-slot'); expect(execute).not.toHaveBeenCalled();
  });
  it('uses ordinary MARS mode separately from the P7 course profile', () => {
    const registry = new CustomInstructionRegistry([{ ...addei, modes: ['mars'] }]);
    const image = textImage([registry.encode('addei', { rs: 0, rt: 3, immediate: 2 }, 'mars')], { base: 0x00400000 });
    const ordinary = new MachineSession({ image, profile: createMarsProfile(), customInstructions: registry });
    expect(ordinary.stepInstruction().status).toBe('committed'); expect(ordinary.state.gpr.read(3)).toBe(0xffff0002);
    expect(registry.decode(0xcc030002, 'P7')).toBeUndefined();
  });
  it('aborts prepared MMIO reads for script errors and interrupt victims', () => {
    const devices: DeviceBusPort = { prepare: access => ({ access }), read: () => 5, commit: vi.fn(() => []), abort: vi.fn(), sampleInterrupts: () => 0 };
    const definition: CustomInstructionDefinition = { ...addei, execute(ctx) { ctx.load(0x7f00, 4); throw new Error('bad custom callback'); } };
    const registry = new CustomInstructionRegistry([definition]);
    const image = textImage([registry.encode('addei', { rs: 0, rt: 3, immediate: 0 }, 'P7')]);
    const failed = new MachineSession({ profile: resolveCourseProfile('P7'), image, customInstructions: registry, devices });
    expect(failed.stepInstruction().status).toBe('out-of-domain'); expect(devices.abort).toHaveBeenCalledTimes(1); expect(devices.commit).not.toHaveBeenCalled();
    const normal = new CustomInstructionRegistry([{ ...addei, execute(ctx) { return { gprWrites: [{ register: 3, value: ctx.load(0x7f00, 4) }] }; } }]);
    const interrupted = new MachineSession({ profile: resolveCourseProfile('P7'), image, customInstructions: normal, devices });
    interrupted.state.cp0!.write(12, 0xfc01);
    expect(interrupted.stepInstruction({ hardwareInterrupts: 1 }).event?.trap?.kind).toBe('interrupt');
    expect(interrupted.state.gpr.read(3)).toBe(0); expect(devices.abort).toHaveBeenCalledTimes(2); expect(devices.commit).not.toHaveBeenCalled();
  });
});
