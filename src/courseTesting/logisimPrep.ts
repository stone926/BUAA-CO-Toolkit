// @index logisim-prep — 课程 Logisim 用例电路的稳定文件命名
import * as path from 'path';
import { sanitizeFileStem } from '../pathUtils';

export function preparedCircuitFileName(circuitFile: string, asmFile: string, root?: string): string {
  const circuitStem = path.basename(circuitFile, path.extname(circuitFile));
  const asmStem = root
    ? path.relative(root, asmFile)
    : path.basename(asmFile, path.extname(asmFile));
  return `${sanitizeLogisimFileStem(circuitStem)}.${sanitizeLogisimFileStem(removeKnownAsmExtension(asmStem))}.circ`;
}

function sanitizeLogisimFileStem(value: string): string {
  return sanitizeFileStem(value, {
    stripExtension: true,
    fallback: 'case'
  });
}

function removeKnownAsmExtension(value: string): string {
  return value.replace(/\.(asm|s|mips)$/i, '');
}
