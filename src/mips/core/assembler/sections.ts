// @index mips-core — 课程段布局/容量检查：text/ktext/data 光标与字节车道写入（纯 TS）

import { ProgramSegment, SourceMapEntry } from '../api';
import { SourceSpan } from './diagnostics';
import { WorkOrigin } from './work';
import { hex8Address } from '../values';

export type CourseSectionId = 'text' | 'ktext' | 'data';

export interface SectionBounds {
  readonly base: number;
  readonly endInclusive: number;
}

export interface SectionLayout {
  readonly text: SectionBounds;
  readonly ktext: SectionBounds;
  readonly data: SectionBounds;
}

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

export class CourseSegmentBuilder {
  private textWords: number[] = [];
  private ktextWords: number[] = [];
  private readonly dataBytes = new Map<number, number>();
  private textCursor = courseSectionLayout.text.base;
  private ktextCursor = courseSectionLayout.ktext.base;
  private dataCursor = courseSectionLayout.data.base;
  private dataAutoAlign = true;
  private readonly recorded: RecordedOrigin[] = [];
  private readonly dataOrigins = new Map<number, Omit<RecordedOrigin, 'section' | 'wordIndex'>>();

  cursor(section: CourseSectionId): number {
    switch (section) {
      case 'text': return this.textCursor;
      case 'ktext': return this.ktextCursor;
      case 'data': return this.dataCursor;
    }
  }

  setCursor(section: CourseSectionId, address: number): void {
    if ((address & 3) !== 0) {
      throw new Error(`段 ${section} 的地址 ${hex8Address(address)} 未字对齐`);
    }
    const bounds = this.boundsFor(section);
    if (address < bounds.base || address > bounds.endInclusive) {
      throw new Error(`段 ${section} 的地址 ${hex8Address(address)} 超出 ${hex8Address(bounds.base)}..${hex8Address(bounds.endInclusive)}`);
    }
    if (section === 'text') this.textCursor = address;
    else if (section === 'ktext') this.ktextCursor = address;
    else this.dataCursor = address;
  }

  resetAutoAlign(): void {
    this.dataAutoAlign = true;
  }

  disableAutoAlign(): void {
    this.dataAutoAlign = false;
  }

  alignData(exponent: number): void {
    if (exponent === 0) {
      this.disableAutoAlign();
      return;
    }
    if (exponent < 0 || exponent > 16) {
      throw new Error(`.align 指数必须在 0..16，实际 ${exponent}`);
    }
    const boundary = 2 ** exponent;
    const aligned = Math.ceil(this.dataCursor / boundary) * boundary;
    if (aligned > courseSectionLayout.data.base) {
      this.ensureDataAddress(aligned - 1);
    }
    this.dataCursor = aligned;
  }

  appendInstruction(
    section: 'text' | 'ktext',
    word: number,
    origin: WorkOrigin
  ): { wordIndex: number; segmentIndex: number } {
    const address = this.cursor(section);
    this.ensureInstructionAddress(section, address);
    const words = section === 'text' ? this.textWords : this.ktextWords;
    const wordIndex = words.length;
    words.push(word >>> 0);
    this.recorded.push({
      section,
      wordIndex,
      sourceId: origin.span.sourceId,
      startOffset: origin.span.startOffset,
      endOffset: origin.span.endOffset,
      ...(origin.expansionStack.length ? { expansionStack: origin.expansionStack } : {})
    });
    this.advance(section, 4);
    return { wordIndex, segmentIndex: -1 };
  }

  /** Write data bytes at a previously allocated address (pass-2 relocation patch). */
  writeDataBytesAt(address: number, bytes: readonly number[], origin: WorkOrigin): void {
    if (bytes.length) this.ensureDataAddress(address + bytes.length - 1);
    for (let offset = 0; offset < bytes.length; offset++) {
      this.dataBytes.set(address + offset, bytes[offset] & 0xff);
      this.dataOrigins.set(Math.floor((address + offset - courseSectionLayout.data.base) / 4), {
        sourceId: origin.span.sourceId,
        startOffset: origin.span.startOffset,
        endOffset: origin.span.endOffset,
        ...(origin.expansionStack.length ? { expansionStack: origin.expansionStack } : {})
      });
    }
  }

  /** Advance the data cursor without allocating initialized bytes (MARS `.space` semantics). */
  appendDataSpace(bytes: number): number {
    const address = this.dataCursor;
    if (bytes) this.ensureDataAddress(address + bytes - 1);
    this.advance('data', bytes);
    return address;
  }

  appendDataBytes(
    bytes: readonly number[],
    origin: WorkOrigin,
    /** Numeric directive width; 0 disables MARS auto-alignment (strings/space). */
    alignment = 0
  ): number {
    if (this.dataAutoAlign && alignment > 1) {
      const aligned = Math.ceil(this.dataCursor / alignment) * alignment;
      if (aligned > courseSectionLayout.data.base) this.ensureDataAddress(aligned - 1);
      this.dataCursor = aligned;
    }
    const address = this.dataCursor;
    if (bytes.length) this.ensureDataAddress(address + bytes.length - 1);
    for (let offset = 0; offset < bytes.length; offset++) {
      this.dataBytes.set(address + offset, bytes[offset] & 0xff);
      this.dataOrigins.set(Math.floor((address + offset - courseSectionLayout.data.base) / 4), {
        sourceId: origin.span.sourceId,
        startOffset: origin.span.startOffset,
        endOffset: origin.span.endOffset,
        ...(origin.expansionStack.length ? { expansionStack: origin.expansionStack } : {})
      });
    }
    this.advance('data', bytes.length);
    return address;
  }

