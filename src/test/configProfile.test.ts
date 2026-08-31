import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.hoisted runs before vi.mock and module imports
const { configStore } = vi.hoisted(() => ({
  configStore: new Map<string, any>()
}));

vi.mock('vscode', () => ({
  workspace: {
    getWorkspaceFolder(resource?: { fsPath?: string }) {
      return resource?.fsPath?.startsWith('/workspace') ? { uri: resource } : undefined;
    },
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
  configurationTargetForResource,
  getAutomaticTestInstructions,
  getMachineCode,
  getMipsEngine,
  getMarsJar,
  getMarsP7Jar,
  getMemoryConfiguration,
  getSimTime,
  getTestbench,
  getTopModule,
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

describe('automatic test instruction setting migration', () => {
  beforeEach(() => {
    clearConfig();
  });

  it('uses the new sole public setting', () => {
    setConfig('co.test.instructions', ' add , ori ');
    setConfig('co.test.builtinGenerator.instructions', 'sub');
    expect(getAutomaticTestInstructions()).toBe('add , ori');
  });

  it('reads the old instruction key only when the new key is absent', () => {
    setConfig('co.test.builtinGenerator.instructions', 'sub lw');
    expect(getAutomaticTestInstructions()).toBe('sub lw');
  });

  it('lets an explicitly empty new setting reset a migrated legacy value', () => {
    setConfig('co.test.instructions', '');
    setConfig('co.test.builtinGenerator.instructions', 'sub lw');
    expect(getAutomaticTestInstructions()).toBe('');
  });
});

describe('resource-scoped configuration targets', () => {
  it('uses WorkspaceFolder only for a resource owned by a folder', () => {
    expect(configurationTargetForResource(makeUri('/workspace/project.asm'))).toBe(3);
    expect(configurationTargetForResource(makeUri('/outside/project.asm'))).toBe(1);
    expect(configurationTargetForResource()).toBe(1);
  });
});

describe('profile-derived project defaults', () => {
  beforeEach(() => {
    clearConfig();
  });

  it('uses the P1 course defaults without wizard-written overrides', () => {
    setConfig('co.project.profile', 'P1');

    expect(getTopModule()).toBe('main');
    expect(getTestbench()).toBe('main_tb');
    expect(getMachineCode()).toBe('code.txt');
    expect(getSimTime()).toBe('200us');
  });

  it('uses the CPU course defaults for P7', () => {
    setConfig('co.project.profile', 'P7');

    expect(getTopModule()).toBe('mips');
    expect(getTestbench()).toBe('mips_tb');
    expect(getMachineCode()).toBe('code.txt');
    expect(getSimTime()).toBe('200us');
  });

  it('keeps an explicit non-standard project override', () => {
    setConfig('co.project.profile', 'P1');
    setConfig('co.project.topModule', 'custom_top');
    setConfig('co.project.testbench', 'custom_tb');

    expect(getTopModule()).toBe('custom_top');
    expect(getTestbench()).toBe('custom_tb');
  });

  it('uses generic defaults while Profile remains auto', () => {
    setConfig('co.project.profile', 'auto');

    expect(getTopModule()).toBe('mips');
    expect(getTestbench()).toBe('mips_tb');
  });
});

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

  it('reads the dedicated P7 key without falling back through the current profile', () => {
    setConfig('co.project.profile', 'P6');
    setConfig('co.toolchain.mars', '/opt/mars/Generic.jar');

    expect(getMarsP7Jar()).toBe('');

    setConfig('co.toolchain.marsP7', '/opt/mars/P7.jar');
    expect(getMarsP7Jar()).toBe('/opt/mars/P7.jar');
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

describe('getMipsEngine', () => {
  beforeEach(() => {
    clearConfig();
  });

  it('defaults to auto', () => {
    expect(getMipsEngine()).toBe('auto');
  });

  it.each(['auto', 'builtin', 'mars', 'verify-both'] as const)(
    'accepts the supported %s mode',
    (mode) => {
      setConfig('co.mips.engine', mode);
      expect(getMipsEngine()).toBe(mode);
    }
  );

  it('normalizes a resource-scoped value', () => {
    setConfig('co.mips.engine', ' BUILTIN ');
    expect(getMipsEngine(makeUri('/workspace/project.asm'))).toBe('builtin');
  });

  it('falls back to auto for an invalid value', () => {
    setConfig('co.mips.engine', 'unknown-engine');
    expect(getMipsEngine()).toBe('auto');
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
