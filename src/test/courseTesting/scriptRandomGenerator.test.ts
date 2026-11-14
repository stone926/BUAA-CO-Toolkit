import { describe, expect, it } from 'vitest';
import { generateBuiltinAsmTestCase, resolveBuiltinInstructionSet } from '../../courseTesting/builtinAsmGenerator';
import { CpuState } from '../../courseTesting/cpuState';
import { previewCustomInstruction, applyCustomEffect } from '../../courseTesting/builtinAsm/customInstructions';
import { HazardTracker } from '../../courseTesting/builtinAsm/hazard/hazardTracker';
import { Random } from '../../courseTesting/random';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { executeProgramForService } from '../../mips/core/machine/executeService';
import type { CustomInstructionDefinition } from '../../mips/core/custom/api';
import { CustomInstructionRegistry } from '../../mips/core/custom/registry';
import { p7RiWordCatalog } from '../../courseTesting/p7RiWords';
import { validateCourseMachineCode } from '../../courseTesting/machineCodeValidation';
import { courseInstructionImageWords, wordsToHexText } from '../../mips/core/assembler/artifacts';
import addm from '../fixtures/customInstructions/P3_L10_addm_2023/instruction';
import pcadd from '../fixtures/customInstructions/P4_L10_pcadd_2023/instruction';
import addei from '../fixtures/customInstructions/P5_L4_addei_2022/instruction';
import lhogez from '../fixtures/customInstructions/P5_L5_lhogez_2022/instruction';
import lwer from '../fixtures/customInstructions/P5_M_lwer_2022/instruction';
import blztal from '../fixtures/customInstructions/P5_L3_blztal_2022/instruction';
import bonall from '../fixtures/customInstructions/P5_L2_bonall_2022/instruction';
import { executeScriptGenerationJob } from '../../mips/host/scriptGenerationJob';

const dynamic: CustomInstructionDefinition = {
  apiVersion: 1, mnemonic: 'testdynamic', modes: ['P3', 'P4', 'P5', 'P6', 'P7'],
  encoding: '011111 rs:5 rt:5 immediate:16',
  operands: [{ kind: 'register', field: 'rt' }, { kind: 'memory', baseField: 'rs', offsetField: 'immediate' }],
  access: { reads: ['rs', 'rt'], writes: ['dynamic'], memory: 'load', width: 4 }, generation: {},
  timing: { hazardClass: 'load', reads: [{ field: 'rs', role: 'rs', useStage: 'E' }, { field: 'rt', role: 'rt', useStage: 'E' }], readyStage: 'W' },
  execute(ctx, fields) {
    const value = ctx.load((ctx.readGpr(fields.rs) + ((fields.immediate << 16) >> 16)) >>> 0, 4);
    return { gprWrites: [{ register: (value + ctx.readGpr(fields.rt)) & 0x1e, value }] };
  }
};
const algebra: CustomInstructionDefinition = {
  apiVersion: 1, mnemonic: 'testalgebra', modes: ['P3', 'P4', 'P5', 'P6', 'P7'],
  encoding: '011110 rs:5 rt:5 immediate:16',
  operands: [{ kind: 'register', field: 'rt' }, { kind: 'register', field: 'rs' }, { kind: 'immediate', field: 'immediate', signed: true }],
  access: { reads: ['rs'], writes: ['rt'] }, generation: {},
  timing: { hazardClass: 'cal_ri', reads: [{ field: 'rs', role: 'rs', useStage: 'E' }], readyStage: 'M' },
  execute(ctx, fields) { return { gprWrites: [{ register: fields.rt, value: (ctx.readGpr(fields.rs) + ((fields.immediate << 16) >> 16)) | 0 }] }; }
};
const branch: CustomInstructionDefinition = {
  apiVersion: 1, mnemonic: 'testbranch', modes: ['P5', 'P6', 'P7'], controlFlow: true,
  encoding: '011101 rs:5 rt:5 immediate:16',
  operands: [{ kind: 'register', field: 'rs' }, { kind: 'register', field: 'rt' }, { kind: 'immediate', field: 'immediate', signed: true }],
  access: { reads: ['rs', 'rt'], writes: ['dynamic'] },
  generation: { control: { targetField: 'immediate', relocation: 'branch', shiftBy: { field: 'rt', mask: 3 } },
    cases: [{ registerValues: { rs: -1, rt: 1 } }, { registerValues: { rs: 1, rt: 0 } }] },
  timing: { hazardClass: 'br_r2', reads: [{ field: 'rs', role: 'rs', useStage: 'D' }, { field: 'rt', role: 'rt', useStage: 'D' }], readyStage: 'E' },
  execute(ctx, fields) {
    const taken = (ctx.readGpr(fields.rs) | 0) < 0;
    return { control: { target: ctx.pc + 4 + ((fields.immediate << 16) >> 16) * 2 ** (2 + (ctx.readGpr(fields.rt) & 3)), taken, annulDelaySlot: true },
      gprWrites: taken ? [{ register: 31, value: ctx.linkAddress }] : [] };
  }
};
const generatedAt = new Date('2026-01-01T00:00:00Z');