  toSegments(): ProgramSegment[] {
    const segments: ProgramSegment[] = [];
    if (this.textWords.length) {
      segments.push({ name: 'text', baseAddress: courseSectionLayout.text.base, words: this.textWords });
    }
    if (this.ktextWords.length) {
      segments.push({ name: 'ktext', baseAddress: courseSectionLayout.ktext.base, words: this.ktextWords });
    }
    if (this.dataBytes.size > 0) {
      // MARS allocates data memory in 4096-byte (1024-word) blocks and its HexText
      // dump ends at the last allocated block boundary. Course data starts at 0 and
      // is written contiguously, so pad to the same boundary for image differential.
      const lastByte = Math.max(...this.dataBytes.keys()) + 1;
      const allocatedEnd = Math.ceil(lastByte / 0x1000) * 0x1000;
      const wordCount = Math.max(
        Math.ceil((this.dataCursor - courseSectionLayout.data.base) / 4),
        allocatedEnd / 4
      );
      const words = new Array<number>(wordCount).fill(0);
      for (const [address, byte] of this.dataBytes) {
        const wordIndex = Math.floor((address - courseSectionLayout.data.base) / 4);
        const lane = (address - courseSectionLayout.data.base) & 3;
        words[wordIndex] = (words[wordIndex] & ~(0xff << (lane * 8))) | ((byte << (lane * 8)) >>> 0);
      }
      segments.push({ name: 'data', baseAddress: courseSectionLayout.data.base, words });
    }
    return segments;
  }

  toSourceMap(): SourceMapEntry[] {
    const segments = this.toSegments();
    const segmentIndexByName = new Map(segments.map((segment, index) => [segment.name, index]));
    const result: SourceMapEntry[] = [];
    for (const recorded of this.recorded) {
      const segmentIndex = segmentIndexByName.get(recorded.section);
      if (segmentIndex === undefined) continue;
      result.push({
        segmentIndex,
        wordIndex: recorded.wordIndex,
        sourceId: recorded.sourceId,
        startOffset: recorded.startOffset,
        endOffset: recorded.endOffset,
        ...(recorded.expansionStack?.length ? { expansionStack: recorded.expansionStack } : {})
      });
    }
    const dataIndex = segmentIndexByName.get('data');
    if (dataIndex !== undefined) {
      for (const [wordIndex, origin] of this.dataOrigins) {
        result.push({
          segmentIndex: dataIndex,
          wordIndex,
          sourceId: origin.sourceId,
          startOffset: origin.startOffset,
          endOffset: origin.endOffset,
          ...(origin.expansionStack?.length ? { expansionStack: origin.expansionStack } : {})
        });
      }
    }
    return result;
  }

  private boundsFor(section: CourseSectionId): SectionBounds {
    switch (section) {
      case 'text': return courseSectionLayout.text;
      case 'ktext': return courseSectionLayout.ktext;
      case 'data': return courseSectionLayout.data;
    }
  }

  private ensureInstructionAddress(section: 'text' | 'ktext', address: number): void {
    const bounds = this.boundsFor(section);
    if (address < bounds.base || address > bounds.endInclusive) {
      throw new Error(`段 ${section} 指令地址 ${hex8Address(address)} 超出 ${hex8Address(bounds.base)}..${hex8Address(bounds.endInclusive)}`);
    }
    const textStart = courseSectionLayout.text.base;
    const textEnd = textStart + this.textWords.length * 4;
    const ktextStart = courseSectionLayout.ktext.base;
    const ktextEnd = ktextStart + this.ktextWords.length * 4;
    if (section === 'text' && this.ktextWords.length && address < ktextEnd) {
      throw new Error(`.text 与 .ktext 在 ${hex8Address(address)} 重叠`);
    }
    if (section === 'ktext' && this.textWords.length && address < textEnd) {
      throw new Error(`.ktext 与 .text 在 ${hex8Address(address)} 重叠`);
    }
  }

  private ensureDataAddress(address: number): void {
    if (address < courseSectionLayout.data.base || address > courseSectionLayout.data.endInclusive) {
      throw new Error(`数据地址 ${hex8Address(address)} 超出 ${hex8Address(courseSectionLayout.data.base)}..${hex8Address(courseSectionLayout.data.endInclusive)}`);
    }
  }

  private advance(section: CourseSectionId, bytes: number): void {
    switch (section) {
      case 'text':
        this.textCursor = (this.textCursor + bytes) >>> 0;
        break;
      case 'ktext':
        this.ktextCursor = (this.ktextCursor + bytes) >>> 0;
        break;
      case 'data':
        this.dataCursor = (this.dataCursor + bytes) >>> 0;
        break;
    }
  }
}
