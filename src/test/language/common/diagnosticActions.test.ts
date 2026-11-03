import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { mergeCoSettings, disableDiagnosticCodeCommand } from '../../../language/common/settings';
import {
  filterDisabledDiagnostics,
  getDiagnosticSuppressActions
} from '../../../language/common/diagnosticActions';

describe('diagnostic suppress actions', () => {
  it('creates workspace and file quick fixes for each diagnostic code', () => {
    const diagnostics = [
      {
        range: Range.create(0, 0, 0, 1),
        message: 'missing endmodule',
        severity: DiagnosticSeverity.Error,
        code: 'missing-endmodule'
      },
      {
        range: Range.create(1, 0, 1, 1),
        message: 'duplicate missing endmodule',
        severity: DiagnosticSeverity.Error,
        code: 'missing-endmodule'
      },
      {
        range: Range.create(2, 0, 2, 1),
        message: 'width mismatch',
        severity: DiagnosticSeverity.Warning,
        code: 'width-mismatch'
      }
    ];
    const actions = getDiagnosticSuppressActions('verilog', diagnostics, mergeCoSettings({}), 'file:///work/cpu.v');
    expect(actions.map((action) => action.command?.command)).toEqual([
      disableDiagnosticCodeCommand,
      disableDiagnosticCodeCommand,
      disableDiagnosticCodeCommand,
      disableDiagnosticCodeCommand
    ]);
    expect(actions.map((action) => action.command?.arguments)).toEqual([
      ['verilog', 'missing-endmodule', 'file', 'file:///work/cpu.v'],
      ['verilog', 'missing-endmodule', 'workspace', 'file:///work/cpu.v'],
      ['verilog', 'width-mismatch', 'file', 'file:///work/cpu.v'],
      ['verilog', 'width-mismatch', 'workspace', 'file:///work/cpu.v']
    ]);
    expect(actions.map((action) => action.title)).toEqual([
      '对此文件禁用「missing-endmodule」检查',
      '对此工作区禁用「missing-endmodule」检查',
      '对此文件禁用「width-mismatch」检查',
      '对此工作区禁用「width-mismatch」检查'
    ]);
    expect(actions.every((action) => action.command?.title === action.title)).toBe(true);
  });

  it.each([
    { disabledCodes: ['verilog:width-mismatch'] },
    { disabledFileCodes: ['verilog:width-mismatch@file:///work/cpu.v'] }
  ])('does not offer fixes for an already suppressed diagnostic: %j', (diagnostics) => {
    const settings = mergeCoSettings({ diagnostics });
    const diagnostic = { range: Range.create(0, 0, 0, 1), message: 'width mismatch', code: 'width-mismatch' };

    expect(getDiagnosticSuppressActions('verilog', [diagnostic], settings, 'file:///work/cpu.v')).toEqual([]);
  });

  it('filters disabled diagnostic codes by language', () => {
    const settings = mergeCoSettings({
      diagnostics: {
        disabledCodes: ['verilog:synth-mul-div']
      }
    });
    const diagnostics = [
      {
        range: Range.create(0, 0, 0, 1),
        message: 'mul',
        severity: DiagnosticSeverity.Information,
        code: 'synth-mul-div'
      },
      {
        range: Range.create(1, 0, 1, 1),
        message: 'mul in mips should not match',
        severity: DiagnosticSeverity.Information,
        code: 'synth-mul-div'
      }
    ];
    expect(filterDisabledDiagnostics('verilog', diagnostics, settings)).toHaveLength(0);
    expect(filterDisabledDiagnostics('mipsasm', diagnostics, settings)).toHaveLength(2);
  });

  it('filters diagnostics disabled only for a matching file', () => {
    const settings = mergeCoSettings({
      diagnostics: {
        disabledFileCodes: ['verilog:synth-mul-div@file:///work/cpu.v']
      }
    });
    const diagnostics = [
      {
        range: Range.create(0, 0, 0, 1),
        message: 'mul',
        severity: DiagnosticSeverity.Information,
        code: 'synth-mul-div'
      }
    ];

    expect(filterDisabledDiagnostics('verilog', diagnostics, settings, 'file:///work/cpu.v')).toHaveLength(0);
    expect(filterDisabledDiagnostics('verilog', diagnostics, settings, 'file:///work/other.v')).toHaveLength(1);
  });
});
