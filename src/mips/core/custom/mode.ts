// @index mips-core — Common custom ISA scope for course profiles and ordinary MARS
import { isCourseProfile } from '../profiles/profileIds';
import type { CustomInstructionMode } from './api';

export function customInstructionModeForProfile(profile: unknown): CustomInstructionMode {
  return isCourseProfile(profile) ? profile : 'mars';
}
