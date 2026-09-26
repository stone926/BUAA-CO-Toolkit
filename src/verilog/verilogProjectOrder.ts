// @index verilog-project-order — deterministic source ordering with generated files last
import { normalizePathKey } from '../pathUtils';

export interface VerilogFileLike {
  fsPath: string;
}

export function orderVerilogProjectFiles<T extends VerilogFileLike>(
  discoveredFiles: readonly T[],
  extraVerilogFiles: readonly T[] = []
): T[] {
  const extras = dedupe(extraVerilogFiles);
  const extraKeys = new Set(extras.map((file) => normalizePathKey(file.fsPath)));
  const ordinary = dedupe(discoveredFiles)
    .filter((file) => !extraKeys.has(normalizePathKey(file.fsPath)))
    .sort((left, right) => normalizePathKey(left.fsPath).localeCompare(normalizePathKey(right.fsPath)));
  return [...ordinary, ...extras];
}

function dedupe<T extends VerilogFileLike>(files: readonly T[]): T[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = normalizePathKey(file.fsPath);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
