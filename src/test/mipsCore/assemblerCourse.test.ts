import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { findCourseHaltPc } from '../../mips/core/assembler/artifacts';
import { programImageIssues } from '../../mips/replay/programImage';
import { commitEventSourceMap, sourceMapEntryForAddress } from '../../mips/core/assembler/sourceMap';

const corpusRoot = path.resolve(process.cwd(), 'conformance/mips/corpus/spec-microprograms');

interface WordImage {
  text?: string[];
  ktext?: string[];
  data?: string[];
}

const golden: Record<string, WordImage> = {
  'p3-arith': {
    text: ['00004020', '34091234', '3c0a1234', '012a5820', '01496022', '014a6820', '00097022', '00000000', '1000ffff', '00000000']
  },
  'p3-boundaries': {
    text: ['3c088000', '01084820', '340affff', '010a5820', '000a6022', 'ac0b2ffc', '8c0d2ffc', '116d0001', '340edead', '340f0001', '1000ffff', '00000000']
  },
  'p3-branch': {
    text: ['34080003', '11000006', '34090001', '01094022', '01094022', '01094022', '11000001', '340a0063', '340b0007', '3c0c0001', '1000ffff', '00000000']
  },
  'p3-memory': {
    text: ['340800ff', 'ac080000', 'ac082ffc', '8c090000', '8c0a2ffc', '340b5aa5', 'ac0b1004', '8c0c1004', '018c6822', '1000ffff', '00000000']
  },
  'p4-control': {
    text: ['34080001', '0c000c03', '340fdead', '37e90000', '11080001', '340adead', '340b0007', '1000ffff', '00000000']
  },
  'p5-delay-link': {
    text: ['34080001', '0c000c04', '34090002', '340fdead', '03e05021', '11080002', '340b0003', '340cdead', '340d0005', '1000ffff', '00000000']
  },
  'p6-byte-mdu': {
    text: [
      '3c0880ff', '35087f01', 'ac080000', '80090000', '800a0001', '800b0002',
      '840c0002', '340d00aa', 'a00d0001', '340e1234', 'a40e0002', '8c0f0000',
      '34100006', '2011fffd', '02110018', '00009010', '00009812', '0230001a',
      '0000a010', '0000a812', '1000ffff', '00000000'
    ]
  },
  'p7-cp0-exception': {
    text: ['3c087fff', '3508ffff', '21090001', '340a0002', '1000ffff', '00000000'],
    ktext: ['401a6800', '401b7000', '237b0004', '409b7000', '42000018', '340bdead']
  },
  'p7-external-irq': {
    text: ['34081001', '40886000', '34090001', '25290001', '1000fffe', '00000000'],
    ktext: ['a0007f20', '401a6800', '42000018', '00000000']
  },
  'p7-timer': {
    text: ['34080003', 'ac087f04', '34080009', 'ac087f00', '34090401', '40896000', '1000ffff', '00000000'],
    ktext: ['ac007f00', '401a6800', '42000018', '00000000']
  }
};

describe('course assembler corpus goldens', () => {
  for (const [file, expected] of Object.entries(golden)) {
    it(`assembles ${file} byte-for-byte with the pinned MARS text image`, () => {
      const asm = fs.readFileSync(path.join(corpusRoot, `${file}.asm`), 'utf8');
      const result = assembleCourseSource({ id: 'root', text: asm }, { profile: `P${file.slice(1, 2)}` as 'P3' });
      expect(result.ok).toBe(true);
      expect(result.diagnostics).toEqual([]);
      const image = result.image!;
      expect(programImageIssues(image)).toEqual([]);
      if (expected.text) {
        expect(image.segments.find((segment) => segment.name === 'text')?.words.map((word) => word.toString(16).padStart(8, '0')))
          .toEqual(expected.text);
      }
      if (expected.ktext) {
        expect(image.segments.find((segment) => segment.name === 'ktext')?.words.map((word) => word.toString(16).padStart(8, '0')))
          .toEqual(expected.ktext);
      }
      if (file === 'p7-external-irq') {
        expect(findCourseHaltPc(image, 'P7')).toBeUndefined();
      } else {
        expect(findCourseHaltPc(image, `P${file.slice(1, 2)}` as 'P3')).toBeDefined();
      }
    });
  }
});

