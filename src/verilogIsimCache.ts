import * as path from 'path';
import { sha256Bytes } from './asmCaseStoreCore';

export interface IsimCompileCache {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
  clear(): void;
}

export interface IsimCompileCacheKeyParts {
  workspaceRoot?: string;
  isePath: string;
  moduleName: string;
  testbenchKind: string;
  testbenchSource?: string;
  testbenchSha256?: string;
  projectSignature: string;
  tclText: string;
  debug: boolean;
}

export function createIsimCompileCache(): IsimCompileCache {
  return new Map<string, unknown>();
}

export function isimCompileCacheKey(parts: IsimCompileCacheKeyParts): string {
  return JSON.stringify({
    workspaceRoot: normalizeOptionalPath(parts.workspaceRoot),
    isePath: normalizeOptionalPath(parts.isePath),
    moduleName: parts.moduleName,
    testbenchKind: parts.testbenchKind,
    testbenchSource: normalizeOptionalPath(parts.testbenchSource),
    testbenchSha256: parts.testbenchSha256,
    projectSignature: parts.projectSignature,
    tclText: parts.tclText,
    debug: parts.debug
  });
}

export function isimCompileArtifactStem(moduleName: string, cacheKey: string): string {
  return `${safeFileStem(moduleName)}_${sha256Bytes(Buffer.from(cacheKey, 'utf8')).slice(0, 12)}`;
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  return value ? normalizePathKey(value) : undefined;
}

function safeFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_') || 'testbench';
}

function normalizePathKey(file: string): string {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
