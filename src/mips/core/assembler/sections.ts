// @index mips-core — Shared bounded text/kernel/data section layout and little-endian word materialization

import { ProgramSegment, SourceMapEntry } from '../api';
import { SourceSpan } from './diagnostics';
import { WorkOrigin } from './work';
import { hex8Address } from '../values';

export type CourseSectionId = 'text' | 'ktext' | 'data' | 'kdata';
export type DataSectionId = 'data' | 'kdata';

export interface SectionBounds {
  readonly base: number;
  readonly endInclusive: number;
  /** MARS .data can explicitly select the extern region below its default base. */
  readonly minimumAddress?: number;
}

export interface SectionLayout {
  readonly text: SectionBounds;
  readonly ktext: SectionBounds;
  readonly data: SectionBounds;
  readonly kdata?: SectionBounds;
}

export interface SegmentBuilderOptions {
  readonly sectionLayout?: SectionLayout;
  /** Course HexText dumps pad initialized data to 4 KiB; ordinary images do not. */
  readonly dataPaddingBytes?: number;
  /** Bounds holes and .space as well as initialized words, before allocation. */
  readonly maximumSegmentBytes?: number;
}

export const defaultMaximumSegmentBytes = 4 * 1024 * 1024;
export const maximumAssemblerSegmentBytes = 16 * 1024 * 1024;

/** Course assembler layout contract (P7-2-2, resources/co/courseConfig.json). */
export const courseSectionLayout: Readonly<SectionLayout> = Object.freeze({
  text: Object.freeze({ base: 0x0000_3000, endInclusive: 0x0000_6ffc }),
  ktext: Object.freeze({ base: 0x0000_4180, endInclusive: 0x0000_4ffc }),
  data: Object.freeze({ base: 0x0000_0000, endInclusive: 0x0000_2fff })
});

interface RecordedOrigin {
  readonly section: CourseSectionId;
  readonly wordIndex: number;
  readonly sourceId: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly expansionStack?: readonly SourceSpan[];
}

interface DataSectionState {
  baseAddress: number;
  cursor: number;
  autoAlign: boolean;
  initializedEnd?: number;
  allocatedEnd?: number;
  readonly words: Map<number, number>;
  readonly origins: Map<number, Omit<RecordedOrigin, 'section' | 'wordIndex'>>;
}

export class CourseSegmentBuilder {
  private readonly textWords: number[] = [];
  private readonly ktextWords: number[] = [];
  private readonly usedSections = new Set<CourseSectionId>();
  private readonly textOccupied = new Set<number>();
  private readonly ktextOccupied = new Set<number>();
  private textCursor: number;
  private ktextCursor: number;
  private readonly dataSections = new Map<DataSectionId, DataSectionState>();
  readonly sectionLayout: SectionLayout;
  private readonly dataPaddingBytes: number;
  private readonly maximumSegmentBytes: number;
  private readonly recorded: RecordedOrigin[] = [];

  constructor(options: SegmentBuilderOptions = {}) {
    this.sectionLayout = options.sectionLayout ?? courseSectionLayout;
    this.dataPaddingBytes = options.dataPaddingBytes ?? 0x1000;
    this.maximumSegmentBytes = options.maximumSegmentBytes ?? defaultMaximumSegmentBytes;
    if (!Number.isSafeInteger(this.maximumSegmentBytes) || this.maximumSegmentBytes < 4
      || this.maximumSegmentBytes > maximumAssemblerSegmentBytes) {
      throw new Error(`maximumSegmentBytes must be in 4..${maximumAssemblerSegmentBytes}`);
    }
    if (!Number.isSafeInteger(this.dataPaddingBytes) || this.dataPaddingBytes < 4
      || this.dataPaddingBytes > this.maximumSegmentBytes || this.dataPaddingBytes % 4 !== 0) {
      throw new Error('dataPaddingBytes must be a word-aligned size within maximumSegmentBytes');
    }
    this.textCursor = this.sectionLayout.text.base;
    this.ktextCursor = this.sectionLayout.ktext.base;
    for (const section of ['data', 'kdata'] as const) {
      const bounds = this.sectionLayout[section];
      if (!bounds) continue;
      this.dataSections.set(section, {
        baseAddress: bounds.base, cursor: bounds.base, autoAlign: true,
        words: new Map(), origins: new Map()
      });
    }
  }

  cursor(section: CourseSectionId): number {
    return section === 'text' ? this.textCursor : section === 'ktext' ? this.ktextCursor : this.dataState(section).cursor;
  }

  /** Preserve an explicitly selected or symbol-bearing section even when empty. */
  markSectionUsed(section: CourseSectionId): void { this.usedSections.add(section); }

