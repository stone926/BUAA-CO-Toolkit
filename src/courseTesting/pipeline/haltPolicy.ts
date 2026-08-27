// @index course-testing-pipeline — 课程停机策略：自分支 + delay-slot nop 的 image/运行期校验

import type { ProgramImage } from '../../mips/core/api';
import type { CourseProfile } from '../../mips/core/generated/isaCatalog';
import { resolveCourseProfile } from '../../mips/core/profiles/courseProfiles';
import { hex8Address } from '../../mips/core/values';
import { wordAt } from './courseImagePolicy';

export interface CourseHaltPolicy {
  readonly kind: 'course-self-branch-nop';
  readonly haltPc: number;
  readonly selfBranchWord: number;
  readonly delaySlotWord: number;
  readonly requireDelaySlotCommit: boolean;
}

export function courseHaltPolicy(profile: CourseProfile, haltPc: number): CourseHaltPolicy {
  const policy = resolveCourseProfile(profile).halt;
  return {
    kind: 'course-self-branch-nop',
    haltPc: haltPc >>> 0,
    selfBranchWord: policy.selfBranchWord,
    delaySlotWord: policy.delaySlotWord,
    requireDelaySlotCommit: policy.requireDelaySlotCommit
  };
}

/** Static image check: the exact standard halt tail must be loaded. */
export function courseHaltImageIssue(
  profile: CourseProfile,
  image: ProgramImage,
  haltPc: number
): string | undefined {
  const policy = courseHaltPolicy(profile, haltPc);
  const branch = wordAt(image, haltPc);
  if (branch !== policy.selfBranchWord) {
    return `${hex8Address(haltPc)} 不是课程停机自分支 ${policy.selfBranchWord.toString(16)}`;
  }
  if (policy.requireDelaySlotCommit) {
    const delay = wordAt(image, haltPc + 4);
    if (delay !== policy.delaySlotWord) {
      return `${hex8Address(haltPc + 4)} 不是停机 delay-slot nop`;
    }
  }
  return undefined;
}

/** Re-run determinism check used by shadow verdicts and replay validation. */
export function courseHaltOutcome(
  profile: CourseProfile,
  stop: { kind: string; haltPc?: number } | undefined
): boolean {
  if (!stop || stop.kind !== 'halt-loop' || stop.haltPc === undefined) return false;
  return true;
}
