import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  logisimPrepSummary,
  preparedCircuitFileName,
  sanitizeFileStem
} from '../../courseTesting/logisimPrep';

describe('Logisim preparation helpers', () => {
  it('summarizes prepared and failed cases', () => {
    expect(logisimPrepSummary([
      { asm: 'a.asm', status: 'prepared', message: 'ok' },
      { asm: 'b.asm', status: 'error', message: 'bad' },
      { asm: 'c.asm', status: 'prepared', message: 'ok' }
    ])).toEqual({
      total: 3,
      prepared: 2,
      errors: 1
    });
  });

  it('builds stable prepared circuit names from relative ASM paths', () => {
    const root = path.join('E:', 'VSCode', 'BUAA-CO', 'p3');
    const circuit = path.join(root, 'cpu.circ');
    const asm = path.join(root, 'generated', 'case 01.asm');

    expect(preparedCircuitFileName(circuit, asm, root)).toBe('cpu.generated_case_01.circ');
  });

  it('sanitizes non-file-safe stems', () => {
    expect(sanitizeFileStem('p3/generated case #1.asm')).toBe('p3_generated_case_1');
    expect(sanitizeFileStem('***')).toBe('case');
  });
});
