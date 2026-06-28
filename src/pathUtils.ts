import * as path from 'path';
// @index orchestration — 纯路径归一化、去重和文件名清洗工具

export interface FsPathLike {
  fsPath: string;
}

export interface SanitizeFileStemOptions {
  fallback?: string;
  stripExtension?: boolean;
  trimOuterUnderscores?: boolean;
}

export function normalizePathKey(file: string): string {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function samePath(left: string, right: string): boolean {
  return normalizePathKey(left) === normalizePathKey(right);
}

export function dedupePaths<T extends string>(files: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const file of files) {
    const key = normalizePathKey(file);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(file);
  }
  return result;
}

export function dedupeUris<T extends FsPathLike>(files: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const uri of files) {
    const key = normalizePathKey(uri.fsPath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(uri);
  }
  return result;
}

export function sanitizeFileStem(value: string, options: SanitizeFileStemOptions = {}): string {
  const fallback = options.fallback ?? 'case';
  const withoutExtension = options.stripExtension
    ? value.replace(/\.[A-Za-z0-9]+$/, '')
    : value;
  const replaced = withoutExtension.replace(/[^A-Za-z0-9_-]+/g, '_');
  const trimmed = options.trimOuterUnderscores === false
    ? replaced
    : replaced.replace(/^_+|_+$/g, '');
  return trimmed || fallback;
}
