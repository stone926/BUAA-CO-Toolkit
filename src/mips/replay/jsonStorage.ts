// @index mips-replay — Lossless storage for large JSON evidence with bounded decompression
import { promisify } from 'node:util';
import { constants, gzip, gunzip } from 'node:zlib';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const minimumCompressionBytes = 4096;

/** Snapshot hashes cover the returned bytes. Domain fingerprints still cover the original JSON. */
export async function encodeReplayJson(bytes: Buffer, maximumBytes: number, compact: boolean) {
  if (!compact) return { bytes, suffix: '.json' };
  if (bytes.length > maximumBytes) throw new Error(`Replay JSON size ${bytes.length} exceeds the hard limit ${maximumBytes}`);
  if (bytes.length >= minimumCompressionBytes) {
    const compressed = await compress(bytes, { level: constants.Z_BEST_SPEED });
    if (compressed.length < bytes.length) return { bytes: compressed, suffix: '.json.gz' };
  }
  return { bytes, suffix: '.json' };
}

/** Existing plain JSON and new gzip streams share the same uncompressed allocation ceiling. */
export async function decodeReplayJson(bytes: Uint8Array, maximumBytes: number): Promise<Buffer> {
  if (bytes.length > maximumBytes) throw new Error(`Replay JSON size ${bytes.length} exceeds the hard limit ${maximumBytes}`);
  return bytes[0] === 0x1f && bytes[1] === 0x8b
    ? decompress(bytes, { maxOutputLength: maximumBytes })
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
