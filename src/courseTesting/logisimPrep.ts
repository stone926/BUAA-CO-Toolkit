import * as path from 'path';
import { sanitizeFileStem as sanitizePathFileStem } from '../pathUtils';

export type LogisimPrepareStatus = 'prepared' | 'error';

export interface LogisimPrepareCaseResult {
  asm: string;
  caseId?: string;
  caseManifest?: string;
  asmSnapshot?: string;
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
  return sanitizePathFileStem(value, {
    stripExtension: true,
    fallback: 'case'
  });
}

function removeKnownAsmExtension(value: string): string {
  return value.replace(/\.(asm|s|mips)$/i, '');
}
