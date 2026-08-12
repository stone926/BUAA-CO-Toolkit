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
      if (memory.offset.kind === 'integer') {
        expect(memory.offset.value).toBe(4);
      }
      expect(memory.base.kind).toBe('register');
    }
  });

  it('distinguishes SPIM-style $ macro parameters from registers inside macro bodies', () => {
    const result = parseMips(doc([
      '.macro inc($x)',
      '  addi $x, $x, 1',
      '.end_macro',
      'inc($t0)'
    ].join('\n')), defaultCoSettings);

    const bodyOperands = result.ast.macros[0].body[0].executable?.operands ?? [];
    expect(bodyOperands.slice(0, 2).map((operand) => operand.kind)).toEqual([
      'macroParameter',
      'macroParameter'
    ]);
    expect(result.semantic.references.filter((reference) => reference.name === '$x').map((reference) => reference.kind)).toEqual([
      'macroParam',
      'macroParam'
    ]);
    expect(result.ast.statements[3].executable?.operands[0].kind).toBe('register');
  });

  it('stores parsed integer values on typed AST operands', () => {
    const result = parseMips(doc([
      'li $v0, 0x2a',
      "addi $t0, $t0, '\\n'",
      'lw $t1, 8($sp)'
    ].join('\n')), defaultCoSettings);

    const liImmediate = result.ast.statements[0].executable?.operands[1];
    const addiImmediate = result.ast.statements[1].executable?.operands[2];
    const memory = result.ast.statements[2].executable?.operands[1];

    expect(liImmediate?.kind).toBe('integer');
    if (liImmediate?.kind === 'integer') {
      expect(liImmediate.value).toBe(42);
    }
    expect(addiImmediate?.kind).toBe('integer');
    if (addiImmediate?.kind === 'integer') {
      expect(addiImmediate.value).toBe(10);
    }
    expect(memory?.kind).toBe('memory');
    if (memory?.kind === 'memory' && memory.offset.kind === 'integer') {
      expect(memory.offset.value).toBe(8);
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
    const load = result.ast.statements.find((statement) => statement.executable?.lowerMnemonic === 'lw')?.executable;
    const memory = load?.operands[1];
    expect(memory?.kind).toBe('memory');
    if (memory?.kind === 'memory') {
      expect(memory.offset.kind).toBe('expression');
      if (memory.offset.kind === 'expression') {
        expect(memory.offset.labelPlusImmediate?.label.text).toBe('arr');
        expect(memory.offset.labelPlusImmediate?.immediate.kind).toBe('integer');
        if (memory.offset.labelPlusImmediate?.immediate.kind === 'integer') {
          expect(memory.offset.labelPlusImmediate.immediate.value).toBe(4);
        }
      }
    }
  });

  it('binds macro-local data label references to the containing macro scope', () => {
    const result = parseMips(doc([
      '.macro print(%str)',
      '  .data',
      '    _str: .asciiz %str',
      '  .text',
      '    la $a0, _str',
      '.end_macro',
      '',
      '.macro put_int(%int, %sep)',
      '  .data',
      '    _str: .asciiz %sep',
      '  .text',
      '    la $a0, _str',
      '.end_macro'
    ].join('\n')), defaultCoSettings);

    const printScope = result.semantic.macroScopes.find((scope) => scope.name === 'print');
    const putIntScope = result.semantic.macroScopes.find((scope) => scope.name === 'put_int');
    const printRef = result.semantic.references.find((reference) => reference.name === '_str' && reference.scope === printScope);
    const putIntRef = result.semantic.references.find((reference) => reference.name === '_str' && reference.scope === putIntScope);

    expect(result.semantic.unresolvedReferences.some((reference) => reference.name === '_str')).toBe(false);
    expect(printRef?.kind).toBe('data');
    expect(printRef?.symbol).toBe(printScope?.dataSymbols.get('_str'));
    expect(putIntRef?.kind).toBe('data');
    expect(putIntRef?.symbol).toBe(putIntScope?.dataSymbols.get('_str'));
  });
});