  setCursor(section: CourseSectionId, address: number): void {
    this.markSectionUsed(section);
    if ((address & 3) !== 0) throw new Error(`段 ${section} 的地址 ${hex8Address(address)} 未字对齐`);
    const bounds = this.boundsFor(section);
    if (address < (bounds.minimumAddress ?? bounds.base) || address > bounds.endInclusive) {
      throw new Error(`段 ${section} 的地址 ${hex8Address(address)} 超出 ${hex8Address(bounds.minimumAddress ?? bounds.base)}..${hex8Address(bounds.endInclusive)}`);
    }
    if (section === 'text' || section === 'ktext') {
      this.ensureAllocationWithinLimit(section, address + 1, bounds.base);
      if (section === 'text') this.textCursor = address;
      else this.ktextCursor = address;
      return;
    }
    const state = this.dataState(section);
    const base = Math.min(state.baseAddress, address);
    this.ensureAllocationWithinLimit(section, Math.max(address + 1, state.allocatedEnd ?? address), base);
    state.baseAddress = base;
    state.cursor = address;
  }

  resetAutoAlign(section: DataSectionId = 'data'): void { this.dataState(section).autoAlign = true; }
  disableAutoAlign(section: DataSectionId = 'data'): void { this.dataState(section).autoAlign = false; }

  alignData(exponent: number, section: DataSectionId = 'data'): void {
    this.markSectionUsed(section);
    if (exponent === 0) { this.disableAutoAlign(section); return; }
    if (exponent < 0 || exponent > 16) throw new Error(`.align 指数必须在 0..16，实际 ${exponent}`);
    const state = this.dataState(section);
    const aligned = Math.ceil(state.cursor / (2 ** exponent)) * (2 ** exponent);
    if (aligned > state.baseAddress) this.ensureDataAddress(section, aligned - 1);
    state.cursor = aligned;
  }

  appendInstruction(section: 'text' | 'ktext', word: number, origin: WorkOrigin): { wordIndex: number; segmentIndex: number } {
    this.markSectionUsed(section);
    const address = this.cursor(section);
    this.ensureInstructionAddress(section, address);
    const words = section === 'text' ? this.textWords : this.ktextWords;
    const occupied = section === 'text' ? this.textOccupied : this.ktextOccupied;
    const wordIndex = (address - this.boundsFor(section).base) / 4;
    if (occupied.has(wordIndex)) throw new Error(`段 ${section} 在 ${hex8Address(address)} 重叠`);
    while (words.length <= wordIndex) words.push(0);
    words[wordIndex] = word >>> 0;
    occupied.add(wordIndex);
    this.recorded.push({ section, wordIndex, ...originRecord(origin) });
    if (section === 'text') this.textCursor = address + 4;
    else this.ktextCursor = address + 4;
    return { wordIndex, segmentIndex: -1 };
  }

  /** Write data at a previously allocated address (pass-2 relocation patch). */
  writeDataBytesAt(address: number, bytes: readonly number[], origin: WorkOrigin, section: DataSectionId = 'data'): void {
    this.markSectionUsed(section);
    if (bytes.length) this.ensureDataAddress(section, address + bytes.length - 1);
    const state = this.dataState(section);
    for (let offset = 0; offset < bytes.length; offset++) {
      const absoluteAddress = address + offset;
      const wordAddress = Math.floor(absoluteAddress / 4) * 4;
      const shift = (absoluteAddress & 3) * 8;
      const previous = state.words.get(wordAddress) ?? 0;
      state.words.set(wordAddress, ((previous & ~(0xff << shift)) | ((bytes[offset] & 0xff) << shift)) >>> 0);
      state.origins.set(wordAddress, originRecord(origin));
    }
    if (bytes.length) {
      state.initializedEnd = Math.max(state.initializedEnd ?? address, address + bytes.length);
      state.allocatedEnd = Math.max(state.allocatedEnd ?? address, address + bytes.length);
    }
  }

  /** Advance without initialized bytes (MARS `.space` semantics). */
  appendDataSpace(bytes: number, section: DataSectionId = 'data'): number {
    this.markSectionUsed(section);
    const state = this.dataState(section);
    const address = state.cursor;
    if (bytes) {
      this.ensureDataAddress(section, address + bytes - 1);
      state.allocatedEnd = Math.max(state.allocatedEnd ?? address, address + bytes);
    }
    state.cursor += bytes;
    return address;
  }

  appendDataBytes(bytes: readonly number[], origin: WorkOrigin, alignment = 0, section: DataSectionId = 'data'): number {
    this.markSectionUsed(section);
    const state = this.dataState(section);
    if (state.autoAlign && alignment > 1) {
      const aligned = Math.ceil(state.cursor / alignment) * alignment;
      if (aligned > state.baseAddress) this.ensureDataAddress(section, aligned - 1);
      state.cursor = aligned;
    }
    const address = state.cursor;
    this.writeDataBytesAt(address, bytes, origin, section);
    state.cursor += bytes.length;
    return address;
  }

