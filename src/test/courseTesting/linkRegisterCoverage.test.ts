import { describe, expect, it, vi } from 'vitest';
import { automaticTestPolicy } from '../../courseTesting/automaticTestPolicy';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import * as linkCoverage from '../../courseTesting/builtinAsm/linkRegisterCoverage';
import { compareTraces } from '../../language/mips/traceCompare';
import { parseCpuTraceOutput } from '../../language/mips/traceParser';
import type { CourseProfile } from '../../mips/core/generated/isaCatalog';
import { assembleLinkProgram, executeLinkFault, instructionAt, labelPc } from '../helpers/linkRegisterFaults';

const basic = 'add,sub,ori,lw,sw,beq,lui,jal,jr,nop';
const operations = ['add', 'sub'] as const;
const ports = ['rs', 'rt'] as const;
const gaps = [0, 1, 2, 3] as const;
const producers = ['ori', 'add', 'sub', 'lw'] as const;
const consumers = ['alu', 'branch', 'branch_rt', 'store', 'jr'] as const;
const prefix = '_co_link_cov_';
const compare = (expected: readonly string[], actual: readonly string[]) =>
  compareTraces(parseCpuTraceOutput(expected.join('\n')), parseCpuTraceOutput(actual.join('\n')));

function generate(profile: CourseProfile = 'P5', seed = 'link-register-directed', instructionText = '', instructionCount = automaticTestPolicy(profile).instructionCount) {
  return generateBuiltinAsmTestCase({
    profile, instructionText, instructionCount, seed, p7StressMode: 'off',
    interrupt: false, exceptionRate: 0
  });
}

const fixtures = new Map<string, ReturnType<typeof assembleLinkProgram>>();
function fixture(seed = 'link-register-directed') {
  let result = fixtures.get(seed);
  if (!result) {
    result = assembleLinkProgram(generate('P5', seed).text, 'P5');
    fixtures.set(seed, result);
  }
  return result;
}

