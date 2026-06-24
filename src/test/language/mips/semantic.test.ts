import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../../../language/common/settings';
import { parseMips } from '../../../language/mips/parser';

function doc(text: string): TextDocument {
  return TextDocument.create('test://semantic.s', 'mipsasm', 1, text);
}

describe('MIPS AST and semantic model', () => {
  it('builds a document AST with typed operands and macro definitions', () => {
    const result = parseMips(doc([
      '.data',
      'msg: .asciiz "hi"',
      '.text',
      'main: la $a0, msg',
      '.macro emit(%reg)',
      '    sw %reg, 4($sp)',
      '.end_macro'
    ].join('\n')), defaultCoSettings);

    expect(result.ast.kind).toBe('program');
    expect(result.ast.statements).toHaveLength(7);
    expect(result.ast.macros).toHaveLength(1);
    expect(result.ast.macros[0].name).toBe('emit');
    expect(result.ast.macros[0].params.map((param) => param.name)).toEqual(['%reg']);

    const macroStore = result.ast.statements.find((statement) => statement.executable?.lowerMnemonic === 'sw');
    const memory = macroStore?.executable?.operands[1];
    expect(memory?.kind).toBe('memory');
    if (memory?.kind === 'memory') {
      expect(memory.offset.kind).toBe('integer');
      expect(memory.base.kind).toBe('register');
    }
  });

  it('binds declarations, references, scopes, and unresolved symbols', () => {
    const result = parseMips(doc([
      '.data',
      'msg: .word 1',
      '.text',
      'main: la $a0, msg',
      '.macro emit(%reg)',
      'local: add $t0, %reg, missing_symbol',
      '.end_macro',
      'emit($t1)'
    ].join('\n')), defaultCoSettings);

    expect(result.semantic.globalScope.dataSymbols.has('msg')).toBe(true);
    expect(result.semantic.globalScope.labels.has('main')).toBe(true);
    expect(result.semantic.macroScopes).toHaveLength(1);
    expect(result.semantic.macroScopes[0].macroParams.has('%reg')).toBe(true);

    expect(result.semantic.references.some((reference) => reference.name === 'msg' && reference.kind === 'data')).toBe(true);
    expect(result.semantic.references.some((reference) => reference.name === '%reg' && reference.kind === 'macroParam')).toBe(true);
    expect(result.semantic.references.some((reference) => reference.name === 'emit' && reference.kind === 'macro')).toBe(true);
    expect(result.semantic.unresolvedReferences.some((reference) => reference.name === 'missing_symbol')).toBe(true);
  });

  it('binds instruction-like data symbol references before mnemonic names', () => {
    const result = parseMips(doc([
      '.data',
      'b: .word 0 : 64',
      '.text',
      'main: la $a0, b'
    ].join('\n')), defaultCoSettings);

    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 1);
    expect(errors).toHaveLength(0);
    expect(result.semantic.globalScope.dataSymbols.has('b')).toBe(true);
    expect(result.semantic.references.some((reference) => reference.name === 'b' && reference.kind === 'data')).toBe(true);
  });

  it('binds symbols inside typed memory operand offset expressions', () => {
    const result = parseMips(doc([
      '.data',
      'arr: .word 1',
      '.text',
      'main: lw $t0, arr+4($sp)'
    ].join('\n')), defaultCoSettings);

    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 1);
    expect(errors).toHaveLength(0);
    expect(result.semantic.references.some((reference) => reference.name === 'arr' && reference.kind === 'data')).toBe(true);
  });
});
