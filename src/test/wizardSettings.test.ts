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

  it('keeps Logisim and Java paths global and trims user input', () => {
    expect(buildWizardSettingUpdates('P7', {
      java: '  C:\\Java\\bin\\java.exe  ',
      logisim: ''
    }, true)).toEqual([
      { key: 'project.profile', value: 'P7', target: 'workspaceFolder' },
      { key: 'toolchain.java', value: 'C:\\Java\\bin\\java.exe', target: 'global' }
    ]);
  });

  it('does not write redundant Profile-derived project defaults', () => {
    const keys = buildWizardSettingUpdates('P7', { java: 'java' }, true)
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
      logisim: 'C:\\Tools\\logisim.jar'
    }, true, {
      logisim: { workspaceFolder: true, workspace: true }
    })).toEqual([
      { key: 'project.profile', value: 'P7', target: 'workspaceFolder' },
      { key: 'toolchain.logisim', value: 'C:\\Tools\\logisim.jar', target: 'global' },
      { key: 'toolchain.logisim', value: undefined, target: 'workspaceFolder' },
      { key: 'toolchain.logisim', value: undefined, target: 'workspace' }
    ]);
  });

  it('never clears a folder setting when no resource folder is in scope', () => {
    expect(buildWizardSettingUpdates('P2', {
      java: 'C:\\Java\\bin\\java.exe'
    }, false, {
      java: { workspaceFolder: true, workspace: true }
    })).toEqual([
      { key: 'project.profile', value: 'P2', target: 'workspace' },
      { key: 'toolchain.java', value: 'C:\\Java\\bin\\java.exe', target: 'global' },
      { key: 'toolchain.java', value: undefined, target: 'workspace' }
    ]);
  });

  it('inspects only paths written by this run and detects both shadowing scopes', () => {
    const updates = buildWizardSettingUpdates('P3', { logisim: 'C:\\Tools\\logisim.jar' }, true);
    const inspected: string[] = [];

    expect(inspectWizardToolchainLegacyScopes(updates, true, (key) => {
      inspected.push(key);
      return { workspaceValue: 'D:/old-workspace', workspaceFolderValue: 'D:/old-folder' };
    })).toEqual({
      logisim: { workspace: true, workspaceFolder: true }
    });
    expect(inspected).toEqual(['toolchain.logisim']);
  });
});