describe('course assembler directives and pseudo', () => {
  it('matches MARS data-image block padding and pseudo expansion', () => {
    const asm = [
      '.data',
      '    .align 2',
      'value:',
      '    .word 0x12345678, 0xabcdef01',
      '    .byte 1, 2, 3, 4',
      '    .half 0xabcd',
      '    .ascii "hi"',
      '    .asciiz "yo"',
      '.text',
      'main:',
      '    li $t0, -1',
      '    la $t1, value',
      '    lw $t2, value',
      '    sw $t2, value',
      '    beq $t0, $t0, main',
      '    nop'
    ].join('\n');
    const result = assembleCourseSource({ id: 'root', text: asm }, { profile: 'P3' });
    expect(result.ok).toBe(true);
    const data = result.image!.segments.find((segment) => segment.name === 'data');
    expect(data?.words).toHaveLength(1024);
    expect(data!.words[0].toString(16).padStart(8, '0')).toBe('12345678');
    expect(data!.words[4].toString(16).padStart(8, '0')).toBe('00006f79');
    const text = result.image!.segments.find((segment) => segment.name === 'text')!;
    expect(text.words[0].toString(16).padStart(8, '0')).toBe('2408ffff');
  });

  it('fixes a data label when the following directive auto-aligns it', () => {
    const asm = [
      '.data',
      '    .byte 1',
      'label:',
      '    .word 0x12345678',
      '.text',
      '    la $t0, label',
      '    nop'
    ].join('\n');
    const result = assembleCourseSource({ id: 'root', text: asm }, { profile: 'P3' });
    expect(result.ok).toBe(true);
    expect(result.image!.symbols.find((symbol) => symbol.name === 'label')?.value).toBe(4);
    expect(result.image!.segments.find((segment) => segment.name === 'text')!.words[0].toString(16).padStart(8, '0')).toBe('3c010000');
    expect(result.image!.segments.find((segment) => segment.name === 'text')!.words[1].toString(16).padStart(8, '0')).toBe('34280004');
  });

  it('expands .macro calls with unique local labels', () => {
    const asm = [
      '.macro forward(%n)',
      '    addiu $t0, $0, %n',
      'loop:',
      '    beq $t0, $0, loop',
      '    nop',
      '.end_macro',
      '.text',
      'main:',
      '    forward(1)',
      '    forward(2)'
    ].join('\n');
    const result = assembleCourseSource({ id: 'root', text: asm }, { profile: 'P5' });
    expect(result.ok).toBe(true);
    const words = result.image!.segments.find((segment) => segment.name === 'text')!.words;
    expect(words.map((word) => word.toString(16).padStart(8, '0'))).toEqual([
      '24080001', '1100ffff', '00000000',
      '24080002', '1100ffff', '00000000'
    ]);
    expect(result.image!.sourceMap.slice(0, 2).every((entry) => entry.expansionStack?.length === 1)).toBe(true);
  });

  it('preprocesses includes with the pure source resolver', () => {
    const result = assembleCourseSource(
      { id: 'root', text: '.include "lib.asm"\n.text\n    ori $t0, $0, 1\n' },
      {
        profile: 'P3',
        sourceResolver: {
          resolve: () => ({ id: 'lib', text: '    ori $t1, $0, 0x55\n' })
        }
      }
    );
    expect(result.ok).toBe(true);
    expect(result.image!.inputGraph.map((unit) => unit.id)).toEqual(['root', 'lib']);
  });

  it('distinguishes bare CP0 numbers from ordinary immediate operands', () => {
    const asm = [
      '.text',
      '    ori $1, $0, 12',
      '    mfc0 $t0, 12',
      '    mtc0 $t0, 12',
      '    andi $t1, $0, -1024',
      '    xori $t2, $0, -4'
    ].join('\n');
    const result = assembleCourseSource({ id: 'root', text: asm }, { profile: 'P7' });
    expect(result.ok).toBe(true);
    const words = result.image!.segments.find((segment) => segment.name === 'text')!.words;
    expect(words[0].toString(16).padStart(8, '0')).toBe('3401000c');
    expect(words[1].toString(16).padStart(8, '0')).toBe('40086000');
    expect(words[2].toString(16).padStart(8, '0')).toBe('40886000');
    // Negative logical immediates use the MARS lui/ori/$at expansion.
    expect(words.slice(3).map((word) => word.toString(16).padStart(8, '0'))).toEqual([
      '3c01ffff', '3421fc00', '00014824',
      '3c01ffff', '3421fffc', '00015026'
    ]);
  });

  it('injects raw RI words in text and ktext instruction segments', () => {
    const asm = [
      '.text',
      'main:',
      '    .word 0xfc000000, 0x0000003f',
      '    .word main+4',
      '    ori $t0, $0, 1',
      '    nop',
      '.ktext 0x4180',
      '    .word 0xfc000000',
      '    .word 0x0000003f'
    ].join('\n');
    const result = assembleCourseSource({ id: 'root', text: asm }, { profile: 'P7' });
    expect(result.ok).toBe(true);
    expect(result.image!.segments.find((segment) => segment.name === 'text')!.words.map((word) => word.toString(16).padStart(8, '0')))
      .toEqual(['fc000000', '0000003f', '00003004', '34080001', '00000000']);
    expect(result.image!.segments.find((segment) => segment.name === 'ktext')!.words.map((word) => word.toString(16).padStart(8, '0')))
      .toEqual(['fc000000', '0000003f']);
    expect(result.image!.sourceMap).toHaveLength(7);
  });

  it('maps TS/TS CommitEvent PCs and memory writes back to source origins', () => {
    const asm = [
      '.data',
      'value:',
      '    .word 0x11223344',
      '.text',
      'main:',
      '    lw $t0, value',
      '_halt:',
      '    beq $0, $0, _halt',
      '    nop'
    ].join('\n');
    const result = assembleCourseSource({ id: 'root', text: asm }, { profile: 'P3' });
    expect(result.ok).toBe(true);
    const image = result.image!;
    const instruction = sourceMapEntryForAddress(image, 0x3000)!;
    expect(instruction.entry.sourceId).toBe('root');
    expect(instruction.entry.startOffset).toBeGreaterThan(0);
    expect(instruction.word.toString(16).padStart(8, '0')).toBe('3c010000');

    const load = sourceMapEntryForAddress(image, 0x3004)!;
    expect(load.word.toString(16).padStart(8, '0')).toBe('8c280000');
    expect(commitEventSourceMap(image, {
      sequence: 1,
      kind: 'instruction',
      pcBefore: 0x3000,
      pcAfter: 0x3004,
      gprWrites: [],
      hiLoWrites: [],
      cp0Writes: [],
      memoryWrites: [{ address: 0, value: 0x11223344, byteMask: 0, wordAddress: 0, valueBefore: 0, valueAfter: 0x11223344, region: 'data' }],
      deviceEvents: []
    }).memoryWrites).toHaveLength(1);
  });

  it('keeps the historical P7 generator RI victim mnemonic for replay compatibility', () => {
    const asm = '_co_internal_unknown_instruction\n.text\n    beq $0, $0, end\n    nop\nend:\n    nop\n';
    const result = assembleCourseSource({ id: 'root', text: asm }, { profile: 'P7', p7RiInstruction: true });
    expect(result.ok).toBe(true);
    // First line is parsed as text (default section), so word 0 is the RI cell.
    expect(result.image!.segments.find((segment) => segment.name === 'text')!.words[0].toString(16).padStart(8, '0')).toBe('0000003f');
  });

  it('applies nested MARS-style .eqv substitutions to registers and pseudo operands', () => {
    const asm = [
      '.eqv DEST $t0',
      '.eqv VALUE NEXT_VALUE',
      '.eqv NEXT_VALUE -1',
      '.text',
      '    li DEST, VALUE'
    ].join('\n');
    const result = assembleCourseSource({ id: 'root', text: asm }, { profile: 'P3' });
    expect(result.ok).toBe(true);
    expect(result.image!.segments.find((segment) => segment.name === 'text')!.words)
      .toEqual([0x2408ffff]);
    expect(result.image!.symbols.find((symbol) => symbol.name === 'DEST')).toBeUndefined();
    expect(result.image!.symbols.find((symbol) => symbol.name === 'VALUE')?.value).toBe(-1);
  });

  it('keeps explicit text cursors absolute across forward holes and ktext switches', () => {
    const asm = [
      '.text 0x3010',
      '    ori $t0, $0, 1',
      '.ktext 0x4180',
      '    eret',
      '.text',
      '    ori $t1, $0, 2'
    ].join('\n');
    const result = assembleCourseSource({ id: 'root', text: asm }, { profile: 'P7' });
    expect(result.ok).toBe(true);
    const text = result.image!.segments.find((segment) => segment.name === 'text')!;
    const ktext = result.image!.segments.find((segment) => segment.name === 'ktext')!;
    expect(text.baseAddress).toBe(0x3000);
    expect(text.words).toEqual([0, 0, 0, 0, 0x34080001, 0x34090002]);
    expect(ktext.baseAddress).toBe(0x4180);
    expect(ktext.words).toEqual([0x42000018]);
    expect(result.image!.sourceMap.filter((entry) => entry.segmentIndex === 0).map((entry) => entry.wordIndex))
      .toEqual([4, 5]);
  });
});

