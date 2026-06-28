import { describe, expect, it, afterEach } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings, mergeCoSettings } from '../../../language/common/settings';
import { clearCachedVerilogParse, getCachedVerilogParse } from '../../../language/verilog/parseCache';

describe('Verilog parse cache', () => {
  afterEach(() => {
    clearCachedVerilogParse();
  });

  it('does not reuse stale results for same URI and version with different text', () => {
    const first = doc('module First; endmodule\n');
    const second = doc('module Second; endmodule\n');

    expect(getCachedVerilogParse(first, defaultCoSettings, false).modules[0]?.name).toBe('First');
    expect(getCachedVerilogParse(second, defaultCoSettings, false).modules[0]?.name).toBe('Second');
  });

  it('reuses structural parses across diagnostic settings', () => {
    const document = doc('module Top; wire a; endmodule\n');
    const structural = getCachedVerilogParse(document, defaultCoSettings, false);
    const relaxedSettings = mergeCoSettings({
      verilog: {
        implicitNet: {
          diagnostic: 'off'
        },
        lint: {
          courseRules: false,
          synthesizableHints: false
        }
      }
    });

    expect(getCachedVerilogParse(document, relaxedSettings, false)).toBe(structural);
    const diagnostics = getCachedVerilogParse(document, relaxedSettings, true);
    expect(diagnostics).toBe(getCachedVerilogParse(document, relaxedSettings, true));
    expect(diagnostics.modules).toBe(structural.modules);
    expect(getCachedVerilogParse(document, defaultCoSettings, false)).toBe(structural);
  });
});

function doc(text: string): TextDocument {
  return TextDocument.create('test://parse-cache/same-version.v', 'verilog', 1, text);
}
