import { describe, expect, it } from 'vitest';
import { courseModeForConsoleAssembly, customInstructionAssemblyHint } from '../../mips/host/customInstructionService';
import type { CustomInstructionMetadata } from '../../mips/core/custom/api';
import { parseCustomMarsBridgeResult, type CustomMarsBridgeResult } from '../../mips/host/customMarsBridge';

const bel: CustomInstructionMetadata = {
  apiVersion: 1, mnemonic: 'bel', aliases: ['bel_alias'], modes: ['P6', 'P7'],
  encoding: '011111 rs:5 rt:5 immediate:16', operands: []
};
const unknown = { code: 'asm.instruction.unknown', message: '未知指令 bel', mnemonic: 'bel' };

describe('workspace custom instruction diagnostics', () => {
  it('uses the declared course mode only for a referenced course-only definition', () => {
    expect(courseModeForConsoleAssembly([unknown], [bel], 'P6')).toBe('P6');
    expect(courseModeForConsoleAssembly([{ ...unknown, mnemonic: 'bel_alias' }], [bel], 'P7')).toBe('P7');
    expect(courseModeForConsoleAssembly([unknown], [bel], 'P5')).toBeUndefined();
    expect(courseModeForConsoleAssembly([unknown], [bel])).toBeUndefined();
    expect(courseModeForConsoleAssembly([unknown], [{ ...bel, modes: ['mars', 'P6'] }], 'P6')).toBeUndefined();
    expect(courseModeForConsoleAssembly([{ ...unknown, mnemonic: 'typo' }], [bel], 'P6')).toBeUndefined();
  });

  it.each([
    'asm.operand.invalid-register', 'asm.operand.wrong-count', 'asm.symbol.undefined',
    'asm.instruction.profile-unsupported', 'asm.include.not-found', 'asm.internal-error'
  ])('does not switch for ordinary %s errors or text resembling an unknown-instruction diagnostic', code => {
    expect(courseModeForConsoleAssembly([{ ...unknown, code }], [bel], 'P6')).toBeUndefined();
    expect(customInstructionAssemblyHint([{ ...unknown, code }], 'P6', 'builtin')).toBeUndefined();
  });

  it('explains missing definitions and profile mismatches from the shared metadata', () => {
    expect(customInstructionAssemblyHint([unknown, unknown], 'P6', 'builtin')).toMatch(/未知指令 bel.*\.co\/custom-instructions/);
    expect(customInstructionAssemblyHint([unknown], 'P5', 'script', [bel])).toMatch(/bel.*P6\/P7.*P5/);
    expect(customInstructionAssemblyHint([unknown], 'P6', 'script', [])).toMatch(/未知指令 bel.*JS\/TS/);
  });
});

function validResult(): CustomMarsBridgeResult {
  return {
    protocolVersion: 1, ok: true, javaVersion: '17.0.1',
    segments: [{ name: 'text', baseAddress: 0x3000, words: [0xfc221800, 0x1000ffff, 0] }],
    customInstructions: [{ mnemonic: 'custom', mask: 0xfc00003f, value: 0xfc000000, template: 'custom $t1,$t2,$t3' }],
    sourceMap: [{ address: 0x3000, path: 'E:/中文 路径/program.asm', line: 1 }],
    stopReason: 'halt-loop', instructions: 3, exitCode: 0
  };
}

describe('custom Mars bridge payload boundary', () => {
  it('accepts valid results with unsigned custom encodings and preserved source locations', () => {
    expect(parseCustomMarsBridgeResult(validResult())).toEqual(validResult());
    const failure = { ...validResult(), ok: false, diagnostic: '自定义指令加载失败', segments: [], customInstructions: [], sourceMap: [] };
    expect(parseCustomMarsBridgeResult(failure)).toEqual(failure);
  });

  it.each([
    null, undefined, {}, { ...validResult(), protocolVersion: 2 }, { ...validResult(), ok: 'true' },
    { ...validResult(), javaVersion: 17 }, { ...validResult(), diagnostic: {} },
    { ...validResult(), segments: {} }, { ...validResult(), customInstructions: null },
    { ...validResult(), segments: Array.from({ length: 257 }, () => ({ name: 'text', baseAddress: 0x3000, words: [] })) },
    { ...validResult(), customInstructions: Array.from({ length: 257 }, () => validResult().customInstructions[0]) }
  ])('rejects a malformed or unsupported envelope: %j', value => {
    expect(() => parseCustomMarsBridgeResult(value)).toThrow();
  });

  it.each([
    { name: 'unknown', baseAddress: 0x3000, words: [0] },
    { name: 'text', baseAddress: 0x3001, words: [0] },
    { name: 'text', baseAddress: -1, words: [0] },
    { name: 'text', baseAddress: 0x3000, words: [-1] },
    { name: 'text', baseAddress: 0x3000, words: [0x1_0000_0000] },
    { name: 'text', baseAddress: 0x3000, words: [1.5] }
  ])('rejects invalid segment addresses, words and names: %j', segment => {
    expect(() => parseCustomMarsBridgeResult({ ...validResult(), segments: [segment] })).toThrow();
  });

  it('bounds total program words before accepting an image', () => {
    expect(() => parseCustomMarsBridgeResult({ ...validResult(), segments: [
      { name: 'text', baseAddress: 0x3000, words: new Array(1_048_577).fill(0) }
    ] })).toThrow(/host limit/);
  });

  it.each([
    { mnemonic: 'custom', mask: -1, value: 0, template: 'custom' },
    { mnemonic: 'custom', mask: 0xfc000000, value: 0x1_0000_0000, template: 'custom' },
    { mnemonic: 'custom', mask: 1.5, value: 0, template: 'custom' },
    { mnemonic: 7, mask: 0xfc000000, value: 0xfc000000, template: 'custom' },
    { mnemonic: 'custom', mask: 0xfc000000, value: 0xfc000000, template: null }
  ])('rejects malformed custom instruction metadata: %j', instruction => {
    expect(() => parseCustomMarsBridgeResult({ ...validResult(), customInstructions: [instruction] })).toThrow();
  });

  it.each([
    { sourceMap: [{ address: -1, path: 'program.asm', line: 1 }] },
    { sourceMap: [{ address: 0x3000, path: null, line: 1 }] },
    { sourceMap: [{ address: 0x3000, path: 'program.asm', line: 0 }] },
    { sourceMap: [{ address: 0x3000, path: 'program.asm', line: 1.5 }] },
    { sourceMap: Array.from({ length: 4 }, () => ({ address: 0x3000, path: 'program.asm', line: 1 })) }
  ])('rejects invalid or excessive source mappings: %j', ({ sourceMap }) => {
    expect(() => parseCustomMarsBridgeResult({ ...validResult(), sourceMap })).toThrow();
  });
});
