import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { findCourseHaltPc } from '../../mips/core/assembler/artifacts';
import { commitEventSourceMap, sourceMapEntryForAddress } from '../../mips/core/assembler/sourceMap';
import { executeProgramForService, executeProgramForServiceAsync } from '../../mips/core/machine/executeService';

const corpusRoot = path.resolve(process.cwd(), 'conformance/mips/corpus/spec-microprograms');

const zeroWord = '0x00000000';

function expectedGpr(nonzero: Readonly<Record<number, string>>): string[] {
  return Array.from({ length: 32 }, (_, index) => nonzero[index] ?? zeroWord);
}

const fullStackCases = [
  {
    file: 'p3-arith', profile: 'P3', haltPc: 0x3020, instructions: 9,
    segments: [{
      name: 'text', baseAddress: 0x3000,
      words: [
        0x00004020, 0x34091234, 0x3c0a1234, 0x012a5820, 0x01496022,
        0x014a6820, 0x00097022, 0x00000000, 0x1000ffff, 0x00000000
      ]
    }],
    gpr: {
      9: '0x00001234', 10: '0x12340000', 11: '0x12341234',
      12: '0x1233edcc', 13: '0x24680000', 14: '0xffffedcc'
    },
    dataWords: [], hi: zeroWord, lo: zeroWord, hiDefined: false, loDefined: false
  },
  {
    file: 'p4-control', profile: 'P4', haltPc: 0x301c, instructions: 6,
    segments: [{
      name: 'text', baseAddress: 0x3000,
      words: [
        0x34080001, 0x0c000c03, 0x340fdead, 0x37e90000, 0x11080001,
        0x340adead, 0x340b0007, 0x1000ffff, 0x00000000
      ]
    }],
    gpr: { 8: '0x00000001', 9: '0x00003008', 11: '0x00000007', 31: '0x00003008' },
    dataWords: [], hi: zeroWord, lo: zeroWord, hiDefined: false, loDefined: false
  },
  {
    file: 'p5-delay-link', profile: 'P5', haltPc: 0x3024, instructions: 9,
    segments: [{
      name: 'text', baseAddress: 0x3000,
      words: [
        0x34080001, 0x0c000c04, 0x34090002, 0x340fdead, 0x03e05021,
        0x11080002, 0x340b0003, 0x340cdead, 0x340d0005, 0x1000ffff,
        0x00000000
      ]
    }],
    gpr: {
      8: '0x00000001', 9: '0x00000002', 10: '0x0000300c',
      11: '0x00000003', 13: '0x00000005', 31: '0x0000300c'
    },
    dataWords: [], hi: zeroWord, lo: zeroWord, hiDefined: false, loDefined: false
  },
  {
    file: 'p6-byte-mdu', profile: 'P6', haltPc: 0x3050, instructions: 22,
    segments: [{
      name: 'text', baseAddress: 0x3000,
      words: [
        0x3c0880ff, 0x35087f01, 0xac080000, 0x80090000, 0x800a0001,
        0x800b0002, 0x840c0002, 0x340d00aa, 0xa00d0001, 0x340e1234,
        0xa40e0002, 0x8c0f0000, 0x34100006, 0x2011fffd, 0x02110018,
        0x00009010, 0x00009812, 0x0230001a, 0x0000a010, 0x0000a812,
        0x1000ffff, 0x00000000
      ]
    }],
    gpr: {
      8: '0x80ff7f01', 9: '0x00000001', 10: '0x0000007f', 11: '0xffffffff',
      12: '0xffff80ff', 13: '0x000000aa', 14: '0x00001234', 15: '0x1234aa01',
      16: '0x00000006', 17: '0xfffffffd', 18: '0xffffffff', 19: '0xffffffee',
      20: '0xfffffffd'
    },
    dataWords: [{ address: '0x00000000', value: '0x1234aa01' }],
    hi: '0xfffffffd', lo: zeroWord, hiDefined: true, loDefined: true
  },
  {
    file: 'p7-cp0-exception', profile: 'P7', haltPc: 0x3010, instructions: 11,
    segments: [
      {
        name: 'text', baseAddress: 0x3000,
        words: [0x3c087fff, 0x3508ffff, 0x21090001, 0x340a0002, 0x1000ffff, 0x00000000]
      },
      {
        name: 'ktext', baseAddress: 0x4180,
        words: [0x401a6800, 0x401b7000, 0x237b0004, 0x409b7000, 0x42000018, 0x340bdead]
      }
    ],
    gpr: {
      8: '0x7fffffff', 10: '0x00000002', 26: '0x00000030', 27: '0x0000300c'
    },
    dataWords: [], hi: zeroWord, lo: zeroWord, hiDefined: false, loDefined: false,
    cp0: { status: zeroWord, cause: '0x00000030', epc: '0x0000300c' }
  }
] as const;

