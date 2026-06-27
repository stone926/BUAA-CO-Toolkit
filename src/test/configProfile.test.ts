import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.hoisted runs before vi.mock and module imports
const { configStore } = vi.hoisted(() => ({
  configStore: new Map<string, any>()
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration(section: string, _resource?: any) {
      return {
        get<T>(key: string): T | undefined {
          return configStore.get(`${section}.${key}`) as T | undefined;
        },
        inspect<T>(key: string) {
          const fullKey = `${section}.${key}`;
          const value = configStore.get(fullKey);
          if (value !== undefined) {
            return {
              workspaceFolderValue: value,
              workspaceValue: undefined,
              globalValue: undefined,
              key,
              defaultValue: undefined,
              workspaceLanguageValue: undefined,
              globalLanguageValue: undefined
            };
          }
          return {
            key,
            defaultValue: undefined,
            workspaceFolderValue: undefined,
            workspaceValue: undefined,
            globalValue: undefined,
            workspaceLanguageValue: undefined,
            globalLanguageValue: undefined
          };
        }
      };
    }
  },
  Uri: {
    parse(s: string) {
      return { scheme: 'file', fsPath: s, path: s };
    },
    file(s: string) {
      return { scheme: 'file', fsPath: s, path: s };
    }
  },
  window: {
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showWarningMessage: vi.fn()
  },
  ConfigurationTarget: { Workspace: 1, Global: 2, WorkspaceFolder: 3 }
}));

import {
  getMarsJar,
  getMemoryConfiguration,
  useDelayedBranching
} from '../config';
import type * as vscode from 'vscode';

function setConfig(key: string, value: any): void {
  configStore.set(key, value);
}

function clearConfig(): void {
  configStore.clear();
}

function makeUri(fsPath = '/test/asm/test.asm'): vscode.Uri {
  return { scheme: 'file', fsPath, path: fsPath } as vscode.Uri;
}

describe('getMarsJar', () => {
  beforeEach(() => {
    clearConfig();
  });

  it('returns mars path for non-P7 profile', () => {
    setConfig('co.project.profile', 'P5');
    setConfig('co.toolchain.mars', '/opt/mars/Mars.jar');

    expect(getMarsJar()).toBe('/opt/mars/Mars.jar');
  });

  it('returns marsP7 path for P7 profile when marsP7 is set', () => {
    setConfig('co.project.profile', 'P7');
    setConfig('co.toolchain.marsP7', '/opt/mars/MarsP7.jar');
    setConfig('co.toolchain.mars', '/opt/mars/Mars.jar');

    expect(getMarsJar()).toBe('/opt/mars/MarsP7.jar');
  });

  it('falls back to mars when P7 profile has no marsP7 configured', () => {
    setConfig('co.project.profile', 'P7');
    setConfig('co.toolchain.mars', '/opt/mars/Mars.jar');
    // marsP7 not set — should fall back to mars

    expect(getMarsJar()).toBe('/opt/mars/Mars.jar');
  });

  it('returns mars when P7 profile has empty marsP7', () => {
    setConfig('co.project.profile', 'P7');
    setConfig('co.toolchain.marsP7', '');
    setConfig('co.toolchain.mars', '/opt/mars/Mars.jar');

    expect(getMarsJar()).toBe('/opt/mars/Mars.jar');
  });

  it('returns empty string when nothing is configured', () => {
    setConfig('co.project.profile', 'P5');
    // mars not set

    expect(getMarsJar()).toBe('');
  });

  it('respects resource-scoped configuration', () => {
    const uri = makeUri('/workspace/project.asm');
    setConfig('co.project.profile', 'P5');
    setConfig('co.toolchain.mars', '/opt/mars/Mars.jar');

    expect(getMarsJar(uri)).toBe('/opt/mars/Mars.jar');
  });
});

describe('getMemoryConfiguration', () => {
  beforeEach(() => {
    clearConfig();
  });

  it('returns CompactLargeText for P7 profile', () => {
    setConfig('co.project.profile', 'P7');

    expect(getMemoryConfiguration()).toBe('CompactLargeText');
  });

  it('returns FixedCompactLargeText for non-P7 profile', () => {
    setConfig('co.project.profile', 'P5');

    expect(getMemoryConfiguration()).toBe('FixedCompactLargeText');
  });

  it('returns FixedCompactLargeText for P4', () => {
    setConfig('co.project.profile', 'P4');

    expect(getMemoryConfiguration()).toBe('FixedCompactLargeText');
  });

  it('returns CompactLargeText for P7 even when explicit setting says auto', () => {
    setConfig('co.project.profile', 'P7');
    setConfig('co.mips.memoryConfiguration', 'auto');

    expect(getMemoryConfiguration()).toBe('CompactLargeText');
  });

  it('returns explicit setting when configured', () => {
    setConfig('co.project.profile', 'P5');
    setConfig('co.mips.memoryConfiguration', 'CompactDataAtZero');

    expect(getMemoryConfiguration()).toBe('CompactDataAtZero');
  });

  it('explicit setting overrides P7 default', () => {
    setConfig('co.project.profile', 'P7');
    setConfig('co.mips.memoryConfiguration', 'FixedCompactLargeText');

    expect(getMemoryConfiguration()).toBe('FixedCompactLargeText');
  });
});

describe('useDelayedBranching', () => {
  beforeEach(() => {
    clearConfig();
  });

  it('returns true for P5 in profile mode', () => {
    setConfig('co.project.profile', 'P5');
    setConfig('co.mips.delayedBranching', 'profile');

    expect(useDelayedBranching()).toBe(true);
  });

  it('returns true for P6 in profile mode', () => {
    setConfig('co.project.profile', 'P6');
    setConfig('co.mips.delayedBranching', 'profile');

    expect(useDelayedBranching()).toBe(true);
  });

  it('returns true for P7 in profile mode', () => {
    setConfig('co.project.profile', 'P7');
    setConfig('co.mips.delayedBranching', 'profile');

    expect(useDelayedBranching()).toBe(true);
  });

  it('returns false for P4 in profile mode', () => {
    setConfig('co.project.profile', 'P4');
    setConfig('co.mips.delayedBranching', 'profile');

    expect(useDelayedBranching()).toBe(false);
  });

  it('returns true when explicitly on regardless of profile', () => {
    setConfig('co.project.profile', 'P4');
    setConfig('co.mips.delayedBranching', 'on');

    expect(useDelayedBranching()).toBe(true);
  });

  it('returns false when explicitly off regardless of profile', () => {
    setConfig('co.project.profile', 'P7');
    setConfig('co.mips.delayedBranching', 'off');

    expect(useDelayedBranching()).toBe(false);
  });
});
