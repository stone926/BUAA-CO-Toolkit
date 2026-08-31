// @index verilog-iverilog-compile-cache — 可取消的有界文件读取、内容指纹与路径碰撞保护
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { normalizePathKey } from '../pathUtils';

const fingerprintConcurrency = 8;

export interface FileFingerprint {
  path: string;
  bytes: number;
  sha256: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
}

export async function fingerprintDependencies(
  files: readonly string[],
  currentDirectFiles: readonly FileFingerprint[],
  signal?: AbortSignal
): Promise<FileFingerprint[]> {
  const directByPath = new Map(currentDirectFiles.map((file) => [file.path, file]));
  const resolvedFiles = files.map((file) => resolveCompilerPath(file, process.cwd()));
  const keys = normalizedPathKeysWithoutCollision(resolvedFiles);
  const dependencyOnly = [...new Map(resolvedFiles
    .map((file, index) => [keys[index], file] as const)
    .filter(([key]) => !directByPath.has(key))).entries()];
  const hashedDependencies = await mapWithConcurrency(
    dependencyOnly,
    fingerprintConcurrency,
    async ([key, file]) => [key, await fingerprintFile(file, signal)] as const,
    signal
  );
  const dependencyByPath = new Map(hashedDependencies);
  return keys.map((key) => {
    const fingerprint = directByPath.get(key) ?? dependencyByPath.get(key);
    if (!fingerprint) {
      throw new Error(`Missing dependency fingerprint for ${key}`);
    }
    return fingerprint;
  });
}

export async function fingerprintOrderedFiles(
  files: readonly string[],
  signal?: AbortSignal
): Promise<FileFingerprint[]> {
  const resolvedFiles = files.map((file) => resolveCompilerPath(file, process.cwd()));
  const keys = normalizedPathKeysWithoutCollision(resolvedFiles);
  const unique = [...new Map(resolvedFiles.map((file, index) => [keys[index], file])).entries()];
  const fingerprints = await mapWithConcurrency(
    unique,
    fingerprintConcurrency,
    async ([key, file]) => [key, await fingerprintFile(file, signal)] as const,
    signal
  );
  const byKey = new Map(fingerprints);
  return keys.map((key) => {
    const fingerprint = byKey.get(key);
    if (!fingerprint) {
      throw new Error(`Missing file fingerprint for ${key}`);
    }
    return fingerprint;
  });
}

function normalizedPathKeysWithoutCollision(files: readonly string[]): string[] {
  const exactByKey = new Map<string, string>();
  return files.map((file) => {
    const absolute = path.resolve(file);
    const key = normalizePathKey(absolute);
    const previous = exactByKey.get(key);
    if (previous !== undefined && previous !== absolute) {
      // NTFS directories can opt into case sensitivity. A lower-cased cache key
      // must never merge two distinct compiler inputs; disable caching instead.
      throw new Error(`Icarus inputs collide after Windows normalization: ${previous} / ${absolute}`);
    }
    exactByKey.set(key, absolute);
    return key;
  });
}

export async function fingerprintFile(file: string, signal?: AbortSignal): Promise<FileFingerprint> {
  throwIfAborted(signal);
  const absolute = path.resolve(file);
  const handle = await fs.promises.open(absolute, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error(`Icarus compile input is not a regular file: ${absolute}`);
    }
    const sha256 = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      throwIfAborted(signal);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      sha256.update(buffer);
    }
    const after = await handle.stat();
    throwIfAborted(signal);
    const pathAfter = await fs.promises.stat(absolute);
    if (!sameFileIdentity(before, after) || !sameFileIdentity(after, pathAfter)) {
      throw new Error(`Icarus compile input changed while hashing: ${absolute}`);
    }
    return {
      path: normalizePathKey(absolute),
      bytes,
      sha256: sha256.digest('hex'),
      dev: after.dev,
      ino: after.ino,
      birthtimeMs: after.birthtimeMs,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs
    };
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

export function sameFingerprints(
  left: readonly FileFingerprint[],
  right: readonly FileFingerprint[]
): boolean {
  return left.length === right.length
    && left.every((fingerprint, index) => sameFingerprint(fingerprint, right[index]));
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.path === right.path
    && left.bytes === right.bytes
    && left.sha256 === right.sha256;
}

export function sameFileObservations(
  left: readonly FileFingerprint[],
  right: readonly FileFingerprint[]
): boolean {
  return left.length === right.length
    && left.every((fingerprint, index) => sameFileObservation(fingerprint, right[index]));
}

export function sameFileObservation(left: FileFingerprint, right: FileFingerprint): boolean {
  return sameFingerprint(left, right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

export function fileContentSignature(
  fingerprint: FileFingerprint
): Pick<FileFingerprint, 'path' | 'bytes' | 'sha256'> {
  return {
    path: fingerprint.path,
    bytes: fingerprint.bytes,
    sha256: fingerprint.sha256
  };
}

export function resolveCompilerPath(file: string, compileCwd: string): string {
  return path.isAbsolute(file) ? path.normalize(file) : path.resolve(compileCwd, file);
}

export async function readFileBounded(
  file: string,
  maximumBytes: number,
  label: string,
  signal?: AbortSignal
): Promise<Buffer> {
  throwIfAborted(signal);
  const absolute = path.resolve(file);
  const handle = await fs.promises.open(absolute, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error(`${label} is not a regular file: ${absolute}`);
    }
    if (before.size > maximumBytes) {
      throw new Error(`${label} exceeds ${maximumBytes} bytes`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      throwIfAborted(signal);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maximumBytes) {
        throw new Error(`${label} exceeds ${maximumBytes} bytes`);
      }
      chunks.push(buffer);
    }
    const after = await handle.stat();
    throwIfAborted(signal);
    const pathAfter = await fs.promises.stat(absolute);
    if (!sameFileIdentity(before, after) || !sameFileIdentity(after, pathAfter)) {
      throw new Error(`${label} changed while reading: ${absolute}`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Icarus compile cache operation was cancelled');
  error.name = 'AbortError';
  throw error;
}

export async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<U>,
  signal?: AbortSignal
): Promise<U[]> {
  const result = new Array<U>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      throwIfAborted(signal);
      const index = next++;
      result[index] = await map(values[index]);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((worker) => worker.status === 'rejected') as PromiseRejectedResult | undefined;
  if (failure) {
    throw failure.reason;
  }
  return result;
}
