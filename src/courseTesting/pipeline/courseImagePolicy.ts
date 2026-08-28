// @index course-testing-pipeline — 课程 ProgramImage 执行策略：段布局、容量、停机字与 fingerprint 校验

import type { ProgramImage } from '../../mips/core/api';
import { courseExecutionProfiles, resolveCourseProfile } from '../../mips/core/profiles/courseProfiles';
import { hex8Address } from '../../mips/core/values';
import { programImageIssues } from '../../mips/replay/programImage';
import type { CourseProfile } from '../../mips/core/generated/isaCatalog';

export interface CourseImagePolicy {
  readonly profile: CourseProfile;
  readonly entryPc: number;
  readonly image: ProgramImage;
}

export interface CourseImagePolicyIssue {
  readonly code: string;
  readonly message: string;
}

/** Course text segment occupies 0x3000..0x6fff and the image must stay inside it. */
export const courseImagePolicy = Object.freeze({
  textBase: 0x0000_3000,
  textEndInclusive: 0x0000_6fff,
  maximumWords: 4096,
  dataBase: 0x0000_0000,
  dataEndInclusive: 0x0000_2fff,
  maximumDataWords: 3072
});

export function courseProgramImagePolicyIssues(
  profile: CourseProfile,
  image: ProgramImage,
  haltPc?: number
): CourseImagePolicyIssue[] {
  const issues: CourseImagePolicyIssue[] = [];
  if (!image || typeof image !== 'object' || !Array.isArray((image as { segments?: unknown }).segments)) {
    issues.push({ code: 'course-image.invalid-program-image', message: 'ProgramImage 必须包含 segments 数组' });
    return issues;
  }
  for (const issue of programImageIssues(image)) {
    issues.push({ code: 'course-image.invalid-program-image', message: issue });
  }
  if (!courseExecutionProfiles[profile]) {
    issues.push({ code: 'course-image.profile-unsupported', message: `不支持的课程 profile ${profile}` });
    return issues;
  }
  if (image.entryPc !== courseImagePolicy.textBase) {
    issues.push({
      code: 'course-image.entry-pc',
      message: `entryPc 必须是 ${hex8Address(courseImagePolicy.textBase)}`
    });
  }
  let instructionWords = 0;
  let dataWords = 0;
  for (const segment of image.segments) {
    const base = segment.baseAddress >>> 0;
    const end = (base + segment.words.length * 4) >>> 0;
    if (segment.name === 'data') {
      if (base < courseImagePolicy.dataBase
        || end > (courseImagePolicy.dataEndInclusive + 1) >>> 0) {
        issues.push({
          code: 'course-image.data-segment-outside-dm',
          message: `data segment "${segment.name}" 超出课程 DM 地址空间`
        });
      }
      dataWords += segment.words.length;
      continue;
    }
    if (base < courseImagePolicy.textBase
      || end > (courseImagePolicy.textEndInclusive + 1) >>> 0) {
      issues.push({
        code: 'course-image.segment-outside-im',
        message: `segment "${segment.name}" 超出课程 IM 地址空间`
      });
    }
    instructionWords += segment.words.length;
  }
  if (instructionWords > courseImagePolicy.maximumWords) {
    issues.push({
      code: 'course-image.too-many-words',
      message: `ProgramImage 共 ${instructionWords} 个指令字，超过课程 IM 上限 ${courseImagePolicy.maximumWords}`
    });
  }
  if (dataWords > courseImagePolicy.maximumDataWords) {
    issues.push({
      code: 'course-image.too-many-data-words',
      message: `ProgramImage data 段共 ${dataWords} 个字，超过课程 DM 上限 ${courseImagePolicy.maximumDataWords}`
    });
  }
  if (haltPc !== undefined) {
    const pc = haltPc >>> 0;
    const word = wordAt(image, pc);
    const policy = resolveCourseProfile(profile).halt;
    if (word !== policy.selfBranchWord) {
      issues.push({
        code: 'course-image.halt-word-mismatch',
        message: `haltPc ${hex8Address(pc)} 处不是课程停机自分支 ${policy.selfBranchWord.toString(16)}`
      });
    }
    if (policy.requireDelaySlotCommit) {
      const delayWord = wordAt(image, pc + 4);
      if (delayWord !== policy.delaySlotWord) {
        issues.push({
          code: 'course-image.halt-delay-slot-mismatch',
          message: `停机分支 ${hex8Address(pc)} 后缺少 delay-slot nop`
        });
      }
    }
  }
  return issues;
}

export function wordAt(image: ProgramImage, address: number): number | undefined {
  const pc = address >>> 0;
  for (const segment of image.segments) {
    const base = segment.baseAddress >>> 0;
    const offset = pc - base;
    if (pc >= base && offset % 4 === 0 && offset / 4 < segment.words.length) {
      return segment.words[offset / 4] >>> 0;
    }
  }
  return undefined;
}
