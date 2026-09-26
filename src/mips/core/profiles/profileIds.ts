// @index mips-core — host-free course execution profile identities from generated ISA policies
import { CourseProfile, isaProfilePolicies } from '../generated/isaCatalog';

export const courseProfileIds: readonly CourseProfile[] = Object.freeze(
  Object.keys(isaProfilePolicies) as CourseProfile[]
);
const courseProfileSet: ReadonlySet<string> = new Set(courseProfileIds);

export function isCourseProfile(value: unknown): value is CourseProfile {
  return typeof value === 'string' && courseProfileSet.has(value);
}
