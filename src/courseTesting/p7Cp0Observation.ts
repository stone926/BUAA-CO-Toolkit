// @index course-testing — CP0 fields checked by the P7 automatic hardware tests
import { resolveCourseProfile } from '../mips/core/profiles/courseProfiles';
import type { ProgramImage } from '../mips/core/api';
import { decodeCourseInstructionWord } from '../mips/core/isa/decoder';
import type { P7ProbeCommitExpectation } from './builtinAsm/types';
import { wordAt } from './pipeline/courseImagePolicy';

const cp0 = resolveCourseProfile('P7').exceptions!.cp0;
export const p7StatusObservationMask = cp0.statusWritableMask;
export const p7CauseObservationMask = (cp0.causeBranchDelayBit | cp0.causeInterruptPendingBits | cp0.causeExceptionCodeBits) >>> 0;

export function p7Cp0ObservationMask(field: string | undefined): number | undefined {
  if (field === 'status') return p7StatusObservationMask;
  if (field === 'cause') return p7CauseObservationMask;
  return undefined;
}

export function matchesP7ObservedWord(actual: number, expected: number, mask?: number): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  return mask === undefined ? actual === (expected >>> 0) : (actual & mask) === (expected & mask);
}

/** Older saved probes did not label their raw mfc0 witnesses. Only the
 * instruction actually present at the witnessed PC can identify a CP0 read. */
export function p7CommitObservationMask(commit: P7ProbeCommitExpectation, image?: ProgramImage): number | undefined {
  if (commit.cp0Sample || !image || commit.kind !== 'grf') return p7Cp0ObservationMask(commit.cp0Sample);
  const word = wordAt(image, commit.pc);
  if (word === undefined || decodeCourseInstructionWord(word) !== 'mfc0' || ((word >>> 16) & 31) !== commit.target) return undefined;
  const rd = (word >>> 11) & 31;
  return rd === 12 ? p7StatusObservationMask : rd === 13 ? p7CauseObservationMask : undefined;
}
