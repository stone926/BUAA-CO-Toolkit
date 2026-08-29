// @index mips-core — ProgramImage → course HexText/kernel 导出与停机 PC 检测（纯 TS）

import { ProgramImage } from '../api';
import { CourseProfile, isaProfilePolicies } from '../generated/isaCatalog';
import { courseExecutionProfiles } from '../profiles/courseProfiles';
import { hex8 } from '../values';

/** Course IM is a 16 KiB word-addressed window from 0x3000 through 0x6ffc. */
export const courseInstructionImageBaseAddress = 0x0000_3000;
export const courseInstructionImageWordCapacity = 4096;
const courseInstructionImageEndExclusive = courseInstructionImageBaseAddress
  + courseInstructionImageWordCapacity * 4;

export function wordsToHexText(words: readonly number[]): string {
  return words.map((word) => hex8(word)).join('\n') + (words.length ? '\n' : '');
}

export function imageSegmentWords(image: ProgramImage, name: string): readonly number[] {
  return image.segments.find((segment) => segment.name === name)?.words ?? [];
}

/**
 * Project a segmented ProgramImage into the exact flat HexText word layout consumed by a
 * course DUT. Every non-data segment is an instruction-memory segment: text, ktext and any
 * future course IM segment are placed by absolute address, with holes zero-filled. The result
 * ends at the highest populated instruction word rather than padding the whole 16 KiB IM.
 *
 * Invalid layouts fail closed. In particular, silently clipping or overwriting an unaligned,
 * overlapping, or out-of-range segment would make the DUT execute a different program from
 * the authoritative ProgramImage.
 */
export function courseInstructionImageWords(image: ProgramImage): readonly number[] {
  const projected = new Array<number>(courseInstructionImageWordCapacity);
  let usedWords = 0;

  for (const segment of image.segments) {
    if (segment.name === 'data') continue;
    const baseAddress = segment.baseAddress;
    if (!Number.isInteger(baseAddress) || baseAddress < 0 || baseAddress > 0xffff_ffff
      || baseAddress % 4 !== 0) {
      throw new Error(`course instruction segment "${segment.name}" baseAddress must be a word-aligned uint32`);
    }
    if (baseAddress < courseInstructionImageBaseAddress || baseAddress >= courseInstructionImageEndExclusive) {
      throw new Error(
        `course instruction segment "${segment.name}" starts outside 0x00003000..0x00006ffc`
      );
    }
    const startIndex = (baseAddress - courseInstructionImageBaseAddress) / 4;
    const endIndex = startIndex + segment.words.length;
    if (!Number.isSafeInteger(endIndex) || endIndex > courseInstructionImageWordCapacity) {
      throw new Error(
        `course instruction segment "${segment.name}" extends outside 0x00003000..0x00006ffc`
      );
    }
    if (segment.words.length === 0) continue;
    for (let wordIndex = 0; wordIndex < segment.words.length; wordIndex++) {
      const word = segment.words[wordIndex];
      if (!Number.isInteger(word) || word < 0 || word > 0xffff_ffff) {
        throw new Error(`course instruction segment "${segment.name}" contains a non-uint32 word`);
      }
      const projectedIndex = startIndex + wordIndex;
      if (projected[projectedIndex] !== undefined) {
        const address = courseInstructionImageBaseAddress + projectedIndex * 4;
        throw new Error(
          `course instruction segments overlap at 0x${address.toString(16).padStart(8, '0')}`
        );
      }
      projected[projectedIndex] = word >>> 0;
    }
    usedWords = Math.max(usedWords, endIndex);
  }

  return Array.from({ length: usedWords }, (_unused, index) => projected[index] ?? 0);
}

/** Project a ProgramImage into the one-word-per-line course DUT HexText representation. */
export function courseInstructionImageHexText(image: ProgramImage): string {
  return wordsToHexText(courseInstructionImageWords(image));
}

/**
 * Course completion: `beq $0,$0,-1` (0x1000ffff), followed by a committed nop
 * on delay-slot profiles. The assembler records the last matching sequence in
 * the user text segment; the executor independently enforces the same policy.
 */
export function findCourseHaltPc(image: ProgramImage, profile: CourseProfile): number | undefined {
  const segment = image.segments.find((entry) => entry.name === 'text');
  if (!segment) return undefined;
  const policy = courseExecutionProfiles[profile].halt;
  const words = segment.words;
  let haltPc: number | undefined;
  for (let index = words.length - 1; index >= 0; index--) {
    if ((words[index] >>> 0) !== policy.selfBranchWord) continue;
    if (policy.requireDelaySlotCommit && (words[index + 1] ?? 0xffff_ffff) !== policy.delaySlotWord) continue;
    haltPc = (segment.baseAddress + index * 4) >>> 0;
    break;
  }
  return haltPc;
}

export function profileHasDelaySlot(profile: CourseProfile): boolean {
  return isaProfilePolicies[profile].controlTransferDelaySlot;
}