describe('generated link-register coverage', () => {
  it.each(['link-register-directed', 'link-register-second', 'link-register-third'])(
    'executes the whole default P5 read/priority/return matrix for seed %s', (seed) => {
      const program = fixture(seed);
      expect(program.oracle).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
      const good = executeLinkFault(program);
      expect(good.status).toBe('halted');
      expect(good.hits).toBe(0);
      expect(compare(program.oracle.trace!, good.trace).matched).toBe(true);
      const pcs = good.events.map((event) => event.pcBefore);
      for (const operation of operations) for (const port of ports) for (const gap of gaps) {
        const label = `${prefix}read_${operation}_${port}_gap${gap}`;
        const jal = labelPc(program.image, `${label}_jal`);
        const consumer = labelPc(program.image, `${label}_consumer`);
        const word = instructionAt(program.image, consumer);
        expect(word & 0x3f, label).toBe(operation === 'add' ? 0x20 : 0x22);
        expect((word >>> (port === 'rs' ? 21 : 16)) & 31, label).toBe(31);
        expect(pcs.indexOf(consumer) - pcs.indexOf(jal), label).toBe(gap + 1);
        expect(good.events.find((event) => event.pcBefore === jal)?.gprWrites)
          .toEqual([{ register: 31, value: jal + 8 }]);
        const link = jal + 8;
        const expected = operation === 'add' ? link + 0x30
          : port === 'rs' ? link - 0x30 : 0x30 - link;
        expect(good.events.find((event) => event.pcBefore === consumer)?.gprWrites, label)
          .toEqual([{ register: 20, value: expected >>> 0 }]);
      }
      for (const producer of producers) for (const consumer of consumers) {
        const label = `${prefix}rewrite_${producer}_${consumer}`;
        const pc = labelPc(program.image, `${label}_consumer`);
        expect(pcs, label).toContain(pc);
        const jal = labelPc(program.image, `${label}_jal`);
        const expected = consumer === 'jr' ? labelPc(program.image, `${label}_done`) : 0x44;
        expect(good.events.find((event) => event.pcBefore === jal + 4)?.gprWrites, label)
          .toEqual([{ register: 31, value: expected }]);
        const useIndex = good.events.findIndex((event) => event.pcBefore === pc);
        expect(good.events[useIndex - 1], label).toMatchObject({ mnemonic: producer, pcBefore: jal + 4 });
        expect(good.events[useIndex - 2], label).toMatchObject({ mnemonic: 'jal', pcBefore: jal });
        if (consumer === 'alu') {
          const word = instructionAt(program.image, pc);
          expect((word >>> 21) & 31, label).toBe(31);
          expect((word >>> 16) & 31, label).toBe(31);
          expect(good.events.find((event) => event.pcBefore === pc)?.gprWrites, label)
            .toEqual([{ register: 20, value: 2 * expected }]);
        } else if (consumer === 'branch' || consumer === 'branch_rt') {
          expect((instructionAt(program.image, pc) >>> (consumer === 'branch' ? 21 : 16)) & 31, label).toBe(31);
        }
      }
      for (const name of ['adjust_return', 'restore_return', 'mature_return']) {
        const jr = labelPc(program.image, `${prefix}${name}_jr`);
        expect(pcs, name).toContain(jr);
        const jump = good.events.findIndex((event) => event.pcBefore === jr);
        expect(good.events[jump + 1].delaySlot, name).toBe(true);
        if (name === 'mature_return') {
          const jal = labelPc(program.image, `${prefix}${name}_jal`);
          expect(jump - pcs.indexOf(jal)).toBe(4);
        }
      }
    }
  );

  it('rejects a real PC+4 link execution, before later control-flow symptoms', () => {
    const program = fixture();
    const mutant = executeLinkFault(program, { kind: 'jal-pc-plus-four' });
    expect(mutant.hits).toBeGreaterThan(0);
    const diff = compare(program.oracle.trace!, mutant.trace);
    expect(diff.matched).toBe(false);
    expect(diff.firstDiffEntry).toMatchObject({
      oracle: { target: '31' }, dut: { target: '31' }, reason: '写入值不一致。'
    });
  });

  it('exposes link-minus-four and stale operands on both ALU ports at every gap, including mature GRF reads', () => {
    const program = fixture();
    for (const operation of operations) for (const port of ports) for (const gap of gaps) {
      const label = `${prefix}read_${operation}_${port}_gap${gap}`;
      const pc = labelPc(program.image, `${label}_consumer`);
      for (const replacement of ['minus-four', 'previous-write'] as const) {
        const mutant = executeLinkFault(program, { kind: 'operand', pc, replacement });
        expect(mutant.hits, `${label} ${replacement}`).toBe(1);
        expect(mutant.injection?.actual, label).not.toBe(mutant.injection?.expected);
        expect(compare(program.oracle.trace!, mutant.trace).matched, `${label} ${replacement}`).toBe(false);
        const normal = parseCpuTraceOutput(program.oracle.trace!.join('\n')).find((event) => Number.parseInt(event.pc, 16) === pc);
        const changed = parseCpuTraceOutput(mutant.trace.join('\n')).find((event) => Number.parseInt(event.pc, 16) === pc);
        expect(changed?.value, label).not.toBe(normal?.value);
      }
    }
  });

  it('rejects an older jal winning over each younger ALU/load writer at every consumer', () => {
    const program = fixture();
    for (const producer of producers) for (const consumer of consumers) {
      const label = `${prefix}rewrite_${producer}_${consumer}`;
      const first = labelPc(program.image, `${label}_consumer`);
      const reads: Array<{ pc: number; readIndex: 0 | 1 }> = [{ pc: first, readIndex: 0 }];
      if (consumer === 'alu') reads.push({ pc: first, readIndex: 1 });
      for (const { pc, readIndex } of reads) {
        const mutant = executeLinkFault(program, { kind: 'operand', pc, readIndex, replacement: 'older-jal' });
        expect(mutant.hits, `${label} read ${readIndex}`).toBe(1);
        expect(mutant.injection, label).toMatchObject({ pc, readIndex });
        expect(compare(program.oracle.trace!, mutant.trace).matched, `${label} read ${readIndex}`).toBe(false);
        if (producer === 'lw') {
          // Each consumer, including the independent rt-branch replay, is
          // immediately after its own load and still competes with its own jal.
          const index = mutant.events.findIndex((event) => event.pcBefore === pc);
          expect(mutant.events[index - 1].mnemonic, label).toBe('lw');
        }
      }
    }
  });

  it('observes erroneous $31 targets through actual jr execution and wrong-path commits', () => {
    const program = fixture();
    for (const name of ['adjust_return', 'restore_return', 'mature_return']) {
      const pc = labelPc(program.image, `${prefix}${name}_jr`);
      const mutant = executeLinkFault(program, { kind: 'operand', pc, replacement: 'minus-four' });
      expect(mutant.hits, name).toBe(1);
      expect(compare(program.oracle.trace!, mutant.trace).matched, name).toBe(false);
      const index = mutant.events.findIndex((event) => event.pcBefore === pc);
      expect(mutant.events[index + 2].pcBefore, name).toBe(mutant.injection!.actual);
      if (name === 'mature_return') {
        const slot = labelPc(program.image, `${prefix}${name}_jal`) + 4;
        expect(mutant.events.filter((event) => event.pcBefore === slot)).toHaveLength(2);
      }
    }
  });

  it.each(['P4', 'P7'] as const)('keeps %s semantics and the automatic image budget', (profile) => {
    const generated = generate(profile, `link-compatibility-${profile}`, profile === 'P7' ? basic : '');
    const program = assembleLinkProgram(generated.text, profile);
    expect(program.oracle).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
    expect(generated.instructionCount).toBe(profile === 'P7' ? 1118 : 4094);
    const text = program.image.segments.find((segment) => segment.name === 'text')!;
    expect(text.words).toHaveLength(generated.instructionCount + 2);
    expect(text.baseAddress + text.words.length * 4).toBeLessThanOrEqual(profile === 'P7' ? 0x4180 : 0x7000);
    expect(generated.text.includes(prefix)).toBe(profile === 'P7');
  });

  it.each([
    ['ori,add,sub,beq,jal,jr,nop', 1024],
    ['ori,add,beq,jal,jr,nop', 1024],
    ['ori,add,sub,beq,nop', 1024],
    [basic, 32], [basic, 128], [basic, 256]
  ] as const)('keeps partial instruction sets and short budgets whole (%s, %i)', (instructionText, count) => {
    const generated = generate('P5', `link-subset-${instructionText}-${count}`, instructionText, count);
    const program = assembleLinkProgram(generated.text, 'P5');
    expect(program.oracle).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
    expect(program.image.segments.find((segment) => segment.name === 'text')!.words).toHaveLength(count + 2);
    for (const mnemonic of generated.usedInstructions) expect(instructionText.split(','), mnemonic).toContain(mnemonic);
    if (!instructionText.includes('jal') || count < 256) expect(generated.text).not.toContain(prefix);
    if (!instructionText.includes('lw')) expect(generated.text).not.toContain(`${prefix}rewrite_lw_`);
  });

  it('also generates genuine random jal-to-ALU dependencies when the fixed matrix is disabled', () => {
    const disabled = vi.spyOn(linkCoverage, 'emitLinkRegisterCoverage').mockImplementation(() => undefined);
    const observed = new Set<string>();
    try {
      for (const seed of ['link-random-regression-0', 'link-random-regression-1', 'link-random-regression-2']) {
        const generated = generate('P5', seed);
        expect(generated.text).not.toContain(prefix);
        const program = assembleLinkProgram(generated.text, 'P5');
        expect(program.oracle.status).toBe('halted');
        const execution = executeLinkFault(program);
        expect(compare(program.oracle.trace!, execution.trace).matched).toBe(true);
        const targets = new Set(program.image.symbols.filter((symbol) => /^_co_hz_link_/.test(symbol.name)).map((symbol) => symbol.value));
        for (let index = 0; index < execution.events.length; index++) {
          const event = execution.events[index];
          if (event.mnemonic !== 'jal' || !targets.has((event.instructionWord! & 0x03ff_ffff) << 2)) continue;
          for (const use of execution.events.slice(index + 1, index + 5)) {
            if (use.mnemonic !== 'add' && use.mnemonic !== 'sub') continue;
            const word = use.instructionWord!;
            if (((word >>> 21) & 31) === 31) observed.add(`${use.mnemonic}:rs`);
            if (((word >>> 16) & 31) === 31) observed.add(`${use.mnemonic}:rt`);
          }
        }
      }
    } finally { disabled.mockRestore(); }
    expect([...observed].sort()).toEqual(['add:rs', 'add:rt', 'sub:rs', 'sub:rt']);
  });
});
