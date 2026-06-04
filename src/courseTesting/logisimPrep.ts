import * as path from 'path';

export type LogisimPrepareStatus = 'prepared' | 'error';

export interface LogisimPrepareCaseResult {
  asm: string;
  status: LogisimPrepareStatus;
  message: string;
  machineCode?: string;
  circuit?: string;
  wordCount?: number;
}

export interface LogisimPrepareSummary {
  total: number;
  prepared: number;
  errors: number;
}

export function logisimPrepSummary(results: readonly LogisimPrepareCaseResult[]): LogisimPrepareSummary {
  return {
    total: results.length,
    prepared: results.filter((item) => item.status === 'prepared').length,
    errors: results.filter((item) => item.status === 'error').length
  };
}

export function preparedCircuitFileName(circuitFile: string, asmFile: string, root?: string): string {
  const circuitStem = path.basename(circuitFile, path.extname(circuitFile));
  const asmStem = root
    ? path.relative(root, asmFile)
    : path.basename(asmFile, path.extname(asmFile));
  return `${sanitizeFileStem(circuitStem)}.${sanitizeFileStem(removeKnownAsmExtension(asmStem))}.circ`;
}

export function sanitizeFileStem(value: string): string {
  return value
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'case';
}

function removeKnownAsmExtension(value: string): string {
  return value.replace(/\.(asm|s|mips)$/i, '');
}
