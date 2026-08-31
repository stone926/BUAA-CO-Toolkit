// @index wizard-settings — 项目向导配置写入计划，分离课程资源与本机工具
import { ProjectProfile } from './types';

export interface WizardToolchainSettings {
  mars?: string;
  marsP7?: string;
  isePath?: string;
  logisim?: string;
  java?: string;
  python?: string;
  hazardCalculator?: string;
}

export interface WizardSettingUpdate {
  key: string;
  value: string | undefined;
  target: 'workspace' | 'workspaceFolder' | 'global';
}

export interface WizardLegacySettingScopes {
  workspace?: boolean;
  workspaceFolder?: boolean;
}

export type WizardToolchainLegacyScopes = Partial<Record<keyof WizardToolchainSettings, WizardLegacySettingScopes>>;

export interface WizardSettingInspection {
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/**
 * The wizard stores only course intent in the project. Profile-derived defaults
 * stay in courseConfig, while executable paths remain local to this machine.
 */
export function buildWizardSettingUpdates(
  profile: ProjectProfile,
  toolchain: WizardToolchainSettings,
  hasResource: boolean,
  legacyScopes: WizardToolchainLegacyScopes = {}
): WizardSettingUpdate[] {
  const updates: WizardSettingUpdate[] = [{
    key: 'project.profile',
    value: profile,
    target: hasResource ? 'workspaceFolder' : 'workspace'
  }];
  for (const [key, rawValue] of Object.entries(toolchain)) {
    if (typeof rawValue !== 'string') {
      continue;
    }
    const value = rawValue.trim();
    if (!value && key !== 'isePath') {
      continue;
    }
    updates.push({ key: `toolchain.${key}`, value, target: 'global' });
    const scopes = legacyScopes[key as keyof WizardToolchainSettings];
    if (hasResource && scopes?.workspaceFolder) {
      updates.push({ key: `toolchain.${key}`, value: undefined, target: 'workspaceFolder' });
    }
    if (scopes?.workspace) {
      updates.push({ key: `toolchain.${key}`, value: undefined, target: 'workspace' });
    }
  }
  return updates;
}

/** Discover only legacy scopes for tool paths that this wizard run will replace. */
export function inspectWizardToolchainLegacyScopes(
  updates: readonly WizardSettingUpdate[],
  hasResource: boolean,
  inspect: (key: string) => WizardSettingInspection | undefined
): WizardToolchainLegacyScopes {
  const scopes: WizardToolchainLegacyScopes = {};
  for (const update of updates) {
    if (update.target !== 'global' || !update.key.startsWith('toolchain.')) {
      continue;
    }
    const key = update.key.slice('toolchain.'.length) as keyof WizardToolchainSettings;
    const inspected = inspect(update.key);
    scopes[key] = {
      workspace: inspected?.workspaceValue !== undefined,
      workspaceFolder: hasResource && inspected?.workspaceFolderValue !== undefined
    };
  }
  return scopes;
}
