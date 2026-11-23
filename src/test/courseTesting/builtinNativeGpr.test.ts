import { describe, expect, it, vi } from 'vitest';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import { CpuState } from '../../courseTesting/cpuState';
import { decodeHazardInstruction } from '../../hazardAnalysis/hazardInstruction';
import { HazardPipelineModel } from '../../hazardAnalysis/hazardPipeline';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { findCourseHaltPc } from '../../mips/core/assembler/artifacts';
import { CommitEvent } from '../../mips/core/events/commitEvent';
import { CourseProfile } from '../../mips/core/generated/isaCatalog';
import { prepareCourseExecution } from '../../mips/core/machine/executeService';
import { runCourseProgram } from '../../mips/core/machine/execution';

const profiles = ['P3', 'P4', 'P5', 'P6'] as const;
const nonzeroRegisters = Array.from({ length: 31 }, (_, index) => index + 1);
const highRegisters = nonzeroRegisters.filter((register) => register >= 26);
const linkBranches = ['bgezal', 'bltzal'];
const registerNumber = (register: string): number => Number(register.slice(1));

function execute(text: string, profile: CourseProfile) {
  const assembled = assembleCourseSource({ id: 'native-gpr', text }, { profile });
  expect(assembled.ok, assembled.diagnostics.map((item) => item.message).join('\n')).toBe(true);
  const image = assembled.image!;
  const haltPc = findCourseHaltPc(image, profile)!;
  const prepared = prepareCourseExecution({
    profile,
    enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
    segments: image.segments,
    entryPc: image.entryPc,
    haltPc,
    maxSteps: 16_384
  });
  const events: CommitEvent[] = [];
  const outcome = runCourseProgram(prepared.session, {
    onEvents: (slice) => events.push(...slice),
    finalSnapshotLevel: 'registers'
  });
  expect(outcome, outcome.diagnostic?.message).toMatchObject({
    status: 'halted', haltReason: 'course-halt-loop'
  });
  const instructions = text.split('main:\n')[1].split('_co_test_end:')[0]
    .split(/\r?\n/).filter((line) => /^ {4}\w/.test(line));
  expect(instructions).toHaveLength((haltPc - image.entryPc) / 4);
  const payload = events.filter((event) =>
    event.kind === 'instruction' && event.pcBefore >= image.entryPc && event.pcBefore < haltPc);
  return {
    payload,
    gpr: outcome.finalSnapshot.gpr,
    decode: (pc: number) => decodeHazardInstruction(instructions[(pc - image.entryPc) / 4])!
  };
}

describe('native P3–P6 signed arithmetic operands', () => {
  it.each(profiles)('executes full-width signed arithmetic inputs on %s', (profile) => {
    const { text } = generateBuiltinAsmTestCase({
      profile,
      instructionText: profile === 'P6' ? 'lui add sub addi div mfhi mflo' : 'lui add sub',
      instructionCount: 2048,
      seed: 'native-gpr-signed-operands'
    });
    const { payload, decode } = execute(text, profile);
    const registers = Array<number>(32).fill(0);
    const arithmetic = new Set(['add', 'sub', 'addi', 'div']);
    const wideInputs = new Set<string>();
    for (const event of payload) {
      if (event.mnemonic && arithmetic.has(event.mnemonic)) {
        const { reads } = decode(event.pcBefore);
        const operands = new Map(reads.map(({ register, role }) => [role, registers[registerNumber(register)]]));
        for (const [role, value] of operands) {
          if (Math.abs(value) > 0x2000) wideInputs.add(`${event.mnemonic}.${role}`);
        }
        if (event.mnemonic === 'div') {
          expect(operands.get('rt')).not.toBe(0);
          if (operands.get('rs') === -0x80000000) expect(operands.get('rt')).not.toBe(-1);
        }
      }
      for (const { register, value } of event.gprWrites) registers[register] = value | 0;
    }
    const expected = ['add.rs', 'add.rt', 'sub.rs', 'sub.rt'];
    if (profile === 'P6') expected.push('addi.rs', 'div.rs', 'div.rt');
    expect(wideInputs).toEqual(new Set(expected));
  });

  it('executes signed division when -1 is the sole nonzero input value', () => {
    const { text } = generateBuiltinAsmTestCase({
      profile: 'P6', instructionText: 'addi div', instructionCount: 24, seed: 'division-with-only-minus-one-28'
    });
    const { payload, decode } = execute(text, 'P6');
    const firstDivide = payload.findIndex(({ mnemonic }) => mnemonic === 'div');
    expect(firstDivide).toBeGreaterThanOrEqual(0);
    const registers = Array<number>(32).fill(0);
    for (const event of payload.slice(0, firstDivide)) {
      for (const { register, value } of event.gprWrites) registers[register] = value | 0;
    }
    const divisor = decode(payload[firstDivide].pcBefore).reads.find(({ role }) => role === 'rt')!;
    expect(new Set(registers)).toEqual(new Set([0, -1]));
    expect(registers[registerNumber(divisor.register)]).toBe(-1);
  });
});

