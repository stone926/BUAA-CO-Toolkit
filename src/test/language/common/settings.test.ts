import { describe, it, expect } from 'vitest';
import {
  defaultCoSettings,
  defaultDisabledVerilogLintRules,
  diagnosticCodeKey,
  diagnosticFileCodeKey,
  diagnosticCodeToString,
  isDiagnosticCodeDisabled,
  isDiagnosticCodeDisabledForFile,
  isVerilogLintRuleEnabled,
  mergeCoSettings
} from '../../../language/common/settings';

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

  it('resolves empty project overrides from the selected Profile', () => {
    const result = mergeCoSettings({
      project: { profile: 'P1', topModule: '', testbench: '', machineCode: '', simTime: '' }
    });
    expect(result.project).toEqual({
      profile: 'P1',
      topModule: 'main',
      testbench: 'main_tb',
      machineCode: 'code.txt',
      simTime: '200us'
    });
  });

  it('keeps blank auto top and testbench values deferred for Profile inference', () => {
    const result = mergeCoSettings({
      project: { profile: 'auto', topModule: ' ', testbench: '' }
    });

    expect(result.project.topModule).toBe('');
    expect(result.project.testbench).toBe('');
    expect(result.project.machineCode).toBe('code.txt');
    expect(result.project.simTime).toBe('200us');
  });

  it('preserves explicit non-standard project overrides', () => {
    const result = mergeCoSettings({
      project: { profile: 'P1', topModule: 'custom_top', testbench: 'custom_tb' }
    });
    expect(result.project.topModule).toBe('custom_top');
    expect(result.project.testbench).toBe('custom_tb');
  });

  it('merges a partial mips section', () => {
    const result = mergeCoSettings({ mips: { warnPseudoInstruction: false } });
    expect(result.mips.warnPseudoInstruction).toBe(false);
    expect(result.mips.instructionTokenMode).toBe(defaultCoSettings.mips.instructionTokenMode);
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
    expect(result.verilog.lint.disabledRules).toEqual(defaultCoSettings.verilog.lint.disabledRules);
    expect(result.verilog.implicitNet).toEqual(defaultCoSettings.verilog.implicitNet);
    expect(result.verilog.format).toEqual(defaultCoSettings.verilog.format);
  });

  it('merges and normalizes Verilog format settings', () => {
    const result = mergeCoSettings({
      verilog: {
        format: {
          continuationIndent: 0,
          spaceInRange: false,
          declarationRangeSpacing: 'compact',
          alignment: {
            parameter: 'equals',
            modulePort: 'name',
            ternary: 'question'
          },
          maxBlankLines: -1
        }
      }
    });
    expect(result.verilog.format.continuationIndent).toBe(1);
    expect(result.verilog.format.spaceInRange).toBe(false);
    expect(result.verilog.format.declarationRangeSpacing).toBe('compact');
    expect(result.verilog.format.parameterAlignment).toBe('equals');
    expect(result.verilog.format.modulePortAlignment).toBe('name');
    expect(result.verilog.format.ternaryAlignment).toBe('question');
    expect(result.verilog.format.maxBlankLines).toBe(0);
  });

  it('normalizes backend-neutral external Verilog syntax settings', () => {
    const result = mergeCoSettings({
      verilog: {
        syntax: {
          external: {
            mode: 'commandOnly',
            timeoutMs: 700000
          }
        }
      }
    });
    expect(result.verilog.syntax.external).toEqual({
      mode: 'commandOnly',
      timeoutMs: 600000
    });
  });

  it('ignores removed ISE syntax trigger keys', () => {
    const result = mergeCoSettings({
      verilog: {
        syntax: {
          ise: {
            enabled: false,
            mode: 'off',
            timeoutMs: 1234
          }
        }
      }
    });
    expect(result.verilog.syntax.external).toEqual(defaultCoSettings.verilog.syntax.external);
    expect(result.verilog.syntax.ise).toEqual(defaultCoSettings.verilog.syntax.ise);
  });

  it('ignores old flattened Verilog format alignment keys', () => {
    const result = mergeCoSettings({
      verilog: {
        format: {
          parameterAlignment: 'none',
          modulePortAlignment: 'none',
          ternaryAlignment: 'none'
        }
      }
    });
    expect(result.verilog.format.parameterAlignment).toBe(defaultCoSettings.verilog.format.parameterAlignment);
    expect(result.verilog.format.modulePortAlignment).toBe(defaultCoSettings.verilog.format.modulePortAlignment);
    expect(result.verilog.format.ternaryAlignment).toBe(defaultCoSettings.verilog.format.ternaryAlignment);
  });

  it('defaults selected Verilog course lint rules to disabled', () => {
    const result = mergeCoSettings({});
    expect(result.verilog.lint.disabledRules).toEqual([...defaultDisabledVerilogLintRules]);
    expect(isVerilogLintRuleEnabled(result, 'vc-001')).toBe(false);
    expect(isVerilogLintRuleEnabled(result, 'VC-002')).toBe(true);
  });

  it('normalizes custom disabled Verilog lint rules', () => {
    const result = mergeCoSettings({ verilog: { lint: { disabledRules: ['VC-002', 'bad', 'vc-999', 'vc-002', ' vc-017 '] } } });
    expect(result.verilog.lint.disabledRules).toEqual(['vc-002', 'vc-017']);
  });

  it('normalizes disabled diagnostic codes', () => {
    const result = mergeCoSettings({
      diagnostics: {
        disabledCodes: [' Verilog:SYNTH-MUL-DIV ', 'bad code', 'verilog:synth-mul-div', 'mipsasm:co-section-address']
      }
    });
    expect(result.diagnostics.disabledCodes).toEqual(['mipsasm:co-section-address', 'verilog:synth-mul-div']);
    expect(diagnosticCodeKey('Verilog', 'SYNTH-MUL-DIV')).toBe('verilog:synth-mul-div');
    expect(diagnosticCodeToString(' missing-endmodule ')).toBe('missing-endmodule');
    expect(isDiagnosticCodeDisabled(result, 'verilog', 'SYNTH-MUL-DIV')).toBe(true);
    expect(isDiagnosticCodeDisabled(result, 'mipsasm', 'co-section-address')).toBe(true);
  });

  it('normalizes disabled file diagnostic codes', () => {
    const uri = 'file:///work/cpu.v';
    const result = mergeCoSettings({
      diagnostics: {
        disabledFileCodes: [
          ` Verilog:SYNTH-MUL-DIV@${uri} `,
          'bad code@file:///work/cpu.v',
          `verilog:synth-mul-div@${uri}`
        ]
      }
    });

    expect(result.diagnostics.disabledFileCodes).toEqual([`verilog:synth-mul-div@${uri}`]);
    expect(diagnosticFileCodeKey('Verilog', 'SYNTH-MUL-DIV', uri)).toBe(`verilog:synth-mul-div@${uri}`);
    expect(isDiagnosticCodeDisabledForFile(result, 'verilog', 'SYNTH-MUL-DIV', uri)).toBe(true);
    expect(isDiagnosticCodeDisabledForFile(result, 'verilog', 'SYNTH-MUL-DIV', 'file:///work/other.v')).toBe(false);
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