describe('course assembler source provenance', () => {
  it('keeps source offsets in the original BOM-prefixed source', () => {
    const asm = '\ufeff.text\n    ori $t0, $0, 1\n';
    const result = assembleCourseSource({ id: 'root', text: asm }, { profile: 'P3' });
    expect(result.ok).toBe(true);
    expect(result.image!.sourceMap[0]).toMatchObject({
      sourceId: 'root',
      startOffset: asm.indexOf('    ori')
    });
  });

  it('retains every nested include frame from leaf to root', () => {
    const units = new Map([
      ['a', { id: 'a', text: '.include "b.asm"\n' }],
      ['b', { id: 'b', text: '.text\n    ori $t0, $0, 1\n' }]
    ]);
    const result = assembleCourseSource(
      { id: 'root', text: '.include "a.asm"\n' },
      {
        profile: 'P3',
        sourceResolver: {
          resolve: ({ specifier }) => units.get(specifier === 'a.asm' ? 'a' : specifier === 'b.asm' ? 'b' : '')
        }
      }
    );
    expect(result.ok).toBe(true);
    expect(result.image!.sourceMap[0].sourceId).toBe('b');
    expect(result.image!.sourceMap[0].expansionStack?.map((span) => span.sourceId))
      .toEqual(['a', 'root']);
  });

  it('retains outer macro calls through nested macros and oversized pseudo expansion', () => {
    const asm = [
      '.macro inner()',
      '    ori $t0, $0, 0x12345678',
      '.end_macro',
      '.macro outer()',
      '    inner()',
      '.end_macro',
      '.text',
      '    outer()'
    ].join('\n');
    const result = assembleCourseSource({ id: 'root', text: asm }, { profile: 'P6' });
    expect(result.ok).toBe(true);
    expect(result.image!.sourceMap).toHaveLength(3);
    const expectedFrames = [asm.indexOf('    inner()'), asm.lastIndexOf('    outer()')];
    for (const entry of result.image!.sourceMap) {
      expect(entry.startOffset).toBe(asm.indexOf('    ori'));
      expect(entry.expansionStack?.map((span) => span.startOffset)).toEqual(expectedFrames);
    }
  });
});

