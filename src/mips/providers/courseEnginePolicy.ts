// @index mips-providers — phase-6 course engine selection: pure, atomic and fail-closed

import type { MipsEngineMode } from '../../config';

/** Stable provider ids shared by policy, descriptors and replay evidence. */
export const LEGACY_MARS_ENGINE_ID = 'legacy-mars-configured' as const;
export const BUILTIN_TS_ENGINE_ID = 'builtin-ts' as const;

export type CourseProviderEngineId =
  | typeof LEGACY_MARS_ENGINE_ID
  | typeof BUILTIN_TS_ENGINE_ID;

export interface CourseEngineCapabilityRequest {
  readonly deterministicConsole?: boolean;
  readonly interactiveConsole?: boolean;
}

/**
 * One immutable decision covers both assembly and execution. A lane has one
 * engine id deliberately: callers cannot accidentally assemble with one
 * provider and execute with another while claiming a full-stack run.
 */
export interface CourseEnginePlan {
  readonly mode: MipsEngineMode;
  readonly profile?: string;
  readonly primaryEngineId: CourseProviderEngineId;
  /** Present only for the explicit verify-both mode. */
  readonly verificationEngineId?: typeof LEGACY_MARS_ENGINE_ID;
}

/** A plan and its case/request profile are one atomic semantic decision. */
export function courseEnginePlanProfileError(
  plan: CourseEnginePlan,
  profile: string
): string | undefined {
  return plan.profile !== undefined && plan.profile !== profile
    ? `course engine plan profile ${plan.profile} differs from case profile ${profile}`
    : undefined;
}

const builtinDefaultProfiles = new Set(['P3', 'P4', 'P5', 'P6', 'P7']);

/**
 * Resolve a course engine without consulting configuration, the filesystem or
 * provider preflight. The selected provider is final: a later capability or
 * runtime failure must be reported and must never trigger fallback.
 */
export function resolveCourseEnginePlan(
  mode: MipsEngineMode,
  profile: string | undefined,
  capabilities: CourseEngineCapabilityRequest = {}
): CourseEnginePlan {
  const consoleRequiresLegacy = capabilities.deterministicConsole === true
    || capabilities.interactiveConsole === true;

  let primaryEngineId: CourseProviderEngineId;
  switch (mode) {
    case 'builtin':
    case 'verify-both':
      primaryEngineId = BUILTIN_TS_ENGINE_ID;
      break;
    case 'mars':
      primaryEngineId = LEGACY_MARS_ENGINE_ID;
      break;
    case 'auto':
      primaryEngineId = !consoleRequiresLegacy && profile !== undefined
        && builtinDefaultProfiles.has(profile)
        ? BUILTIN_TS_ENGINE_ID
        : LEGACY_MARS_ENGINE_ID;
      break;
  }

  return Object.freeze({
    mode,
    ...(profile === undefined ? {} : { profile }),
    primaryEngineId,
    ...(mode === 'verify-both' ? { verificationEngineId: LEGACY_MARS_ENGINE_ID } : {})
  });
}