describe('TS assembler -> TS executor full-stack lane', () => {
  it('executes initialized data directives from the assembled image', () => {
    const assembled = assembleCourseSource({ id: 'root', text: [
      '.data',
      'value:',
      '    .word 0x12345678',
      '.text',
      '    lw $t0, value',
      '_halt:',
      '    beq $0, $0, _halt',
      '    nop'
    ].join('\n') }, { profile: 'P3' });
    expect(assembled.ok).toBe(true);
    const image = assembled.image!;
    const executed = executeProgramForService({
      profile: 'P3',
      segments: image.segments,
      entryPc: image.entryPc,
      haltPc: 0x3008,
      maxSteps: 128,
      enabledLayers: ['required', 'commonExtensions', 'marsCompatibility']
    });
    expect(executed.status).toBe('halted');
    expect(executed.finalState.gpr[8]).toBe('0x12345678');
  });

  it('executes an include macro with eqv, pseudo, data, and runtime source provenance', async () => {
    const rootText = [
      '.include "lib.asm"',
      '.text',
      'main:',
      '    update()',
      '    lw $t1, result',
      '_halt:',
      '    beq $0, $0, _halt',
      '    nop'
    ].join('\n');
    const libraryText = [
      '.eqv DEST $t0',
      '.eqv INCREMENT 1',
      '.data',
      'value:',
      '    .word 0x12345678',
      'result:',
      '    .word 0',
      '.macro update()',
      '    lw DEST, value',
      '    li $t2, INCREMENT',
      '    addu DEST, DEST, $t2',
      '    sw DEST, result',
      '.end_macro'
    ].join('\n');
    const assembled = assembleCourseSource({ id: 'root', text: rootText }, {
      profile: 'P3',
      sourceResolver: {
        resolve: ({ parentId, specifier }) => parentId === 'root' && specifier === 'lib.asm'
          ? { id: 'lib', text: libraryText }
          : undefined
      }
    });
    expect(assembled.ok).toBe(true);
    expect(assembled.diagnostics).toEqual([]);
    const image = assembled.image!;
    expect(image.inputGraph.map((unit) => unit.id)).toEqual(['root', 'lib']);
    expect(image.segments.find((segment) => segment.name === 'text')?.words).toEqual([
      0x3c010000, 0x8c280000, 0x240a0001, 0x010a4021, 0x3c010000,
      0xac280004, 0x3c010000, 0x8c290004, 0x1000ffff, 0x00000000
    ]);
    const data = image.segments.find((segment) => segment.name === 'data')!;
    expect(data.words).toHaveLength(1024);
    expect(data.words.slice(0, 2)).toEqual([0x12345678, 0x00000000]);

    const macroWords = image.sourceMap.filter((entry) => entry.segmentIndex === 0 && entry.wordIndex <= 5);
    expect(macroWords).toHaveLength(6);
    expect(macroWords.every((entry) => entry.sourceId === 'lib')).toBe(true);
    expect(macroWords.map((entry) => entry.expansionStack?.map((span) => span.startOffset))).toEqual(
      Array.from({ length: 6 }, () => [rootText.indexOf('    update()'), rootText.indexOf('.include')])
    );
    expect(sourceMapEntryForAddress(image, 0)?.entry).toMatchObject({
      sourceId: 'lib',
      startOffset: libraryText.indexOf('    .word 0x12345678')
    });

    const executed = await executeProgramForServiceAsync({
      profile: 'P3',
      segments: image.segments,
      entryPc: image.entryPc,
      haltPc: 0x3020,
      maxSteps: 64,
      enabledLayers: ['required', 'commonExtensions', 'marsCompatibility']
    });
    expect(executed.status).toBe('halted');
    expect(executed.haltReason).toBe('course-halt-loop');
    expect(executed.finalState.gpr[8]).toBe('0x12345679');
    expect(executed.finalState.gpr[9]).toBe('0x12345679');
    expect(executed.finalState.gpr[10]).toBe('0x00000001');
    expect(executed.finalState.dataWords).toEqual([
      { address: '0x00000000', value: '0x12345678' },
      { address: '0x00000004', value: '0x12345679' }
    ]);

    const storeEvent = executed.events.find((event) => event.memoryWrites.some((write) => write.wordAddress === 4));
    expect(storeEvent).toBeDefined();
    const mapped = commitEventSourceMap(image, storeEvent!);
    expect(mapped.instruction?.entry).toMatchObject({
      sourceId: 'lib',
      startOffset: libraryText.indexOf('    sw DEST, result')
    });
    expect(mapped.instruction?.entry.expansionStack?.map((span) => span.startOffset))
      .toEqual([rootText.indexOf('    update()'), rootText.indexOf('.include')]);
    expect(mapped.memoryWrites[0]?.entry).toMatchObject({
      sourceId: 'lib',
      startOffset: libraryText.lastIndexOf('    .word 0')
    });
  });

  for (const fixture of fullStackCases) {
    it(`assembles exact machine code and final state for ${fixture.profile}`, () => {
      const asm = fs.readFileSync(path.join(corpusRoot, `${fixture.file}.asm`), 'utf8');
      const assembled = assembleCourseSource({ id: 'root', text: asm }, { profile: fixture.profile });
      expect(assembled.ok).toBe(true);
      const image = assembled.image!;
      expect(image.segments.map((segment) => ({
        name: segment.name,
        baseAddress: segment.baseAddress,
        words: [...segment.words]
      }))).toEqual(fixture.segments);
      const haltPc = findCourseHaltPc(image, fixture.profile);
      expect(haltPc).toBe(fixture.haltPc);
      const executed = executeProgramForService({
        profile: fixture.profile,
        segments: image.segments,
        entryPc: image.entryPc,
        haltPc,
        maxSteps: 4096,
        enabledLayers: ['required', 'commonExtensions', 'marsCompatibility']
      });
      expect(executed.status).toBe('halted');
      expect(executed.haltReason).toBe('course-halt-loop');
      expect(executed.instructions).toBe(fixture.instructions);
      expect(executed.eventCount).toBe(fixture.instructions);
      expect(executed.haltPc).toBe(`0x${fixture.haltPc.toString(16).padStart(8, '0')}`);
      expect(executed.diagnostic).toBeUndefined();
      expect(executed.finalState).toEqual({
        pc: `0x${fixture.haltPc.toString(16).padStart(8, '0')}`,
        gpr: expectedGpr(fixture.gpr),
        hi: fixture.hi,
        lo: fixture.lo,
        hiDefined: fixture.hiDefined,
        loDefined: fixture.loDefined,
        ...('cp0' in fixture ? { cp0: fixture.cp0 } : {}),
        dataWords: fixture.dataWords
      });
    });
  }
});
