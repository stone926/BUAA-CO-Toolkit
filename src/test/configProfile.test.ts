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
  getAutomaticTestConcurrency,
  getMachineCode,
  getMipsEngine,
  getMarsJar,
  getMarsP7Jar,
  getMemoryConfiguration,
  getRunTimeout,
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

describe('manual tool timeout compatibility', () => {
  beforeEach(clearConfig);

  it.each([0, -1, 1.5, NaN, Infinity, 0x80000000, '120000'])('uses the default budget for retired or invalid value %s', (value) => {
    const fallback = getRunTimeout(makeUri());
    setConfig('co.run.timeoutMs', value);
    expect(getRunTimeout(makeUri())).toBe(fallback);
    expect(fallback).toBeGreaterThan(0);
  });

  it('preserves a valid explicit budget', () => {
    setConfig('co.run.timeoutMs', 12345);
    expect(getRunTimeout(makeUri())).toBe(12345);
  });
});

describe('automatic test concurrency', () => {
  beforeEach(clearConfig);

  it.each([[1, 1], [4, 4], [20, 8], [0, 1], [3.9, 3], [NaN, 4], [Infinity, 4], ['4', 4]])(
    'bounds configured value %s to %s', (value, expected) => {
      setConfig('co.test.concurrency', value);
      expect(getAutomaticTestConcurrency()).toBe(expected);
    }
  );

  it('defaults to four slots', () => expect(getAutomaticTestConcurrency()).toBe(4));
});

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

describe('retired external MARS settings', () => {
  beforeEach(() => {
    clearConfig();
  });

  it('ignores configured MARS and P7 override paths', () => {
    setConfig('co.toolchain.mars', '/opt/mars/Mars.jar');
    setConfig('co.toolchain.marsP7', '/opt/mars/MarsP7.jar');
    expect(getMarsJar()).toBe('');
    expect(getMarsP7Jar()).toBe('');
  });
});

describe('getMemoryConfiguration', () => {
  beforeEach(() => {
    clearConfig();
  });

  it('returns the official Default configuration for P7', () => {
    setConfig('co.project.profile', 'P7');

    expect(getMemoryConfiguration()).toBe('Default');
  });

  it('returns the official Default configuration for non-P7 profiles', () => {
    setConfig('co.project.profile', 'P5');

    expect(getMemoryConfiguration()).toBe('Default');
  });

  it('returns the official Default configuration for P4', () => {
    setConfig('co.project.profile', 'P4');

    expect(getMemoryConfiguration()).toBe('Default');
  });

  it('migrates the old auto memory setting to Default', () => {
    setConfig('co.project.profile', 'P7');
    setConfig('co.mips.memoryConfiguration', 'auto');

    expect(getMemoryConfiguration()).toBe('Default');
  });

  it('returns explicit setting when configured', () => {
    setConfig('co.project.profile', 'P5');
    setConfig('co.mips.memoryConfiguration', 'CompactDataAtZero');

    expect(getMemoryConfiguration()).toBe('CompactDataAtZero');
  });

  it.each(['FixedCompactLargeText', 'CompactLargeText', 'invalid-mode', ''])('migrates %s to official Default', (mode) => {
    setConfig('co.project.profile', 'P7');
    setConfig('co.mips.memoryConfiguration', mode);

    expect(getMemoryConfiguration()).toBe('Default');
  });

  it.each(['Default', 'CompactDataAtZero', 'CompactTextAtZero'])('normalizes official %s names', (mode) => {
    setConfig('co.mips.memoryConfiguration', ` ${mode.toLowerCase()} `);
    expect(getMemoryConfiguration(makeUri())).toBe(mode);
  });
});

describe('getMipsEngine', () => {
  beforeEach(() => {
    clearConfig();
  });

  it('defaults to auto', () => {
    expect(getMipsEngine()).toBe('auto');
  });

  it.each(['auto', 'builtin'] as const)(
    'accepts the supported %s mode',
    (mode) => {
      setConfig('co.mips.engine', mode);
      expect(getMipsEngine()).toBe(mode);
    }
  );

  it.each(['mars', 'verify-both'] as const)('migrates the old %s engine to auto', (mode) => {
    setConfig('co.mips.engine', ` ${mode.toUpperCase()} `);
    expect(getMipsEngine(makeUri())).toBe('auto');
  });

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
