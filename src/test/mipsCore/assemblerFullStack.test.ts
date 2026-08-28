import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { findCourseHaltPc } from '../../mips/core/assembler/artifacts';
import { executeProgramForService } from '../../mips/core/machine/executeService';

const corpusRoot = path.resolve(process.cwd(), 'conformance/mips/corpus/spec-microprograms');

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

  for (const file of ['p3-arith', 'p5-delay-link', 'p6-byte-mdu', 'p7-cp0-exception']) {
    it(`assembles and halts ${file} without MARS`, () => {
      const profile = `P${file.slice(1, 2)}` as 'P3';
      const asm = fs.readFileSync(path.join(corpusRoot, `${file}.asm`), 'utf8');
      const assembled = assembleCourseSource({ id: 'root', text: asm }, { profile });
      expect(assembled.ok).toBe(true);
      const image = assembled.image!;
      const haltPc = findCourseHaltPc(image, profile);
      expect(haltPc).toBeDefined();
      const executed = executeProgramForService({
        profile,
        segments: image.segments,
        entryPc: image.entryPc,
        haltPc,
        maxSteps: 4096,
        enabledLayers: ['required', 'commonExtensions', 'marsCompatibility']
      });
      expect(executed.status).toBe('halted');
      expect(executed.haltReason).toBe('course-halt-loop');
      expect(executed.diagnostic).toBeUndefined();
    });
  }
});
