import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  globalValue: undefined as unknown,
  updateConfiguration: vi.fn(),
  updateState: vi.fn(),
  output: vi.fn()
}));

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: () => ({
      inspect: () => ({ globalValue: mocks.globalValue }),
      update: mocks.updateConfiguration
    })
  }
}));

import { migrateLegacySemanticColorRules } from '../legacySemanticColorMigration';

function contextWith(stored: unknown) {
  return {
    globalState: {
      get: vi.fn(() => stored),
      update: mocks.updateState
    }
  } as never;
}

const output = { appendLine: mocks.output } as never;

describe('legacy semantic color migration', () => {
  beforeEach(() => {
    mocks.globalValue = undefined;
    mocks.updateConfiguration.mockReset();
    mocks.updateState.mockReset();
    mocks.output.mockReset();
  });

  it('removes only exact legacy string rules and preserves user-owned rules', async () => {
    mocks.globalValue = {
      enabled: true,
      rules: {
        mipsRegister: '#4FC1FF',
        verilogPort: '#abcdef',
        verilogModule: { foreground: '#4EC9B0', bold: true },
        userToken: '#123456'
      }
    };

    await migrateLegacySemanticColorRules(contextWith({
      mipsRegister: '#4FC1FF',
      verilogPort: '#9CDCFE',
      verilogModule: '#4EC9B0'
    }), output);

    expect(mocks.updateConfiguration).toHaveBeenCalledWith(
      'semanticTokenColorCustomizations',
      {
        enabled: true,
        rules: {
          verilogPort: '#abcdef',
          verilogModule: { foreground: '#4EC9B0', bold: true },
          userToken: '#123456'
        }
      },
      1
    );
    expect(mocks.updateState).toHaveBeenCalledWith('semanticColors.lastAppliedRules', undefined);
  });

  it('does nothing after the one-time legacy state has been cleared', async () => {
    await migrateLegacySemanticColorRules(contextWith(undefined), output);

    expect(mocks.updateConfiguration).not.toHaveBeenCalled();
    expect(mocks.updateState).not.toHaveBeenCalled();
  });

  it('clears legacy state without rewriting colors when every rule was changed by the user', async () => {
    mocks.globalValue = { rules: { mipsRegister: '#000000' } };

    await migrateLegacySemanticColorRules(contextWith({ mipsRegister: '#4FC1FF' }), output);

    expect(mocks.updateConfiguration).not.toHaveBeenCalled();
    expect(mocks.updateState).toHaveBeenCalledWith('semanticColors.lastAppliedRules', undefined);
  });
});
