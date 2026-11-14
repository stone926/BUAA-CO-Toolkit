import { describe, expect, it, vi } from 'vitest';
import { needsCustomMars } from '../../mips/providers/customMarsCommon';
import { parseCustomMarsBridgeResult, type CustomMarsBridgeResult } from '../../mips/host/customMarsBridge';

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  return createVscodeModuleMock(createVscodeMockState(), vi.fn);
});

const failed = { ok: false, timedOut: false };
const unknown = [{ code: 'asm.instruction.unknown', message: 'Unknown custom instruction' }];

describe('custom Mars fallback gating', () => {
  it('switches only when assembly reports a structured unknown-instruction diagnostic', () => {
    expect(needsCustomMars(failed, unknown)).toBe(true);
    expect(needsCustomMars(failed, [...unknown, { code: 'asm.symbol.undefined', message: 'Undefined label' }])).toBe(true);
  });

  it.each([
    'asm.operand.invalid-register', 'asm.operand.wrong-count', 'asm.symbol.undefined',
    'asm.instruction.profile-unsupported', 'asm.include.not-found', 'asm.internal-error'
  ])('does not switch for ordinary %s errors or text resembling an unknown-instruction diagnostic', code => {
    expect(needsCustomMars(failed, [{ code, message: '[asm.instruction.unknown] custom instruction' }])).toBe(false);
  });

  it('does not switch without diagnostics or after successful assembly', () => {
    expect(needsCustomMars(failed)).toBe(false);
    expect(needsCustomMars(failed, [])).toBe(false);
    expect(needsCustomMars({ ok: true, timedOut: false }, unknown)).toBe(false);
  });

  it.each([
    { ...failed, stopped: true },
    { ...failed, timedOut: true, stopReason: 'timeout' },
    { ...failed, stopReason: 'cancelled' },
    { ...failed, stopped: true, stopReason: 'aborted' }
  ])('never starts fallback after cancellation or timeout: %j', status => {
    expect(needsCustomMars(status, unknown)).toBe(false);
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
