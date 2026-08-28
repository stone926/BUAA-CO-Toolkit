// @index mips-core — ProgramImage → course HexText/kernel 导出与停机 PC 检测（纯 TS）

import { ProgramImage } from '../api';
import { CourseProfile, isaProfilePolicies } from '../generated/isaCatalog';
import { courseExecutionProfiles } from '../profiles/courseProfiles';
import { hex8 } from '../values';

export function wordsToHexText(words: readonly number[]): string {
  return words.map((word) => hex8(word)).join('\n') + (words.length ? '\n' : '');
}

export function imageSegmentWords(image: ProgramImage, name: string): readonly number[] {
  return image.segments.find((segment) => segment.name === name)?.words ?? [];
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
