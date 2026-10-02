import { describe, expect, it } from 'vitest';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { assembleMarsSource } from '../../mips/core/assembler/marsAssembler';
import { assembleMarsProgramForService, parseMarsAssemblerServiceRequest } from '../../mips/core/assembler/assemblyService';
import { getMarsMemoryLayout, marsMemoryConfigurations } from '../../mips/core/profiles/marsMemoryLayout';
import { programImageIssues } from '../../mips/replay/programImage';

describe('ordinary MARS assembler', () => {
  it('assembles default relocations and kernel handler without course data padding', () => {
    const result = assembleMarsSource({ id: 'root', text: [
      '.data',
      'value: .word 0x12345678',
      '.text',
      'main: la $a0, value',
      'lw $t0, value',
      'j main',
      'syscall',
      '.ktext 0x80000180',
      'handler: eret'
    ].join('\n') });
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.image!.entryPc).toBe(0x0040_0000);
    const segments = result.image!.segments;
    expect(segments.find((segment) => segment.name === 'text')!.words).toEqual([
      0x3c01_1001, 0x3424_0000, 0x3c01_1001, 0x8c28_0000, 0x0810_0000, 0x0000_000c
    ]);
    expect(segments.find((segment) => segment.name === 'data')).toEqual({
      name: 'data', baseAddress: 0x1001_0000, words: [0x1234_5678]
    });
    const kernel = segments.find((segment) => segment.name === 'ktext')!;
    expect(kernel.baseAddress + (kernel.words.length - 1) * 4).toBe(0x8000_0180);
    expect(kernel.words.at(-1)).toBe(0x4200_0018);
    expect(result.image!.symbols.find((symbol) => symbol.name === 'handler')!.value).toBe(0x8000_0180);
    expect(programImageIssues(result.image!)).toEqual([]);
  });

  for (const configuration of marsMemoryConfigurations) {
    it(`uses official addresses and pseudo expansions for ${configuration}`, () => {
      const memory = getMarsMemoryLayout(configuration);
      const result = assembleMarsSource({ id: 'root', text: [
        '.extern shared 4', '.data', 'value: .word shared', '.text', 'la $t0, value',
        'lw $t1, value($s0)', '.ktext', 'eret'
      ].join('\n') }, { memoryConfiguration: configuration });
      expect(result.diagnostics).toEqual([]);
      expect(result.image!.entryPc).toBe(memory.sectionLayout.text.base);
      expect(result.image!.segments.find((segment) => segment.name === 'data')!.baseAddress).toBe(memory.sectionLayout.data.base);
      expect(result.image!.segments.find((segment) => segment.name === 'data')!.words).toEqual([memory.externBase]);
      expect(result.image!.segments.find((segment) => segment.name === 'ktext')!.baseAddress).toBe(memory.sectionLayout.ktext.base);
      const words = result.image!.segments.find((segment) => segment.name === 'text')!.words;
      expect(words).toHaveLength(configuration === 'Default' ? 5 : 2);
      if (configuration !== 'Default') {
        expect(words).toEqual([0x2008_0000 + memory.sectionLayout.data.base, 0x8e09_0000 + memory.sectionLayout.data.base]);
      }
    });
  }

  it('shares .include, .macro, .eqv, floating data, and source-map provenance', () => {
    const request = parseMarsAssemblerServiceRequest({
      sources: [
        { id: 'root', text: '.include "helpers.asm"\n.data\none: .float FACTOR\ntwo: .double -2.5\n.text\nput(FACTOR)\nput(2)' },
        { id: 'helpers', text: '.eqv FACTOR 1.5\n.macro put (%value)\nlocal: li $v0, 1\n.end_macro' }
      ],
      includes: [{ fromId: 'root', specifier: 'helpers.asm', toId: 'helpers' }]
    });
    const result = assembleMarsProgramForService(request);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.image!.segments.find((segment) => segment.name === 'data')!.words).toEqual([
      0x3fc0_0000, 0, 0, 0xc004_0000
    ]);
    expect(result.image!.sourceMap.filter((entry) => entry.sourceId === 'helpers')).toHaveLength(2);
    expect(result.image!.sourceMap.some((entry) => entry.expansionStack?.some((origin) => origin.sourceId === 'root'))).toBe(true);
    expect(result.image!.symbols.filter((symbol) => symbol.name.startsWith('local'))).toHaveLength(2);
    expect(result.image!.inputGraph.map((unit) => unit.id)).toEqual(['root', 'helpers']);
  });

  it('encodes label addresses with bit 15 and kernel addresses without signed-half errors', () => {
    const result = assembleMarsSource({ id: 'root', text: [
      '.data 0x10018000', 'value: .word 42', '.text', 'la $t0, value', 'lw $t1, value',
      'la $t2, handler', 'lw $t3, 0xffff0000', '.ktext 0x80000180', 'handler: eret'
    ].join('\n') });
    expect(result.diagnostics).toEqual([]);
    expect(result.image!.segments.find((segment) => segment.name === 'text')!.words).toEqual([
      0x3c01_1001, 0x3428_8000, 0x3c01_1002, 0x8c29_8000,
      0x3c01_8000, 0x342a_0180, 0x3c01_ffff, 0x8c2b_0000
    ]);
  });

  it('keeps kernel data independent and resolves data below the static base', () => {
    const result = assembleMarsSource({ id: 'root', text: [
      '.data 0x10000000', 'shared: .word kernel',
      '.kdata', '.byte 1', 'kernel: .word shared', '.asciiz "K"',
      '.data', '.word 2', '.text', 'la $t0, kernel'
    ].join('\n') });
    expect(result.diagnostics).toEqual([]);
    expect(result.image!.segments.find((segment) => segment.name === 'data')).toEqual({
      name: 'data', baseAddress: 0x1000_0000, words: [0x9000_0004, 2]
    });
    expect(result.image!.segments.find((segment) => segment.name === 'kdata')).toEqual({
      name: 'kdata', baseAddress: 0x9000_0000, words: [1, 0x1000_0000, 0x4b]
    });
    expect(result.image!.segments.find((segment) => segment.name === 'text')!.words).toEqual([0x3c01_9000, 0x3428_0004]);
    expect(programImageIssues(result.image!)).toEqual([]);
    expect(result.image!.sourceMap.some((entry) => result.image!.segments[entry.segmentIndex].name === 'kdata')).toBe(true);
    expect(assembleCourseSource({ id: 'root', text: '.kdata\n.word 1' }, { profile: 'P7' }).ok).toBe(false);
  });

  it('rebases initialized user data without losing relocations or source maps', () => {
    const result = assembleMarsSource({ id: 'root', text: [
      '.data', 'upper: .word lower', '.data 0x10000000', 'lower: .word upper', '.text', 'nop'
    ].join('\n') });
    expect(result.diagnostics).toEqual([]);
    const data = result.image!.segments.find((segment) => segment.name === 'data')!;
    expect(data.baseAddress).toBe(0x1000_0000);
    expect(data.words[0]).toBe(0x1001_0000);
    expect(data.words[0x4000]).toBe(0x1000_0000);
    expect(result.image!.sourceMap.filter((entry) => entry.segmentIndex === result.image!.segments.indexOf(data))
      .map((entry) => entry.wordIndex).sort((a, b) => a - b)).toEqual([0, 0x4000]);
  });

  it.each(['.data\n.space 2147483647', '.data 0x70000000\n.word 1', '.text 0x0ffffffc\nnop'])(
    'reports oversized allocation or holes before creating a huge image: %s', (text) => {
      const result = assembleMarsSource({ id: 'root', text });
      expect(result.ok).toBe(false);
      expect(result.image).toBeUndefined();
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  );

  it('bounds sparse positions, alignment, and .space using the same segment budget', () => {
    for (const text of ['.data\n.space 68', '.data 0x10010040\n.word 1', '.data\n.byte 1\n.align 16']) {
      const result = assembleMarsSource({ id: 'root', text }, { maximumSegmentBytes: 64 });
      expect(result.ok).toBe(false);
      expect(result.diagnostics.some((diagnostic) => /上限/.test(diagnostic.message))).toBe(true);
    }
  });

  it('stops repeated directive allocation at the first budget failure', () => {
    for (const text of ['.data\n.word 1:1000000', '.data\n.double 1:1000000', '.text\n.word 0:1000000']) {
      const result = assembleMarsSource({ id: 'root', text }, { maximumSegmentBytes: 8 });
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toHaveLength(1);
    }
  });

  it('keeps course addressing and byte-identical padded data as its default', () => {
    const root = { id: 'root', text: '.data\nvalue: .word 1\n.text\nla $t0, value\nsyscall\n.ktext 0x4180\neret' };
    const course = assembleCourseSource(root, { profile: 'P7' });
    expect(course.diagnostics).toEqual([]);
    expect(course.image!.entryPc).toBe(0x3000);
    expect(course.image!.segments.find((segment) => segment.name === 'data')!.words).toHaveLength(1024);
    expect(course.image!.segments.find((segment) => segment.name === 'ktext')!.baseAddress).toBe(0x4180);
    expect(course.image!.segments.find((segment) => segment.name === 'text')!.words).toEqual([0x3c01_0000, 0x3428_0000, 0x0000_000c]);
    const ordinary = assembleMarsSource({ id: 'root', text: '_co_internal_unknown_instruction' });
    expect(ordinary.ok).toBe(false);
  });

  it('validates service configuration, source closure, and hard allocation ceilings', () => {
    const sources = [{ id: 'root', text: 'nop' }];
    expect(() => parseMarsAssemblerServiceRequest({ sources, memoryConfiguration: 'FixedCompactLargeText' })).toThrow(/memoryConfiguration/);
    expect(() => parseMarsAssemblerServiceRequest({ sources, maximumSegmentBytes: 1_000_000_000 })).toThrow(/maximumSegmentBytes/);
    expect(() => parseMarsAssemblerServiceRequest({ sources, includes: [{ fromId: 'root', specifier: 'x', toId: 'missing' }] })).toThrow(/known source ids/);
    expect(() => parseMarsAssemblerServiceRequest({ sources, p7RiInstruction: true })).toThrow(/unknown fields/);
  });
});