  toSegments(): ProgramSegment[] {
    const segments: ProgramSegment[] = [];
    if (this.textWords.length || this.usedSections.has('text')) {
      segments.push({ name: 'text', baseAddress: this.sectionLayout.text.base, words: this.textWords });
    }
    if (this.ktextWords.length || this.usedSections.has('ktext')) {
      segments.push({ name: 'ktext', baseAddress: this.sectionLayout.ktext.base, words: this.ktextWords });
    }
    for (const [section, state] of this.dataSections) {
      if (!this.usedSections.has(section) && state.allocatedEnd === undefined) continue;
      const initializedBytes = (state.initializedEnd ?? state.baseAddress) - state.baseAddress;
      const paddedBytes = Math.ceil(initializedBytes / this.dataPaddingBytes) * this.dataPaddingBytes;
      const wordCount = Math.max(
        Math.ceil((Math.max(state.cursor, state.allocatedEnd ?? state.baseAddress) - state.baseAddress) / 4),
        paddedBytes / 4
      );
      const words = new Array<number>(wordCount).fill(0);
      for (const [wordAddress, word] of state.words) words[(wordAddress - state.baseAddress) / 4] = word;
      segments.push({ name: section, baseAddress: state.baseAddress, words });
    }
    return segments;
  }

  toSourceMap(): SourceMapEntry[] {
    const indices = new Map(this.toSegments().map((segment, index) => [segment.name, index]));
    const result: SourceMapEntry[] = [];
    for (const { section, ...recorded } of this.recorded) {
      const segmentIndex = indices.get(section);
      if (segmentIndex !== undefined) result.push({ segmentIndex, ...recorded });
    }
    for (const [section, state] of this.dataSections) {
      const segmentIndex = indices.get(section);
      if (segmentIndex === undefined) continue;
      for (const [address, origin] of state.origins) {
        result.push({ segmentIndex, wordIndex: (address - state.baseAddress) / 4, ...origin });
      }
    }
    return result;
  }

  private boundsFor(section: CourseSectionId): SectionBounds {
    const bounds = this.sectionLayout[section];
    if (!bounds) throw new Error(`不支持段 ${section}`);
    return bounds;
  }

  private dataState(section: DataSectionId): DataSectionState {
    const state = this.dataSections.get(section);
    if (!state) throw new Error(`不支持段 ${section}`);
    return state;
  }

  private ensureInstructionAddress(section: 'text' | 'ktext', address: number): void {
    const bounds = this.boundsFor(section);
    if (address < bounds.base || address > bounds.endInclusive) {
      throw new Error(`段 ${section} 指令地址 ${hex8Address(address)} 超出 ${hex8Address(bounds.base)}..${hex8Address(bounds.endInclusive)}`);
    }
    this.ensureAllocationWithinLimit(section, address + 4, bounds.base);
    const textEnd = section === 'text'
      ? Math.max(this.sectionLayout.text.base + this.textWords.length * 4, address + 4)
      : this.sectionLayout.text.base + this.textWords.length * 4;
    if (this.ktextOccupied.size && textEnd > this.sectionLayout.ktext.base
      || section === 'ktext' && this.textOccupied.size && textEnd > this.sectionLayout.ktext.base) {
      throw new Error(`.text 与 .ktext 在 ${hex8Address(address)} 重叠`);
    }
  }

  private ensureDataAddress(section: DataSectionId, address: number): void {
    const bounds = this.boundsFor(section);
    const state = this.dataState(section);
    if (address < (bounds.minimumAddress ?? bounds.base) || address > bounds.endInclusive) {
      throw new Error(`数据地址 ${hex8Address(address)} 超出 ${hex8Address(bounds.minimumAddress ?? bounds.base)}..${hex8Address(bounds.endInclusive)}`);
    }
    const paddedBytes = Math.ceil((address + 1 - state.baseAddress) / this.dataPaddingBytes) * this.dataPaddingBytes;
    this.ensureAllocationWithinLimit(section, state.baseAddress + paddedBytes, state.baseAddress);
  }

  private ensureAllocationWithinLimit(section: CourseSectionId, endExclusive: number, base: number): void {
    if (endExclusive - base > this.maximumSegmentBytes) {
      throw new Error(`段 ${section} 的大小或地址空洞超过 ${this.maximumSegmentBytes} 字节上限`);
    }
  }
}

function originRecord(origin: WorkOrigin): Omit<RecordedOrigin, 'section' | 'wordIndex'> {
  return {
    sourceId: origin.span.sourceId, startOffset: origin.span.startOffset, endOffset: origin.span.endOffset,
    ...(origin.expansionStack.length ? { expansionStack: origin.expansionStack } : {})
  };
}
