// @index mips-core — 纯 TS SHA-256 与 canonical 状态摘要（core 不得 import node:crypto）
import { hex8, u32 } from './values';

/**
 * 执行核心必须能独立产生可审计的 `finalStateDigest`，但模块边界禁止 core 依赖
 * `node:crypto`（见 scripts/check-module-boundaries.mjs）。因此这里实现 FIPS 180-4
 * 定义的 SHA-256；`src/test/mipsCore/digest.test.ts` 用 `node:crypto` 交叉验证，
 * 保证它不是一个自洽但错误的私有哈希。
 */

const roundConstants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotateRight(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** SHA-256 of raw bytes; returns the lowercase hex digest. */
export function sha256Bytes(input: Uint8Array): string {
  const bitLength = input.length * 8;
  // Padded length: message + 0x80 + zero fill + 8-byte big-endian bit length.
  const paddedLength = (((input.length + 9) + 63) & ~63) >>> 0;
  const block = new Uint8Array(paddedLength);
  block.set(input);
  block[input.length] = 0x80;
  // JavaScript numbers hold the 53-bit safe range, which bounds any in-memory buffer.
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  writeUint32BigEndian(block, paddedLength - 8, high);
  writeUint32BigEndian(block, paddedLength - 4, low);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const schedule = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) {
      schedule[index] = readUint32BigEndian(block, offset + index * 4);
    }
    for (let index = 16; index < 64; index++) {
      const previous = schedule[index - 15];
      const ahead = schedule[index - 2];
      const s0 = (rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3)) >>> 0;
      const s1 = (rotateRight(ahead, 17) ^ rotateRight(ahead, 19) ^ (ahead >>> 10)) >>> 0;
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const sigma1 = (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0;
      const choose = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + sigma1 + choose + roundConstants[index] + schedule[index]) >>> 0;
      const sigma0 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  let digest = '';
  for (const word of state) {
    digest += hex8(word);
  }
  return digest;
}

/** SHA-256 of a UTF-8 encoded string. */
export function sha256Text(text: string): string {
  return sha256Bytes(utf8Bytes(text));
}

/** Minimal UTF-8 encoder; `TextEncoder` is not guaranteed in every core host. */
export function utf8Bytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index++) {
    let codePoint = text.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        index++;
      }
    }
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      // An unpaired surrogate has no UTF-8 encoding. Substitute U+FFFD exactly as
      // `TextEncoder` and `Buffer.from(text, 'utf8')` do, so a core-side hash can
      // never disagree with a host-side one for the same JavaScript string.
      codePoint = 0xfffd;
    }
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    }
  }
  return Uint8Array.from(bytes);
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return u32((bytes[offset] << 24) | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8) | bytes[offset + 3]);
}

function writeUint32BigEndian(bytes: Uint8Array, offset: number, value: number): void {
  const word = u32(value);
  bytes[offset] = (word >>> 24) & 0xff;
  bytes[offset + 1] = (word >>> 16) & 0xff;
  bytes[offset + 2] = (word >>> 8) & 0xff;
  bytes[offset + 3] = word & 0xff;
}
