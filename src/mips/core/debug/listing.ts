// @index mips-core — Paged instruction listing with immutable assembly source origins
import type { ProgramImage, ProgramSegment, SourceMapEntry, SourceUnit } from '../api';
import type { DebugMode } from './api';
import { disassembleDebugInstruction } from './disassembly';

export interface DebugListingSource { readonly id: string; readonly name: string; readonly line: number; readonly text: string; readonly startOffset: number; readonly endOffset?: number }
export interface DebugListingRow { readonly address: number; readonly word: number; readonly instruction: string; readonly source?: DebugListingSource }
interface ListingSegment { segment: ProgramSegment; offset: number }
interface ListingSource { unit: SourceUnit; starts: number[] }

export class DebugListing {
  readonly count: number;
  private readonly segments: ListingSegment[];
  private readonly origins = new Map<number, SourceMapEntry>();
  private readonly sources = new Map<string, ListingSource>();

  constructor(image: ProgramImage, sources: readonly SourceUnit[], private readonly mode: DebugMode) {
    let count = 0;
    this.segments = image.segments.filter(segment => segment.name === 'text' || segment.name === 'ktext')
      .slice().sort((a, b) => a.baseAddress - b.baseAddress).map(segment => {
        const item = { segment, offset: count };
        count += segment.words.length;
        return item;
      });
    this.count = count;
    for (const origin of image.sourceMap) {
      const segment = image.segments[origin.segmentIndex];
      if (segment && origin.wordIndex >= 0 && origin.wordIndex < segment.words.length) this.origins.set(segment.baseAddress + origin.wordIndex * 4, origin);
    }
    for (const unit of sources) {
      const starts = [0];
      for (let index = 0; index < unit.text.length; index++) {
        if (unit.text[index] === '\r') { if (unit.text[index + 1] === '\n') index++; starts.push(index + 1); }
        else if (unit.text[index] === '\n') starts.push(index + 1);
      }
      this.sources.set(unit.id, { unit, starts });
    }
  }
  page(offset: number, count = 256): readonly DebugListingRow[] {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.count || !Number.isInteger(count) || count < 1 || count > 256) throw new Error('Invalid debugger listing page');
    const result: DebugListingRow[] = [];
    for (const item of this.segments) {
      const from = Math.max(0, offset - item.offset), to = Math.min(item.segment.words.length, offset + count - item.offset);
      for (let index = from; index < to; index++) {
        const address = item.segment.baseAddress + index * 4, word = item.segment.words[index];
        const source = this.sourceAtAddress(address);
        result.push({ address, word, instruction: disassembleDebugInstruction(word, address, this.mode), ...(source ? { source } : {}) });
      }
    }
    return result;
  }
  indexOfAddress(address: number): number {
    for (const item of this.segments) {
      const index = (address - item.segment.baseAddress) / 4;
      if (Number.isInteger(index) && index >= 0 && index < item.segment.words.length) return item.offset + index;
    }
    return -1;
  }
  sourceAtAddress(address: number): DebugListingSource | undefined {
    const origin = this.origins.get(address), source = origin && this.sources.get(origin.sourceId);
    if (!origin || !source || origin.startOffset === undefined) return undefined;
    const startOffset = Math.min(origin.startOffset, source.unit.text.length);
    let low = 0, high = source.starts.length;
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (source.starts[middle] <= startOffset) low = middle; else high = middle; }
    const start = source.starts[low], end = source.starts[low + 1] ?? source.unit.text.length;
    return { id: origin.sourceId, name: source.unit.id, line: low + 1,
      text: source.unit.text.slice(start, Math.min(end, start + 2048)).replace(/[\r\n]+$/, ''), startOffset,
      ...(origin.endOffset === undefined ? {} : { endOffset: origin.endOffset }) };
  }
}
