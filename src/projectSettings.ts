// @index project-settings — project overrides and workspace defaults, independent of VS Code
import * as path from 'path';
import { normalizePathKey } from './pathUtils';
import { isConcreteProjectProfile, ProjectProfile } from './projectProfile';

export interface ProjectScope {
  name: string;
  rootPath: string;
  workspacePath: string;
  isolated: boolean;
}
export interface ProjectOverride {
  profile?: ProjectProfile;
  topModule?: string;
  testbench?: string;
  machineCode?: string;
  simTime?: string;
}
export type ProjectOverrides = Record<string, ProjectOverride>;

export function normalizeProjectOverrides(value: unknown): ProjectOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, raw]) => {
    if (!key.trim() || /[?*]/.test(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const entry = raw as Record<string, unknown>;
    const result: ProjectOverride = {};
    if (entry.profile === 'auto' || isConcreteProjectProfile(entry.profile)) result.profile = entry.profile;
    for (const field of ['topModule', 'testbench', 'machineCode', 'simTime'] as const) {
      if (typeof entry[field] === 'string' && entry[field].trim()) result[field] = entry[field].trim();
    }
    return Object.keys(result).length ? [[key.trim(), result]] : [];
  }));
}

/** Longest directory/file match wins. Scope anchors also bind shared dependencies. */
export function resolveProjectOverride(value: unknown, filePath: string, workspacePath: string, scopes: readonly ProjectScope[] = []): ProjectOverride | undefined {
  const entries = Object.entries(normalizeProjectOverrides(value)).map(([key, settings]) => ({
    key: normalizePathKey(path.resolve(workspacePath, key)).replace(/\/$/, ''), settings
  })).sort((a, b) => b.key.length - a.key.length);
  const resolve = (target: string, scope?: ProjectScope) => {
    const file = normalizePathKey(path.resolve(target));
    const anchor = scope && normalizePathKey(path.resolve(scope.rootPath));
    const boundary = anchor && (/\.vh?$/i.test(anchor) ? path.posix.dirname(anchor) : anchor);
    return entries.find(({ key }) => (!scope?.isolated || !boundary || key === boundary || key.startsWith(`${boundary}/`)) && (file === key || file.startsWith(`${key}/`)));
  };
  if (!scopes.length) return resolve(filePath)?.settings;
  const results = scopes.map((scope) => {
    const direct = resolve(filePath, scope);
    const owner = resolve(scope.rootPath, scope);
    return (direct && (!owner || direct.key.length > owner.key.length) ? direct : owner)?.settings;
  });
  // A shared source cannot silently inherit one caller's settings.
  return results.every((entry) => JSON.stringify(entry) === JSON.stringify(results[0])) ? results[0] : undefined;
}

/** Apply before normalizing defaults, so a project Profile supplies its own defaults. */
export function applyProjectOverride(value: unknown, filePath: string | undefined, workspacePath: string | undefined, scopes: readonly ProjectScope[] = []): unknown {
  if (!filePath || !workspacePath || !value || typeof value !== 'object') return value;
  const candidate = value as { project?: Record<string, unknown> };
  const override = resolveProjectOverride(candidate.project?.overrides, filePath, workspacePath, scopes);
  return override ? { ...candidate, project: { ...candidate.project, ...override, ...(override.profile ? { profileSource: 'project' } : {}) } } : value;
}
