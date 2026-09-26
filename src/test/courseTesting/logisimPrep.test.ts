import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  preparedCircuitFileName
} from '../../courseTesting/logisimPrep';

describe('Logisim preparation helpers', () => {

  it('builds stable prepared circuit names from relative ASM paths', () => {
    const root = path.join('E:', 'VSCode', 'BUAA-CO', 'p3');
    const circuit = path.join(root, 'cpu.circ');
    const asm = path.join(root, 'generated', 'case 01.asm');

    expect(preparedCircuitFileName(circuit, asm, root)).toBe('cpu.generated_case_01.circ');
  });

});
