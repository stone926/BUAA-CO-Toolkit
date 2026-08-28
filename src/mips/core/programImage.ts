// @index mips-core — ProgramImage canonical 载荷、fingerprint 与执行器输入构造（纯 TS）
import {
  ProgramImage,
  ProgramSegment,
  SourceMapEntry,
  SourceUnit,
  SourceUnitFingerprint,
  SymbolEntry
} from './api';
import { CanonicalJson, canonicalJson } from './canonicalJson';
import { sha256Text } from './digest';
import { u32 } from './values';

/**
 * `ProgramImage` 的 canonical 形式属于 core：汇编器（阶段 5）、执行器（阶段 2/3）
 * 与 replay 证据必须对同一 image 得到同一 fingerprint。replay 层复用这里的载荷，
 * 只额外负责基数上限、文件 IO 与 schema 校验。
 */

export interface ProgramImageInput {
  readonly entryPc?: number;
  readonly segments: readonly ProgramSegment[];
  readonly symbols?: readonly SymbolEntry[];
  readonly sourceMap?: readonly SourceMapEntry[];
  readonly inputGraph: readonly SourceUnitFingerprint[];
}

/** Canonical payload every fingerprint is computed over; excludes the fingerprint itself. */
export function programImageCanonicalPayload(
  image: Omit<ProgramImage, 'fingerprint'> | ProgramImage
): CanonicalJson {
  return {
    formatVersion: image.formatVersion,
    entryPc: u32(image.entryPc),
    segments: image.segments.map((segment) => ({
      name: segment.name,
      baseAddress: u32(segment.baseAddress),
      words: segment.words.map((word) => u32(word))
    })),
    symbols: image.symbols.map((symbol) => ({
      name: symbol.name,
      ...(symbol.value === undefined ? {} : { value: symbol.value }),
      kind: symbol.kind,
      ...(symbol.segment === undefined ? {} : { segment: symbol.segment })
    })),
    sourceMap: image.sourceMap.map((entry) => ({
      segmentIndex: entry.segmentIndex,
      wordIndex: entry.wordIndex,
      sourceId: entry.sourceId,
      ...(entry.startOffset === undefined ? {} : { startOffset: entry.startOffset }),
      ...(entry.endOffset === undefined ? {} : { endOffset: entry.endOffset }),
      ...(entry.expansionStack?.length
        ? {
          expansionStack: entry.expansionStack.map((frame) => ({
            sourceId: frame.sourceId,
            ...(frame.startOffset === undefined ? {} : { startOffset: frame.startOffset }),
            ...(frame.endOffset === undefined ? {} : { endOffset: frame.endOffset })
          }))
        }
        : {})
    })),
    inputGraph: image.inputGraph.map((unit) => ({
      id: unit.id,
      ...(unit.uri === undefined ? {} : { uri: unit.uri }),
      contentHash: unit.contentHash.toLowerCase()
    }))
  };
}

/** SHA-256 of the canonical payload; the single definition of image identity. */
export function programImageContentFingerprint(
  image: Omit<ProgramImage, 'fingerprint'> | ProgramImage
): string {
  return sha256Text(canonicalJson(programImageCanonicalPayload(image)));
}

/** Fingerprint of one source unit, for building an input graph without a host. */
export function sourceUnitFingerprint(unit: SourceUnit): SourceUnitFingerprint {
  return {
    id: unit.id,
    ...(unit.uri === undefined ? {} : { uri: unit.uri }),
    contentHash: sha256Text(unit.text)
  };
}

/** Build an immutable image with a matching fingerprint. */
export function buildProgramImage(input: ProgramImageInput): ProgramImage {
  const withoutFingerprint = {
    formatVersion: 1 as const,
    entryPc: u32(input.entryPc ?? input.segments[0]?.baseAddress ?? 0),
    segments: input.segments.map((segment) => ({
      name: segment.name,
      baseAddress: u32(segment.baseAddress),
      words: segment.words.map((word) => u32(word))
    })),
    symbols: input.symbols ?? [],
    sourceMap: input.sourceMap ?? [],
    inputGraph: input.inputGraph
  };
  return {
    ...withoutFingerprint,
    fingerprint: programImageContentFingerprint(withoutFingerprint)
  };
}