describe('native P3–P6 random register operands', () => {
  it.each(profiles)('writes and reads all 31 GPRs through both %s ALU ports', (profile) => {
    const { text } = generateBuiltinAsmTestCase({
      profile, instructionText: 'ori addu', instructionCount: 2048, seed: 'native-gpr-alu-ports'
    });
    const { payload, gpr, decode } = execute(text, profile);
    const registers = Array<number>(32).fill(0);
    const written = new Set<number>();
    const readByRole = { rs: new Set<number>(), rt: new Set<number>() };
    let readZero = false;
    let discardedNonzero = false;
    for (const event of payload) {
      if (event.mnemonic === 'addu') {
        const instruction = decode(event.pcBefore);
        const operands = instruction.reads.map(({ register, role }) => {
          const index = registerNumber(register);
          if (index === 0) readZero = true;
          if (registers[index] !== 0) readByRole[role].add(index);
          return registers[index];
        });
        if (instruction.write?.register === '$0' && (operands[0] + operands[1]) >>> 0 !== 0) {
          expect(event.gprWrites).toEqual([]);
          discardedNonzero = true;
        }
      }
      for (const { register, value } of event.gprWrites) {
        registers[register] = value >>> 0;
        written.add(register);
      }
    }
    expect(written).toEqual(new Set(nonzeroRegisters));
    expect(readByRole.rs).toEqual(new Set(nonzeroRegisters));
    expect(readByRole.rt).toEqual(new Set(nonzeroRegisters));
    expect(readZero).toBe(true);
    expect(discardedNonzero).toBe(true);
    expect(gpr[0]).toBe(0);
  });

  it.each(profiles)('executes high registers in %s memory and control operands', (profile) => {
    const delaySlots = profile === 'P5' || profile === 'P6';
    const instructionText = 'ori lui addu lw sw bgtz blez bgezal bltzal j jalr nop';
    const { text } = generateBuiltinAsmTestCase({
      profile,
      instructionText: profile === 'P3' ? instructionText : `${instructionText} jal jr`,
      instructionCount: 3000,
      seed: 'native-gpr-memory-control'
    });
    const { payload, decode } = execute(text, profile);
    const pipeline = new HazardPipelineModel();
    const registers = Array<number>(32).fill(0);
    const high = new Set(highRegisters);
    const loadBases = new Set<number>();
    const storeBases = new Set<number>();
    const storeData = new Set<number>();
    const branchSources = new Set<number>();
    const jumpSources = new Set<number>();
    const jalrDestinations = new Set<number>();
    const forwardedThroughSlot = new Set<number>();
    let effectiveLoadStall = false;
    for (const event of payload) {
      const instruction = decode(event.pcBefore);
      const source = (role: 'rs' | 'rt') => instruction.reads.find((read) => read.role === role)?.register ?? '$0';
      const rs = registerNumber(source('rs'));
      const rt = registerNumber(source('rt'));
      const write = event.gprWrites[0];
      if (event.mnemonic === 'lw' && event.memoryReads?.length && high.has(rs) && registers[rs] !== 0) loadBases.add(rs);
      if (event.mnemonic === 'sw' && event.memoryWrites.length) {
        if (high.has(rs) && registers[rs] !== 0) storeBases.add(rs);
        if (high.has(rt) && registers[rt] !== 0) storeData.add(rt);
      }
      if (event.branchTaken !== undefined && instruction.hazardClass === 'br_r1') {
        if (high.has(rs) && registers[rs] !== 0) branchSources.add(rs);
        if (linkBranches.includes(instruction.mnemonic)) expect(rs).not.toBe(31);
      }
      if (event.mnemonic === 'jr' || event.mnemonic === 'jalr') {
        if (high.has(rs)) jumpSources.add(rs);
        expect(event.controlTarget).toBe(registers[rs]);
        if (event.mnemonic === 'jalr') {
          expect(write.register).not.toBe(rs);
          expect(write.value).toBe(event.pcBefore + (delaySlots ? 8 : 4));
          if (high.has(write.register)) jalrDestinations.add(write.register);
        }
      }
      if (delaySlots) {
        const observation = pipeline.observe(instruction, {
          previous: write && registers[write.register], next: write?.value
        });
        for (const forward of observation.forwards) {
          const register = registerNumber(forward.register);
          if (!high.has(register) || !forward.valid) continue;
          if (event.delaySlot || payload[forward.producerOrder].delaySlot) forwardedThroughSlot.add(register);
          if (forward.producer === 'lw' && observation.stallCauses.some((stall) => stall.causeOrder === forward.producerOrder)) {
            effectiveLoadStall = true;
          }
        }
      }
      if (write) registers[write.register] = write.value >>> 0;
    }
    for (const [role, covered] of Object.entries({
      loadBases, storeBases, storeData, branchSources, jumpSources, jalrDestinations
    })) {
      expect(covered.size, `${profile} ${role}`).toBeGreaterThanOrEqual(3);
    }
    if (delaySlots) {
      expect(forwardedThroughSlot.size).toBeGreaterThanOrEqual(3);
      expect(effectiveLoadStall).toBe(true);
    }
  });

  it.each(profiles)('models both %s link-branch outcomes and their path marker writes', (profile) => {
    const setRegister = vi.spyOn(CpuState.prototype, 'setRegister');
    const { text, modeledLinks, modeledMarkers } = (() => {
      try {
        const generated = generateBuiltinAsmTestCase({
          profile, instructionText: 'lui bgezal bltzal nop', instructionCount: 512,
          seed: 'both-link-branch-outcomes'
        });
        return {
          text: generated.text,
          // Ordinary LUI writes leave the low halfword clear. Links are in the text segment.
          modeledLinks: setRegister.mock.calls.filter(([register, value]) => register === '$31' && (value & 0xffff) !== 0)
            .map(([, value]) => value),
          modeledMarkers: setRegister.mock.calls.filter(([register]) => register === '$26')
            .map(([, value]) => value >>> 0)
        };
      } finally {
        setRegister.mockRestore();
      }
    })();
    const { payload, decode } = execute(text, profile);
    const linkOffset = profile === 'P3' || profile === 'P4' ? 4 : 8;
    const links = payload.filter((event) => linkBranches.includes(event.mnemonic ?? ''));
    const byPc = new Map(payload.map((event) => [event.pcBefore, event]));
    for (const mnemonic of linkBranches) {
      expect(new Set(links.filter((event) => event.mnemonic === mnemonic).map((event) => event.branchTaken)))
        .toEqual(new Set([true, false]));
    }
    for (const event of links) {
      expect(decode(event.pcBefore).reads[0].register).not.toBe('$31');
      expect(event.gprWrites).toEqual([{ register: 31, value: event.pcBefore + linkOffset }]);
      if (linkOffset === 8) expect(byPc.get(event.pcBefore + 4)?.delaySlot).toBe(true);
      const marker = byPc.get(event.pcBefore + linkOffset);
      if (event.branchTaken) expect(marker).toBeUndefined();
      else expect(marker?.gprWrites[0]?.register).toBe(26);
    }
    expect(modeledLinks).toEqual(links.map((event) => event.pcBefore + linkOffset));
    expect(modeledMarkers).toEqual(payload.flatMap((event) =>
      event.gprWrites.filter((write) => write.register === 26).map((write) => write.value >>> 0)));
  });
});
