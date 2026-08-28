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
      '    beq $t0, -1, main',
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

  it('injects raw .word data in .text as the future RI test-point extension', () => {
    const asm = [
      '.text',
      'main:',
      '    .word 0x12345678',
      '    .word 0xffffffff, 0x0000003f',
      '    .word main+4',
      '    ori $t0, $0, 1',
      '    nop'
    ].join('\n');
    const result = assembleCourseSource({ id: 'root', text: asm }, { profile: 'P7' });
    expect(result.ok).toBe(true);
    expect(result.image!.segments.find((segment) => segment.name === 'text')!.words.map((word) => word.toString(16).padStart(8, '0')))
      .toEqual(['12345678', 'ffffffff', '0000003f', '00003004', '34080001', '00000000']);
    expect(result.image!.sourceMap).toHaveLength(6);
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

  it('supports the P7 generator RI victim mnemonic', () => {
    const asm = '_co_internal_unknown_instruction\n.text\n    beq $0, $0, end\n    nop\nend:\n    nop\n';
    const result = assembleCourseSource({ id: 'root', text: asm }, { profile: 'P7', p7RiInstruction: true });
    expect(result.ok).toBe(true);
    // First line is parsed as text (default section), so word 0 is the RI cell.
    expect(result.image!.segments.find((segment) => segment.name === 'text')!.words[0].toString(16).padStart(8, '0')).toBe('0000003f');
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

  it('bounds include depth and source bytes', () => {
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
});
