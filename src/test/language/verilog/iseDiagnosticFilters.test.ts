import { describe, expect, it } from 'vitest';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { mergeCoSettings } from '../../../language/common/settings';
import { filterIseDiagnostics } from '../../../language/verilog/iseDiagnosticFilters';

function iseDiagnostic(message: string, severity: DiagnosticSeverity): Diagnostic {
  return {
    range: Range.create(0, 0, 0, 1),
    severity,
    source: 'ISE fuse',
    code: 'ise-syntax',
    message
  };
}

describe('ISE diagnostic filters', () => {
  it('suppresses ISE warnings for intentionally unconnected ports by default', () => {
    const settings = mergeCoSettings({});
    const diagnostic = iseDiagnostic('Port flush is not connected to this instance', DiagnosticSeverity.Warning);

    expect(filterIseDiagnostics([diagnostic], settings)).toEqual([]);
  });

  it('does not suppress unconnected port errors', () => {
    const settings = mergeCoSettings({});
    const diagnostic = iseDiagnostic('Port flush is not connected to this instance', DiagnosticSeverity.Error);

    expect(filterIseDiagnostics([diagnostic], settings)).toEqual([diagnostic]);
  });

  it('keeps unrelated ISE warnings', () => {
    const settings = mergeCoSettings({});
    const diagnostic = iseDiagnostic('Result of 32-bit expression is truncated.', DiagnosticSeverity.Warning);

    expect(filterIseDiagnostics([diagnostic], settings)).toEqual([diagnostic]);
  });

  it('keeps unconnected port warnings when the user disables ISE warning suppression', () => {
    const settings = mergeCoSettings({
      verilog: {
        syntax: {
          ise: {
            suppressedWarnings: []
          }
        }
      }
    });
    const diagnostic = iseDiagnostic('Port flush is not connected to this instance', DiagnosticSeverity.Warning);

    expect(filterIseDiagnostics([diagnostic], settings)).toEqual([diagnostic]);
  });
});
