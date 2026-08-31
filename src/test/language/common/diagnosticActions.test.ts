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