describe('script instruction random generation', () => {
  it('rejects overridden native helpers before returning a case, while allowing custom SB payloads', () => {
    const zerori: CustomInstructionDefinition = { ...algebra, mnemonic: 'zerori', override: true,
      encoding: '001101 rs:5 rt:5 immediate:16', execute: (_ctx, fields) => ({ gprWrites: [{ register: fields.rt, value: 0 }] }) };
    const registry = new CustomInstructionRegistry([zerori]);
    const options = { profile: 'P5' as const, instructionText: 'ori lw sw zerori', instructionCount: 512, seed: 'override-0', generatedAt };
    expect(() => generateBuiltinAsmTestCase({ ...options, customRegistry: registry })).toThrow(/ori \(zerori\).*用户 ASM/);
    expect(() => executeScriptGenerationJob({ ...options, generatedAt: generatedAt.toISOString(), registerCoverage: true }, registry)).toThrow(/ori \(zerori\)/);
    const sb: CustomInstructionDefinition = { ...dynamic, mnemonic: 'sb', override: true, encoding: '101000 rs:5 rt:5 immediate:16',
      access: { reads: ['rs', 'rt'], memory: 'store', width: 1 },
      timing: { hazardClass: 'store', reads: [{ field: 'rs', role: 'rs', useStage: 'E' }, { field: 'rt', role: 'rt', useStage: 'M' }] },
      execute: (ctx, fields) => ({ store: { address: (ctx.readGpr(fields.rs) + ((fields.immediate << 16) >> 16)) >>> 0, width: 1, value: ctx.readGpr(fields.rt) } }) };
    const stores = new CustomInstructionRegistry([sb]);
    const generated = generateBuiltinAsmTestCase({ ...options, instructionText: 'sb', customRegistry: stores });
    expect(generated.usedInstructions).toContain('sb');
    const assembly = assembleCourseSource({ id: 'sb', text: generated.text }, { profile: 'P5', customInstructions: stores });
    expect(assembly.diagnostics).toEqual([]);
    expect(executeProgramForService({ profile: 'P5', segments: assembly.image!.segments, haltPc: 0x3000 + 512 * 4, maxSteps: 3000 }, stores).status).toBe('halted');
  });

  it('formats raw signed field constraints as legal signed assembly operands', () => {
    const definition = { ...algebra, generation: { fields: { immediate: { values: [65535] } } } };
    const registry = new CustomInstructionRegistry([definition]);
    const generated = generateBuiltinAsmTestCase({ profile: 'P5', instructionText: 'testalgebra', instructionCount: 32,
      seed: 'raw-signed', generatedAt, customRegistry: registry });
    expect(generated.text).toMatch(/testalgebra \$\d+, \$\d+, -1/);
    expect(assembleCourseSource({ id: 'signed', text: generated.text }, { profile: 'P5', customInstructions: registry }).diagnostics).toEqual([]);
  });

  it('keeps custom branch numeric offsets compatible with MARS while relocating symbols', () => {
    const registry = new CustomInstructionRegistry([bonall]);
    const assemble = (text: string) => {
      const result = assembleCourseSource({ id: 'branch-offset', text }, { profile: 'P5', customInstructions: registry });
      expect(result.diagnostics).toEqual([]);
      return courseInstructionImageWords(result.image!);
    };
    expect(assemble('.text\nbonall $1,$2,1\nnop\nnop')).toEqual(assemble('.text\nbonall $1,$2,target\nnop\ntarget:nop'));
    expect(assemble('.text\nbonall $1,$2,-1\nnop')).toEqual(assemble('.text\nagain:bonall $1,$2,again\nnop'));
    expect(assemble('.text\nbonall $1,$2,1+0\nnop\nnop')).toEqual(assemble('.text\nbonall $1,$2,target\nnop\ntarget:nop'));
  });

  it.each([addm, pcadd, addei, lhogez, lwer, blztal, bonall])('executes the real $mnemonic recipe mixed with ordinary instructions', (definition) => {
    const registry = new CustomInstructionRegistry([definition]);
    for (const profile of ['P5', 'P7'] as const) {
      for (let index = 0; index < 4; index++) {
        const generated = generateBuiltinAsmTestCase({ profile, instructionText: `ori lui add sub lw sw beq ${definition.mnemonic}`,
          instructionCount: 1024, seed: `${definition.mnemonic}-${index}`, generatedAt, customRegistry: registry });
        expect(generated.usedInstructions, generated.seed).toContain(definition.mnemonic);
        const assembled = assembleCourseSource({ id: definition.mnemonic, text: generated.text }, { profile, customInstructions: registry });
        expect(assembled.diagnostics, generated.seed).toEqual([]);
        const executed = executeProgramForService({ profile, segments: assembled.image!.segments,
          haltPc: 0x3000 + generated.instructionCount * 4, maxSteps: 12000 }, registry);
        expect(executed.diagnostic, generated.seed).toBeUndefined();
        expect(executed.status).toBe('halted');
      }
    }
  });
  it('selects registered recipes by default and rejects missing recipes explicitly', () => {
    const registry = new CustomInstructionRegistry([algebra, { ...dynamic, generation: undefined }]);
    expect(resolveBuiltinInstructionSet('P5', '', registry).mnemonics).toContain('testalgebra');
    expect(resolveBuiltinInstructionSet('P5', '', registry).mnemonics).not.toContain('testdynamic');
    expect(() => resolveBuiltinInstructionSet('P5', 'testdynamic', registry)).toThrow(/not supported/);
  });

  it.each(['P3', 'P4', 'P5', 'P6', 'P7'] as const)('assembles and executes mixed state-aware programs deterministically in %s', (profile) => {
    const registry = new CustomInstructionRegistry(profile === 'P3' || profile === 'P4' ? [algebra, dynamic] : [algebra, dynamic, branch]);
    for (let index = 0; index < 8; index++) {
      const options = { profile, instructionText: 'ori add sub lw sw testalgebra testdynamic' + (profile === 'P3' || profile === 'P4' ? '' : ' testbranch'),
        instructionCount: 512, seed: `mixed-${index}`, generatedAt, customRegistry: registry };
      const generated = generateBuiltinAsmTestCase(options);
      expect(generateBuiltinAsmTestCase(options).text).toBe(generated.text);
      expect(generated.usedInstructions).toContain('testalgebra');
      expect(generated.usedInstructions).toContain('testdynamic');
      const assembled = assembleCourseSource({ id: 'mixed', text: generated.text }, { profile, customInstructions: registry });
      expect(assembled.diagnostics, generated.seed).toEqual([]);
      const executed = executeProgramForService({ profile, segments: assembled.image!.segments, maxSteps: 10000,
        haltPc: 0x3000 + generated.instructionCount * 4 }, registry);
      expect(executed.status, `${generated.seed}: ${executed.diagnostic?.message}`).toBe('halted');
      expect(executed.diagnostic).toBeUndefined();
      expect(assembled.image!.segments.filter((segment) => !['text', 'ktext', '.text', '.ktext'].includes(segment.name))
        .every((segment) => segment.words.every((word) => word === 0))).toBe(true);
    }
  });

  it('uses raw decoded immediate fields and actual dynamic destinations in state and hazards', () => {
    const state = new CpuState();
    state.setRegister('$1', 9); state.setRegister('$2', 6); state.memory.set(0, 0xfffffff0);
    const signed = previewCustomInstruction(algebra, state, new Random(4), 0x3000, true, 'end',
      { write: '$3', reads: { rs: '$1' }, immediate: -2 });
    expect(signed?.effect.gprWrites).toEqual([{ register: 3, value: 7 }]);
    const candidate = previewCustomInstruction(dynamic, state, new Random(5), 0x3004, true, 'end',
      { reads: { rs: '$0', rt: '$2' }, address: 0 });
    expect(candidate?.hazard?.write?.register).toBe('$22');
    applyCustomEffect(state, candidate!.effect);
    expect(state.regValue('$22')).toBe(-16);
    state.setRegister('$22', 0);
    const tracker = new HazardTracker(state);
    tracker.record(0, 'testdynamic $2, 0($0)', true, candidate!.hazard);
    applyCustomEffect(state, candidate!.effect);
    tracker.record(1, 'ori $3, $22, 1', true);
    state.setRegister('$3', -15); tracker.settle();
    expect([...tracker.forwardOperands]).toContain('operand:testdynamic>ori.rs+0');
  });

  it('does not claim forwarding across scripts without timing facts or absent conditional writes', () => {
    const state = new CpuState();
    const tracker = new HazardTracker(state);
    tracker.record(0, 'ori $1, $0, 1', true); state.setRegister('$1', 1);
    tracker.record(1, 'unknownscript', true, null);
    tracker.record(2, 'ori $2, $1, 2', true); state.setRegister('$2', 3); tracker.settle();
    expect(tracker.coverage.summary().forwardEvents).toBe(0);
    const notTaken = previewCustomInstruction(branch, state, new Random(1), 0x3000, true, 'end', undefined, { rs: 0, rt: 0 });
    expect(notTaken?.hazard?.write).toBeUndefined();
  });

  it('excludes a masked custom source even when its producer changes the register value', () => {
    const state = new CpuState();
    const tracker = new HazardTracker(state);
    tracker.record(0, 'ori $1, $0, 256', true); state.setRegister('$1', 256); tracker.settle();
    const masked = { ...algebra, execute: () => ({ gprWrites: [{ register: 3, value: 7 }] }) };
    const candidate = previewCustomInstruction(masked, state, new Random(1), 0x3004, true, 'end', { write: '$3', reads: { rs: '$1' } })!;
    expect(candidate.assess({ role: 'rs', value: 0 })).toBe('masked');
    tracker.record(1, candidate.text, true, candidate.hazard, () => 'masked');
    applyCustomEffect(state, candidate.effect); tracker.settle();
    expect(tracker.coverage.summary().validForwardEvents).toBe(0);
    expect(tracker.forwardOperands.size).toBe(0);
    const sensitive = previewCustomInstruction(algebra, state, new Random(1), 0x3008, true, 'end', { write: '$3', reads: { rs: '$1' }, immediate: 0 })!;
    expect(sensitive.assess({ role: 'rs', value: 0 })).toBe('observable');
  });

  it('preserves bounded payloads and replaces registered RI cells without disabling P7 probes', () => {
    const ownsRi: CustomInstructionDefinition = { ...algebra, mnemonic: 'ownsri', encoding: '111111 rs:5 rt:5 immediate:16' };
    const registry = new CustomInstructionRegistry([ownsRi]);
    const result = generateBuiltinAsmTestCase({ profile: 'P7', instructionText: '', instructionCount: 1118, generatedAt, seed: 'ri-collision',
      p7StressMode: 'probe', probeShard: 'core', probeScenarioCount: 12, exceptionTypes: ['ri'], customRegistry: registry });
    expect(result.probe?.scenarios.some((scenario) => scenario.kind === 'ri')).toBe(true);
    expect(result.text).not.toContain('.word 0xfc000000');
    expect(p7RiWordCatalog[0].word).toBe(0xfc000000);
    const assembly = assembleCourseSource({ id: 'ri', text: result.text }, { profile: 'P7', customInstructions: registry });
    expect(assembly.diagnostics).toEqual([]);
    const words = courseInstructionImageWords(assembly.image!);
    expect(validateCourseMachineCode('P7', wordsToHexText(words), result.text, true, registry.encodings('P7'))).toEqual([]);
    const executed = executeProgramForService({ profile: 'P7', segments: assembly.image!.segments, maxSteps: 10000,
      haltPc: 0x3000 + (result.instructionCount - 2) * 4,
      deviceSchedule: { kind: 'timeline', entries: Array.from({ length: 10000 }, (_, afterInstruction) => ({ afterInstruction, cycles: 1 })) } }, registry);
    expect(executed.diagnostic).toBeUndefined();
    expect(executed.status).toBe('halted');
    expect(() => generateBuiltinAsmTestCase({ profile: 'P7', instructionText: '', instructionCount: 1119, customRegistry: registry })).toThrow(/at most/);
  });
});