describe('course assembler fail-closed diagnostics', () => {
  it('never returns an executable image for an erroneous program', () => {
    const result = assembleCourseSource({ id: 'root', text: '.text\n    nope $t0\n' }, { profile: 'P3' });
    expect(result.ok).toBe(false);
    expect(result.image).toBeUndefined();
    expect(result.diagnostics[0]?.code).toMatch(/^asm\./);
  });

  it('reports segment overlap for text reaching the P7 handler region', () => {
    const makeLines = (textNops: number): string[] => {
      const lines = ['.text'];
      for (let index = 0; index < textNops; index++) lines.push('    nop');
      lines.push('.ktext 0x4180');
      lines.push('    eret');
      return lines;
    };
    // 1120 nops occupy 0x3000..0x417c, the last non-overlapping user word.
    const nonOverlap = assembleCourseSource({ id: 'root', text: makeLines(1120).join('\n') }, { profile: 'P7' });
    expect(nonOverlap.ok).toBe(true);
    // One more user nop reaches 0x4180, where the kernel segment begins.
    const overlap = assembleCourseSource({ id: 'root', text: makeLines(1121).join('\n') }, { profile: 'P7' });
    expect(overlap.ok).toBe(false);
    expect(overlap.diagnostics.some((diagnostic) => diagnostic.code === 'asm.section.segment-overlap')).toBe(true);
  });

  it('reports recursive includes', () => {
    const result = assembleCourseSource(
      { id: 'root', text: '.include "self.asm"\n' },
      {
        profile: 'P3',
        sourceResolver: { resolve: () => ({ id: 'root', text: '.include "self.asm"\n' }) },
        sourceLimits: { maxDepth: 2, maxUnits: 4, maxBytes: 1024 }
      }
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'asm.include.cycle')).toBe(true);
  });

  it('enforces include depth and source-byte limits independently', () => {
    const root = { id: 'root', text: '.include "a.asm"\n' };
    const units = new Map([
      ['a.asm', { id: 'a', text: '.include "b.asm"\n' }],
      ['b.asm', { id: 'b', text: '.text\n    nop\n' }]
    ]);
    const sourceResolver = {
      resolve: ({ specifier }: { specifier: string }) => units.get(specifier)
    };

    const tooDeep = assembleCourseSource(root, {
      profile: 'P3',
      sourceResolver,
      sourceLimits: { maxDepth: 1, maxUnits: 4, maxBytes: 1024 }
    });
    expect(tooDeep.ok).toBe(false);
    expect(tooDeep.image).toBeUndefined();
    expect(tooDeep.diagnostics.some((diagnostic) => diagnostic.code === 'asm.include.too-deep')).toBe(true);

    const tooManyBytes = assembleCourseSource(root, {
      profile: 'P3',
      sourceResolver,
      sourceLimits: { maxDepth: 4, maxUnits: 4, maxBytes: root.text.length }
    });
    expect(tooManyBytes.ok).toBe(false);
    expect(tooManyBytes.image).toBeUndefined();
    expect(tooManyBytes.diagnostics.some((diagnostic) => diagnostic.code === 'asm.limit.source-bytes')).toBe(true);
  });

  it('enforces macro recursion and total expansion limits', () => {
    const recursive = assembleCourseSource({
      id: 'root',
      text: [
        '.macro recurse()',
        '    recurse()',
        '.end_macro',
        '.text',
        '    recurse()'
      ].join('\n')
    }, { profile: 'P3' });
    expect(recursive.ok).toBe(false);
    expect(recursive.image).toBeUndefined();
    expect(recursive.diagnostics.some((diagnostic) => diagnostic.code === 'asm.macro.recursion-limit')).toBe(true);

    const expansion = assembleCourseSource({
      id: 'root',
      text: [
        '.macro pair()',
        '    nop',
        '    nop',
        '.end_macro',
        '.text',
        '    pair()'
      ].join('\n')
    }, { profile: 'P3', maximumExpandedInstructions: 1 });
    expect(expansion.ok).toBe(false);
    expect(expansion.image).toBeUndefined();
    expect(expansion.diagnostics.some((diagnostic) => diagnostic.code === 'asm.macro.expansion-limit')).toBe(true);
  });

  it('accepts the final text word and rejects one word beyond segment capacity', () => {
    const sourceWithNops = (count: number) => ({
      id: 'root',
      text: ['.text', ...Array.from({ length: count }, () => '    nop')].join('\n')
    });
    const full = assembleCourseSource(sourceWithNops(4096), { profile: 'P3' });
    expect(full.ok).toBe(true);
    expect(full.image!.segments.find((segment) => segment.name === 'text')?.words).toHaveLength(4096);

    const overflow = assembleCourseSource(sourceWithNops(4097), { profile: 'P3' });
    expect(overflow.ok).toBe(false);
    expect(overflow.image).toBeUndefined();
    expect(overflow.diagnostics.some((diagnostic) => diagnostic.code === 'asm.section.outside-course-address-space')).toBe(true);
  });

  it('validates the profile and enabled layer of every final real instruction', () => {
    const p3Jr = assembleCourseSource({ id: 'root', text: '.text\n    jr $ra\n' }, { profile: 'P3' });
    expect(p3Jr.ok).toBe(false);
    expect(p3Jr.diagnostics.some((diagnostic) => diagnostic.code === 'asm.instruction.profile-unsupported')).toBe(true);

    const p3Blt = assembleCourseSource({
      id: 'root',
      text: '.text\n    blt $t0, $t1, target\ntarget:\n    nop\n'
    }, { profile: 'P3' });
    expect(p3Blt.ok).toBe(false);
    expect(p3Blt.diagnostics.some((diagnostic) => diagnostic.code === 'asm.instruction.profile-unsupported')).toBe(true);

    const requiredOnlyLi = assembleCourseSource(
      { id: 'root', text: '.text\n    li $t0, -1\n' },
      { profile: 'P3', layers: ['required'] }
    );
    expect(requiredOnlyLi.ok).toBe(false);
    expect(requiredOnlyLi.diagnostics.some((diagnostic) => diagnostic.code === 'asm.instruction.layer-unsupported')).toBe(true);
  });

  it('rejects integer and pseudo magnitudes with trailing junk', () => {
    for (const instruction of ['ori $t0, $0, 0x12junk', 'li $t0, 0x12junk']) {
      const result = assembleCourseSource({ id: 'root', text: `.text\n    ${instruction}\n` }, { profile: 'P3' });
      expect(result.ok, instruction).toBe(false);
      expect(result.image, instruction).toBeUndefined();
    }
  });

  it('uses signed 32-bit expression results and left-associative shifts', () => {
    const result = assembleCourseSource({
      id: 'root',
      text: [
        '.data',
        '    .word 16 << 1 >> 2',
        '.text',
        '    addi $t0, $0, 0x7fffffff + 0x80000000'
      ].join('\n')
    }, { profile: 'P6' });
    expect(result.ok).toBe(true);
    expect(result.image!.segments.find((segment) => segment.name === 'data')!.words[0]).toBe(8);
    expect(result.image!.segments.find((segment) => segment.name === 'text')!.words[0].toString(16).padStart(8, '0'))
      .toBe('2008ffff');
  });

  it('classifies direct and nested undefined symbols consistently', () => {
    const direct = assembleCourseSource(
      { id: 'root', text: '.text\n    ori $t0, $0, MISSING\n' },
      { profile: 'P3' }
    );
    expect(direct.ok).toBe(false);
    expect(direct.diagnostics.some((diagnostic) => diagnostic.code === 'asm.symbol.undefined')).toBe(true);

    const nestedEqv = assembleCourseSource(
      { id: 'root', text: '.eqv BROKEN MISSING\n.text\n    ori $t0, $0, BROKEN\n' },
      { profile: 'P3' }
    );
    expect(nestedEqv.ok).toBe(false);
    expect(nestedEqv.diagnostics.some((diagnostic) => diagnostic.code === 'asm.symbol.undefined')).toBe(true);
    expect(nestedEqv.diagnostics.some((diagnostic) => diagnostic.code === 'asm.symbol.eqv-cycle')).toBe(false);
  });
});
