// @index toolchain — mode-aware course tool dependency policy

import type { MipsEngineMode } from './config';
import { getProfileRequiredTools } from './courseConfig';
import type { ProjectProfile } from './projectProfile';

const courseEngineProfiles = new Set<ProjectProfile>(['P3', 'P4', 'P5', 'P6', 'P7']);

/**
 * Whether the selected course-engine mode includes a legacy MARS lane.
 * `verify-both` still needs the complete legacy toolchain for its reference run.
 */
export function includesLegacyMarsLane(mode: MipsEngineMode): boolean {
  return mode === 'mars' || mode === 'verify-both';
}

/**
 * Compute the tools a profile needs after applying the P3-P7 engine selection.
 * The course configuration remains the source of unconditional dependencies;
 * explicit legacy modes append only the dependencies introduced by that lane.
 */
export function getEffectiveRequiredTools(
  profile: ProjectProfile,
  mode: MipsEngineMode
): string[] {
  const tools = [...getProfileRequiredTools(profile)];
  if (courseEngineProfiles.has(profile) && includesLegacyMarsLane(mode)) {
    tools.push('java', profile === 'P7' ? 'marsP7' : 'mars');
  }
  return deduplicateTools(tools);
}

function deduplicateTools(tools: readonly string[]): string[] {
  const seen = new Set<string>();
  return tools.filter((tool) => {
    const normalized = tool.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}
