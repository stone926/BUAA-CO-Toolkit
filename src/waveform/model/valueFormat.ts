// @index waveform-format — 四态值按进制格式化：bin/hex/无符号/有符号十进制/ASCII/MIPS 指令；x/z 按 nibble 规则呈现

import { disassembleMipsWord } from './mipsDisassembly';
import type { Radix } from './radix';
import { avalOffset, bvalOffset, changeIndexAt, changeTime, wordMask } from './signalValues';
import { TrackEncoding, WaveTracks } from './waveformData';

export const eventTriggerText = '触发';

/** A named event holds no value between triggers: `eventTriggerText` at a trigger time, else '—'. */
export function formatEventAt(tracks: WaveTracks, track: number, time: number): string {
  const index = changeIndexAt(tracks, track, time);
  return index >= 0 && changeTime(tracks, track, index) === time ? eventTriggerText : '—';
}

/** Format change `index` of `track` in the requested radix. */
export function formatTrackValue(tracks: WaveTracks, track: number, index: number, radix: Radix): string {
  const encoding = tracks.encoding[track];
  if (encoding === TrackEncoding.Real) {
    return formatReal(tracks.reals[tracks.valueStart[track] + index]);
  }
  if (encoding === TrackEncoding.Text) {
    return tracks.texts[tracks.valueStart[track] + index] ?? '';
  }
  return formatBits(
    tracks.aval,
    avalOffset(tracks, track, index),
    tracks.bval,
    bvalOffset(tracks, track, index),
    tracks.width[track],
    radix
  );
}

/**
 * Format a four-state vector stored as little-endian aval/bval words. A negative
 * `bOffset` means the value is two-state.
 */
export function formatBits(
  aval: Uint32Array,
  aOffset: number,
  bval: Uint32Array,
  bOffset: number,
  width: number,
  radix: Radix
): string {
  if (width <= 0) {
    return '';
  }
  if (width === 1) {
    return bitChar(aval[aOffset] & 1, bOffset < 0 ? 0 : bval[bOffset] & 1);
  }
  const unknown = bOffset >= 0 && hasUnknownBits(bval, bOffset, width);
  switch (radix) {
    case 'bin':
      return formatBinary(aval, aOffset, bval, unknown ? bOffset : -1, width);
    case 'udec':
    case 'sdec':
      return unknown
        ? unknownSummary(aval, aOffset, bval, bOffset, width)
        : formatDecimal(aval, aOffset, width, radix === 'sdec');
    case 'ascii':
      return unknown ? formatHex(aval, aOffset, bval, bOffset, width) : formatAscii(aval, aOffset, width);
    case 'instr':
      return !unknown && width === 32
        ? disassembleMipsWord(aval[aOffset] >>> 0)
        : formatHex(aval, aOffset, bval, unknown ? bOffset : -1, width);
    case 'hex':
    default:
      if (!unknown && width <= 32) {
        return ((aval[aOffset] & wordMask(width, 0)) >>> 0).toString(16).padStart(Math.ceil(width / 4), '0');
      }
      return formatHex(aval, aOffset, bval, unknown ? bOffset : -1, width);
  }
}

export function formatReal(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  if (Number.isInteger(value) && Math.abs(value) < 1e15) {
    return String(value);
  }
  return String(Number(value.toPrecision(10)));
}

function bitChar(a: number, b: number): string {
  return b ? (a ? 'x' : 'z') : (a ? '1' : '0');
}

function hasUnknownBits(bval: Uint32Array, bOffset: number, width: number): boolean {
  const words = Math.ceil(width / 32);
  for (let word = 0; word < words; word++) {
    if (bval[bOffset + word] & wordMask(width, word)) {
      return true;
    }
  }
  return false;
}

function bitAt(words: Uint32Array, offset: number, bit: number): number {
  return (words[offset + (bit >>> 5)] >>> (bit & 31)) & 1;
}

function formatBinary(aval: Uint32Array, aOffset: number, bval: Uint32Array, bOffset: number, width: number): string {
  let text = '';
  for (let bit = width - 1; bit >= 0; bit--) {
    text += bitChar(bitAt(aval, aOffset, bit), bOffset < 0 ? 0 : bitAt(bval, bOffset, bit));
  }
  return text;
}

/** Hex digits; a nibble is `x`/`z` when all its bits are, and `X` when mixed. */
function formatHex(aval: Uint32Array, aOffset: number, bval: Uint32Array, bOffset: number, width: number): string {
  let text = '';
  for (let nibble = Math.ceil(width / 4) - 1; nibble >= 0; nibble--) {
    const low = nibble * 4;
    const bits = Math.min(4, width - low);
    const mask = (1 << bits) - 1;
    const a = extractBits(aval, aOffset, low, bits);
    const b = bOffset < 0 ? 0 : extractBits(bval, bOffset, low, bits);
    if (b === 0) {
      text += a.toString(16);
    } else if (b === mask) {
      text += a === mask ? 'x' : a === 0 ? 'z' : 'X';
    } else {
      text += 'X';
    }
  }
  return text;
}

function extractBits(words: Uint32Array, offset: number, low: number, count: number): number {
  let value = 0;
  for (let bit = count - 1; bit >= 0; bit--) {
    value = (value << 1) | bitAt(words, offset, low + bit);
  }
  return value;
}

function unknownSummary(aval: Uint32Array, aOffset: number, bval: Uint32Array, bOffset: number, width: number): string {
  let xBits = 0;
  let zBits = 0;
  for (let bit = 0; bit < width; bit++) {
    if (bitAt(bval, bOffset, bit)) {
      if (bitAt(aval, aOffset, bit)) {
        xBits++;
      } else {
        zBits++;
      }
    }
  }
  if (xBits === width) {
    return 'x';
  }
  if (zBits === width) {
    return 'z';
  }
  return 'X';
}

function formatDecimal(aval: Uint32Array, aOffset: number, width: number, signed: boolean): string {
  if (width <= 32) {
    const unsigned = (aval[aOffset] & wordMask(width, 0)) >>> 0;
    if (signed && width > 0 && (unsigned >>> (width - 1)) & 1) {
      return String(unsigned - 2 ** width);
    }
    return String(unsigned);
  }
  let value = 0n;
  const words = Math.ceil(width / 32);
  for (let word = words - 1; word >= 0; word--) {
    value = (value << 32n) | BigInt((aval[aOffset + word] & wordMask(width, word)) >>> 0);
  }
  if (signed && (value >> BigInt(width - 1)) & 1n) {
    value -= 1n << BigInt(width);
  }
  return value.toString();
}

/** Bytes from the most significant end; leading NULs (zero padding) are dropped. */
function formatAscii(aval: Uint32Array, aOffset: number, width: number): string {
  let text = '';
  let started = false;
  for (let byte = Math.ceil(width / 8) - 1; byte >= 0; byte--) {
    const low = byte * 8;
    const code = extractBits(aval, aOffset, low, Math.min(8, width - low));
    if (!started && code === 0) {
      continue;
    }
    started = true;
    text += code >= 32 && code < 127 ? String.fromCharCode(code) : '.';
  }
  return text;
}
