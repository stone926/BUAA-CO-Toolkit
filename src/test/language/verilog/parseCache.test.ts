import { describe, expect, it, afterEach } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
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
});

function doc(text: string): TextDocument {
  return TextDocument.create('test://parse-cache/same-version.v', 'verilog', 1, text);
}
