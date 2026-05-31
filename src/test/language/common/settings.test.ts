import { describe, it, expect } from 'vitest';
import { mergeCoSettings, defaultCoSettings } from '../../../language/common/settings';

describe('mergeCoSettings', () => {
  it('returns defaults when given null', () => {
    const result = mergeCoSettings(null);
    expect(result).toEqual(defaultCoSettings);
  });

  it('returns defaults when given undefined', () => {
    const result = mergeCoSettings(undefined);
    expect(result).toEqual(defaultCoSettings);
  });

  it('returns defaults when given a non-object (string)', () => {
    const result = mergeCoSettings('invalid');
    expect(result).toEqual(defaultCoSettings);
  });

  it('returns defaults when given a non-object (number)', () => {
    const result = mergeCoSettings(42);
    expect(result).toEqual(defaultCoSettings);
  });

  it('merges a partial project section', () => {
    const result = mergeCoSettings({ project: { profile: 'P5' } });
    expect(result.project.profile).toBe('P5');
    expect(result.project.topModule).toBe(defaultCoSettings.project.topModule);
    expect(result.project.testbench).toBe(defaultCoSettings.project.testbench);
  });

  it('merges a partial mips section', () => {
    const result = mergeCoSettings({ mips: { warnPseudoInstruction: false } });
    expect(result.mips.warnPseudoInstruction).toBe(false);
    expect(result.mips.instructionColorMode).toBe(defaultCoSettings.mips.instructionColorMode);
    expect(result.mips.warnMissingExitSyscall).toBe(defaultCoSettings.mips.warnMissingExitSyscall);
  });

  it('merges a partial verilog.implicitNet section', () => {
    const result = mergeCoSettings({ verilog: { implicitNet: { diagnostic: 'error' } } });
    expect(result.verilog.implicitNet.diagnostic).toBe('error');
    expect(result.verilog.implicitNet.ignorePatterns).toEqual(defaultCoSettings.verilog.implicitNet.ignorePatterns);
    expect(result.verilog.lint).toEqual(defaultCoSettings.verilog.lint);
  });

  it('merges a partial verilog.lint section', () => {
    const result = mergeCoSettings({ verilog: { lint: { courseRules: false } } });
    expect(result.verilog.lint.courseRules).toBe(false);
    expect(result.verilog.lint.synthesizableHints).toBe(defaultCoSettings.verilog.lint.synthesizableHints);
    expect(result.verilog.implicitNet).toEqual(defaultCoSettings.verilog.implicitNet);
  });

  it('merges multiple sections at once', () => {
    const result = mergeCoSettings({
      project: { profile: 'P7', topModule: 'cpu' },
      mips: { warnPseudoInstruction: false },
      verilog: { lint: { synthesizableHints: false } }
    });
    expect(result.project.profile).toBe('P7');
    expect(result.project.topModule).toBe('cpu');
    expect(result.project.testbench).toBe(defaultCoSettings.project.testbench);
    expect(result.mips.warnPseudoInstruction).toBe(false);
    expect(result.verilog.lint.synthesizableHints).toBe(false);
  });

  it('ignores extra keys gracefully', () => {
    const result = mergeCoSettings({ unknownKey: 'value', project: { profile: 'P3' } });
    expect(result.project.profile).toBe('P3');
  });

  it('handles empty object', () => {
    const result = mergeCoSettings({});
    expect(result).toEqual(defaultCoSettings);
  });

  it('completely overrides project section when all fields are provided', () => {
    const full = {
      project: {
        profile: 'P6' as const,
        topModule: 'cpu',
        testbench: 'cpu_tb',
        machineCode: 'im.hex',
        simTime: '500us'
      }
    };
    const result = mergeCoSettings(full);
    expect(result.project).toEqual(full.project);
  });
});
