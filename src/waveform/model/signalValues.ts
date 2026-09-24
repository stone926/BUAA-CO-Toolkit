// @index waveform-values — 列式 track 的时间二分查找、跳变导航与四态值读取（零分配访问器）

import { TrackEncoding, WaveTracks } from './waveformData';

/** Four-state level of a single bit: 0, 1, x or z. */
export const BitLevel = {
  Zero: 0,
  One: 1,
  Unknown: 2,
  HighZ: 3
} as const;
export type BitLevel = typeof BitLevel[keyof typeof BitLevel];

/** Summary of a whole vector value used to pick how it is drawn. */
export const ValueState = {
  Known: 0,
  /** Some but not all bits are x/z. */
  Mixed: 1,
  AllUnknown: 2,
  AllHighZ: 3
} as const;
export type ValueState = typeof ValueState[keyof typeof ValueState];

/**
 * Index (relative to the track) of the last change at or before `time`, or -1 when
 * `time` precedes the first change.
 */
export function changeIndexAt(tracks: WaveTracks, track: number, time: number): number {
  const start = tracks.changeStart[track];
  const end = tracks.changeStart[track + 1];
  const times = tracks.times;
  let low = start;
  let high = end;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times[middle] <= time) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low - 1 - start;
}

export function changeTime(tracks: WaveTracks, track: number, index: number): number {
  return tracks.times[tracks.changeStart[track] + index];
}

export function changeCount(tracks: WaveTracks, track: number): number {
  return tracks.changeStart[track + 1] - tracks.changeStart[track];
}

/** Time of the first change strictly after `time`. */
export function nextChangeTime(tracks: WaveTracks, track: number, time: number): number | undefined {
  const index = changeIndexAt(tracks, track, time) + 1;
  return index < changeCount(tracks, track) ? changeTime(tracks, track, index) : undefined;
}

/** Time of the last change strictly before `time`. */
export function previousChangeTime(tracks: WaveTracks, track: number, time: number): number | undefined {
  let index = changeIndexAt(tracks, track, time);
  if (index >= 0 && changeTime(tracks, track, index) >= time) {
    index--;
  }
  return index >= 0 ? changeTime(tracks, track, index) : undefined;
}

export function avalOffset(tracks: WaveTracks, track: number, index: number): number {
  return tracks.valueStart[track] + index * tracks.wordsPerValue[track];
}

/** Offset into `bval`, or -1 when this track never held x/z. */
export function bvalOffset(tracks: WaveTracks, track: number, index: number): number {
  const start = tracks.bvalStart[track];
  return start < 0 ? -1 : start + index * tracks.wordsPerValue[track];
}

/** Level of bit 0 of a bit-track change (the whole value for 1-bit signals). */
export function bitLevel(tracks: WaveTracks, track: number, index: number): BitLevel {
  const a = tracks.aval[avalOffset(tracks, track, index)] & 1;
  const bOffset = bvalOffset(tracks, track, index);
  const b = bOffset < 0 ? 0 : tracks.bval[bOffset] & 1;
  return (b ? (a ? BitLevel.Unknown : BitLevel.HighZ) : a) as BitLevel;
}

/** Classify a bit-track value as known, partially unknown, all-x or all-z. */
export function valueState(tracks: WaveTracks, track: number, index: number): ValueState {
  if (tracks.encoding[track] !== TrackEncoding.Bits) {
    return ValueState.Known;
  }
  const bOffset = bvalOffset(tracks, track, index);
  if (bOffset < 0) {
    return ValueState.Known;
  }
  const width = tracks.width[track];
  const words = tracks.wordsPerValue[track];
  const aOffset = avalOffset(tracks, track, index);
  let unknownBits = 0;
  let xBits = 0;
  for (let word = 0; word < words; word++) {
    const mask = wordMask(width, word);
    const b = tracks.bval[bOffset + word] & mask;
    if (b) {
      unknownBits += popcount(b);
      xBits += popcount(b & tracks.aval[aOffset + word]);
    }
  }
  if (unknownBits === 0) {
    return ValueState.Known;
  }
  if (unknownBits < width) {
    return ValueState.Mixed;
  }
  return xBits === 0 ? ValueState.AllHighZ : xBits === width ? ValueState.AllUnknown : ValueState.Mixed;
}

/** Mask of the bits of `word` that belong to a `width`-bit value. */
export function wordMask(width: number, word: number): number {
  const remaining = width - word * 32;
  return remaining >= 32 ? 0xffffffff : remaining <= 0 ? 0 : ((1 << remaining) - 1) >>> 0;
}

function popcount(value: number): number {
  let remaining = value >>> 0;
  let count = 0;
  while (remaining) {
    remaining &= remaining - 1;
    count++;
  }
  return count;
}
