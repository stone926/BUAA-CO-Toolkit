// @index mips-replay — 不可信 replay bundle 的同一文件句柄有界读取原语
import * as fs from 'fs';

export const maximumReplayManifestBytes = 2 * 1024 * 1024;
export const maximumReplaySnapshotBytes = 64 * 1024 * 1024;
export const maximumReplaySourceBytes = 16 * 1024 * 1024;
export const maximumReplayProgramImageBytes = 16 * 1024 * 1024;
/** Course instruction memory is at most 4096 one-word HexText lines. */
export const maximumReplayMachineCodeWords = 4096;
/** Eight hex digits plus the largest accepted CRLF line ending. */
export const maximumReplayMachineCodeBytes = maximumReplayMachineCodeWords * 10;
export const maximumReplayTraceBytes = 16 * 1024 * 1024;
export const maximumReplayStdinBytes = 8 * 1024 * 1024;
export const maximumReplayWallClockMs = 10 * 60 * 1000;
export const maximumReplaySteps = 10_000_000;
export const maximumReplaySourceDepth = 128;
export const maximumReplaySourceUnits = 1024;

export interface BoundedFileReadOptions {
  /** Hard allocation ceiling, independent from any size declared by the bundle. */
  maximumBytes: number;
  /** Exact byte count declared by an authenticated snapshot, when available. */
  expectedBytes?: number;
  label?: string;
}

/**
 * Read a regular file without allocating from an attacker-controlled file size or declaration.
 * Size checks and reads use one open handle; an extra-byte read and final stat reject growth or
 * truncation while the snapshot is being consumed.
 */
export async function readBoundedRegularFile(
  file: string,
  options: BoundedFileReadOptions
): Promise<Buffer> {
  const label = options.label ?? 'file';
  assertByteCount(options.maximumBytes, `${label} maximumBytes`, true);
  if (options.expectedBytes !== undefined) {
    assertByteCount(options.expectedBytes, `${label} declared bytes`, true);
    if (options.expectedBytes > options.maximumBytes) {
      throw new Error(
        `${label} declared size ${options.expectedBytes} exceeds the hard limit ${options.maximumBytes}`
      );
    }
  }

  const handle = await fs.promises.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} is not a regular file`);
    if (!Number.isSafeInteger(before.size) || before.size < 0) {
      throw new Error(`${label} has an invalid file size`);
    }
    if (before.size > options.maximumBytes) {
      throw new Error(`${label} size ${before.size} exceeds the hard limit ${options.maximumBytes}`);
    }
    if (options.expectedBytes !== undefined && before.size !== options.expectedBytes) {
      throw new Error(`${label} size mismatch: expected ${options.expectedBytes}, got ${before.size}`);
    }

    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) throw new Error(`${label} changed while it was being read`);
      offset += result.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, bytes.byteLength)).bytesRead !== 0) {
      throw new Error(`${label} grew while it was being read`);
    }
    const after = await handle.stat();
    if (after.size !== before.size) throw new Error(`${label} changed while it was being read`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertByteCount(value: number, label: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`);
  }
}
