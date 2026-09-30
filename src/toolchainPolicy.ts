// @index toolchain — course tool dependency policy

import type { MipsEngineMode } from './config';
import { getProfileRequiredTools } from './courseConfig';
import type { ProjectProfile } from './projectProfile';

/**
 * Course assembly and execution always use builtin providers. Historical engine
 * settings cannot introduce external dependencies; P2 still uses official MARS.
 */
export function getEffectiveRequiredTools(
  profile: ProjectProfile,
  _mode: MipsEngineMode
): string[] {
  const tools = [...getProfileRequiredTools(profile)];
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
