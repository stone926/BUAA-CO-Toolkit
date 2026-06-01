import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { mergeCoSettings, disableDiagnosticCodeCommand } from '../../../language/common/settings';
import {
  filterDisabledDiagnostics,
  getDiagnosticSuppressActions
} from '../../../language/common/diagnosticActions';

describe('diagnostic suppress actions', () => {
  it('creates one quick fix for each diagnostic code', () => {
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
    const actions = getDiagnosticSuppressActions('verilog', diagnostics, mergeCoSettings({}));
    expect(actions.map((action) => action.command?.command)).toEqual([disableDiagnosticCodeCommand, disableDiagnosticCodeCommand]);
    expect(actions.map((action) => action.command?.arguments)).toEqual([
      ['verilog', 'missing-endmodule'],
      ['verilog', 'width-mismatch']
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
});
