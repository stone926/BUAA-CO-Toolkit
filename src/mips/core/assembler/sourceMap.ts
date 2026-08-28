// @index mips-core — ProgramImage.sourceMap 查询：CommitEvent/PC/访存地址 -> source/macro origin（纯 TS）

import { ProgramImage, ProgramSegment, SourceMapEntry } from '../api';
import type { CommitEvent } from '../events/commitEvent';
import { u32 } from '../values';

export interface SourceMapHit {
  readonly entry: SourceMapEntry;
  readonly segment: ProgramSegment;
  readonly address: number;
  readonly word: number;
}

export interface CommitEventSourceMap {
  readonly instruction?: SourceMapHit;
  readonly memoryWrites: readonly SourceMapHit[];
}

/** Resolve one sourceMap entry by segment/word coordinates. */
export function sourceMapEntryForWord(
  image: ProgramImage,
  segmentIndex: number,
  wordIndex: number
): SourceMapEntry | undefined {
  return image.sourceMap.find((entry) =>
    entry.segmentIndex === segmentIndex && entry.wordIndex === wordIndex);
}

/** Map a runtime PC/data address back through image segments and sourceMap. */
export function sourceMapEntryForAddress(
  image: ProgramImage,
  address: number
): SourceMapHit | undefined {
  const value = u32(address);
  for (let segmentIndex = 0; segmentIndex < image.segments.length; segmentIndex++) {
    const segment = image.segments[segmentIndex];
    const base = u32(segment.baseAddress);
    if (value < base) continue;
    const offset = value - base;
    if (offset % 4 !== 0) continue;
    const wordIndex = offset / 4;
    if (wordIndex >= segment.words.length) continue;
    const entry = sourceMapEntryForWord(image, segmentIndex, wordIndex);
    if (!entry) continue;
    return { entry, segment, address: value, word: segment.words[wordIndex] >>> 0 };
  }
  return undefined;
}

/**
 * Stage-5 observability contract: a canonical CommitEvent can be traced to the
 * source/macro origin of its victim instruction and every committed memory
 * write. Expansion frames are innermost-first.
 */
export function commitEventSourceMap(
  image: ProgramImage,
  event: CommitEvent
): CommitEventSourceMap {
  return {
    ...(event.pcBefore === undefined ? {} : {
      instruction: sourceMapEntryForAddress(image, event.pcBefore)
    }),
    memoryWrites: event.memoryWrites
      .map((write) => sourceMapEntryForAddress(image, write.wordAddress))
      .filter((hit): hit is SourceMapHit => hit !== undefined)
  };
}
