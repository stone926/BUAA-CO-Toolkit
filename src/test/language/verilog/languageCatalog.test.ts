import { describe, expect, it } from 'vitest';
import { lexVerilog } from '../../../language/verilog/lexer';
import { verilogLanguageCatalog } from '../../../language/verilog/model';
import { preprocessorDirectives } from '../../../language/verilog/preprocessor';

describe('Verilog language catalog', () => {
  it('is the shared source of truth for compiler directives', () => {
    expect([...preprocessorDirectives].sort()).toEqual([...verilogLanguageCatalog.compilerDirectives].sort());
  });

  it('lexes every catalogued operator as one token', () => {
    const operators = [...new Set(Object.values(verilogLanguageCatalog.operators).flat())];

    for (const operator of operators) {
      expect(lexVerilog(operator).tokens[0]).toMatchObject({
        kind: 'operator',
        value: operator,
        start: 0,
        end: operator.length
      });
    }
  });

  it('accepts LF and CRLF escaped string continuations without swallowing later code', () => {
    for (const newline of ['\n', '\r\n']) {
      const source = `"first\\${newline}second" module`;
      const result = lexVerilog(source);

      expect(result.diagnostics).toEqual([]);
      expect(result.tokens[0]).toMatchObject({ kind: 'string', value: `"first\\${newline}second"` });
      expect(result.tokens[1]).toMatchObject({ kind: 'keyword', value: 'module' });
    }
  });
});
