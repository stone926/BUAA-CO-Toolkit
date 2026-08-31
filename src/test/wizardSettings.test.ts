import { describe, expect, it } from 'vitest';
import {
  buildWizardSettingUpdates,
  inspectWizardToolchainLegacyScopes
} from '../wizardSettings';

describe('buildWizardSettingUpdates', () => {
  it('persists only the Profile inside a workspace folder', () => {
    expect(buildWizardSettingUpdates('P1', {}, true)).toEqual([
      { key: 'project.profile', value: 'P1', target: 'workspaceFolder' }
    ]);
  });

  it('keeps machine paths global and trims user input', () => {
    expect(buildWizardSettingUpdates('P7', {
      mars: '  C:\\Tools\\Mars.jar  ',
      logisim: '',
      isePath: ''
    }, true)).toEqual([
      { key: 'project.profile', value: 'P7', target: 'workspaceFolder' },
      { key: 'toolchain.mars', value: 'C:\\Tools\\Mars.jar', target: 'global' },
      { key: 'toolchain.isePath', value: '', target: 'global' }
    ]);
  });

  it('does not write redundant Profile-derived project defaults', () => {
    const keys = buildWizardSettingUpdates('P7', { python: 'python3' }, true)
      .map((update) => update.key);

    expect(keys).not.toEqual(expect.arrayContaining([
      'project.topModule',
      'project.testbench',
      'project.machineCode',
      'project.simTime'
    ]));
  });

  it('writes a machine path before clearing legacy values that would shadow it', () => {
    expect(buildWizardSettingUpdates('P7', {
      mars: 'C:\\Tools\\Mars.jar'
    }, true, {
      mars: { workspaceFolder: true, workspace: true }
    })).toEqual([
      { key: 'project.profile', value: 'P7', target: 'workspaceFolder' },
      { key: 'toolchain.mars', value: 'C:\\Tools\\Mars.jar', target: 'global' },
      { key: 'toolchain.mars', value: undefined, target: 'workspaceFolder' },
      { key: 'toolchain.mars', value: undefined, target: 'workspace' }
    ]);
  });

  it('migrates an explicit blank ISE choice so an old project value cannot re-enable ISE', () => {
    expect(buildWizardSettingUpdates('P7', {
      isePath: ''
    }, true, {
      isePath: { workspaceFolder: true, workspace: true }
    })).toEqual([
      { key: 'project.profile', value: 'P7', target: 'workspaceFolder' },
      { key: 'toolchain.isePath', value: '', target: 'global' },
      { key: 'toolchain.isePath', value: undefined, target: 'workspaceFolder' },
      { key: 'toolchain.isePath', value: undefined, target: 'workspace' }
    ]);
  });

  it('never clears a folder setting when no resource folder is in scope', () => {
    expect(buildWizardSettingUpdates('P2', {
      mars: 'C:\\Tools\\Mars.jar'
    }, false, {
      mars: { workspaceFolder: true, workspace: true }
    })).toEqual([
      { key: 'project.profile', value: 'P2', target: 'workspace' },
      { key: 'toolchain.mars', value: 'C:\\Tools\\Mars.jar', target: 'global' },
      { key: 'toolchain.mars', value: undefined, target: 'workspace' }
    ]);
  });

  it('inspects only paths written by this run and detects both shadowing scopes', () => {
    const updates = buildWizardSettingUpdates('P7', { isePath: '' }, true);
    const inspected: string[] = [];

    expect(inspectWizardToolchainLegacyScopes(updates, true, (key) => {
      inspected.push(key);
      return { workspaceValue: 'D:/old-workspace', workspaceFolderValue: 'D:/old-folder' };
    })).toEqual({
      isePath: { workspace: true, workspaceFolder: true }
    });
    expect(inspected).toEqual(['toolchain.isePath']);
  });
});
