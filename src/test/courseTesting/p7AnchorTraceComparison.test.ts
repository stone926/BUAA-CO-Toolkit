import { describe, expect, it } from 'vitest';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import type { AsmCaseManifestV2 } from '../../courseTesting/manifestCodec';
import { p7AnchorValueEquivalence } from '../../courseTesting/p7AnchorTraceComparison';
import { buildWritebackComparison } from '../../courseTesting/writebackComparison';
import { compareTraces } from '../../language/mips/traceCompare';
import { parseCpuTraceLine, parseCpuTraceOutput } from '../../language/mips/traceParser';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { CustomInstructionRegistry } from '../../mips/core/custom/registry';
import { BUILTIN_TS_ENGINE_ID } from '../../mips/providers/courseEnginePolicy';
import { renderWritebackComparison } from '../../courseTestWritebackReport';

const engine = { id: BUILTIN_TS_ENGINE_ID, semanticsRevision: 1, capabilitiesRevision: 1 };
const manifest: AsmCaseManifestV2 = {
  version: 2, profile: 'P7', caseId: 'anchor', createdAt: '2026-11-24T00:00:00Z',
  originalAsmPath: 'program.asm', asmSnapshot: { path: 'program.asm', sha256: 'a'.repeat(64), bytes: 1 },
  source: { kind: 'builtin', generator: 'builtin:random-asm' }, metadata: { 'source.mode': 'anchor' },
  program: { assembler: engine }, oracle: { engine, configurationHash: 'b'.repeat(64), stopReason: 'halt-loop' }
};

function generatedAnchor(interrupt: boolean) {
  const asm = generateBuiltinAsmTestCase({
    profile: 'P7', instructionText: 'ori mfc0 syscall', instructionCount: 64, seed: 'cp0-observation', interrupt
  });
  const assembled = assembleCourseSource({ id: 'anchor', text: asm.text }, { profile: 'P7' });
  expect(assembled.ok, assembled.diagnostics.map(({ message }) => message).join('\n')).toBe(true);
  const image = assembled.image!;
  const handler = image.segments.find(({ name }) => name === 'ktext')!;
  const causeIndex = handler.words.indexOf(0x401a6800); // mfc0 $26, $13
  expect(causeIndex).toBeGreaterThanOrEqual(0);
  const causePc = (handler.baseAddress + causeIndex * 4).toString(16);
  const epcIndex = handler.words.indexOf(0x401a7000, causeIndex + 1); // mfc0 $26, $14
  expect(epcIndex).toBeGreaterThan(causeIndex);
  const epcPc = (handler.baseAddress + epcIndex * 4).toString(16);
  return { image, causePc, epcPc };
}

describe('generated P7 anchor trace comparison', () => {
  it.each([true, false])('checks BD, all six IP bits and ExcCode (interrupt=%s)', (interrupt) => {
    const { image, causePc } = generatedAnchor(interrupt);
    const equivalentValues = p7AnchorValueEquivalence(manifest, image, BUILTIN_TS_ENGINE_ID);
    const expected = parseCpuTraceLine(`@${causePc}: $26 <= 00000020`)!;
    const compare = (value: string) => compareTraces([expected], [{ ...expected, value }], { equivalentValues }).matched;
    expect(compare('7FFF03A3')).toBe(true); // fills every reserved bit
    expect(compare('80000020')).toBe(false);
    for (let bit = 10; bit <= 15; bit++) expect(compare((0x20 | (1 << bit)).toString(16))).toBe(false);
    expect(compare('00000024')).toBe(false);
    expect(compare('8000X020')).toBe(false);
  });

  it('preserves raw evidence and exact EPC, destination, DM and ordinary GPR comparisons', async () => {
    const { image, causePc, epcPc } = generatedAnchor(true);
    const equivalentValues = p7AnchorValueEquivalence(manifest, image, BUILTIN_TS_ENGINE_ID);
    const reference = `@${causePc}: $26 <= 00000020\n@${epcPc}: $26 <= 00003010\n@3000: $26 <= 00001001\n@3010: *0 <= 00000020`;
    const actual = reference.replace('00000020', '04000020');
    const compare = (dut: string) => compareTraces(parseCpuTraceOutput(reference), parseCpuTraceOutput(dut), { equivalentValues });
    expect(compare(actual).matched).toBe(true);
    expect(compare(actual.replace('00003010', '04003010')).firstDiffIndex).toBe(1);
    expect(compare(actual.replace('00001001', '04001001')).firstDiffIndex).toBe(2);
    expect(compare(actual.replace('*0 <= 00000020', '*0 <= 04000020')).firstDiffIndex).toBe(3);
    expect(compare(actual.replace('$26 <= 04000020', '$25 <= 04000020')).firstDiffIndex).toBe(0);
    const model = await buildWritebackComparison(reference, actual, { equivalentValues });
    expect(model.differences).toEqual([]);
    expect(model.rows[0]).toMatchObject({ status: 'ok', changedFields: [], dut: { value: '04000020' } });
    const html = renderWritebackComparison({ caseId: 'anchor', comparison: model, focus: 0, start: 0, sources: new Map() });
    expect(html).toContain('有效位一致');
    expect(html).toContain('<code class="write-value">04000020</code>');
  });

  it('requires builtin anchor provenance and a validated handler instruction pair', () => {
    const { image } = generatedAnchor(true);
    expect(p7AnchorValueEquivalence({ ...manifest, source: { kind: 'selected' } }, image, BUILTIN_TS_ENGINE_ID)).toBeUndefined();
    expect(p7AnchorValueEquivalence({ ...manifest, metadata: { 'source.mode': 'off' } }, image, BUILTIN_TS_ENGINE_ID)).toBeUndefined();
    expect(p7AnchorValueEquivalence(manifest, image, 'custom-mars')).toBeUndefined();
    expect(p7AnchorValueEquivalence(manifest, undefined, BUILTIN_TS_ENGINE_ID)).toBeUndefined();
    const altered = {
      ...image, segments: image.segments.map((segment) => segment.name !== 'ktext' ? segment : {
        ...segment, words: segment.words.map((word) => word === 0x401a7000 ? 0 : word)
      })
    };
    expect(p7AnchorValueEquivalence(manifest, altered, BUILTIN_TS_ENGINE_ID)).toBeUndefined();
  });

  it('rejects a scripted override of the fixed handler Cause read before generating a case', () => {
    const customRegistry = new CustomInstructionRegistry([{
      apiVersion: 1, mnemonic: 'customcause', modes: ['P7'], override: true,
      encoding: '010000 00000 rt:5 01101 00000000000',
      operands: [{ kind: 'register', field: 'rt' }], access: { writes: ['rt'] },
      execute: (_context, fields) => ({ gprWrites: [{ register: fields.rt, value: 0 }] })
    }]);
    expect(() => generateBuiltinAsmTestCase({
      profile: 'P7', instructionText: 'ori syscall', instructionCount: 64,
      seed: 'cp0-override', interrupt: true, customRegistry
    })).toThrow(/mfc0 \(customcause\)/);
  });
});
