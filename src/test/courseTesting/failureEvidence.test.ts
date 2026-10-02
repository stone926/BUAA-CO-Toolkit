import { describe, expect, it } from 'vitest';
import { failureFocus, failureNextStep, acceptsInspectionMessage } from '../../courseTesting/failureDiagnosis';
import { parseFailureEvidence, serializeFailureEvidence } from '../../courseTesting/failureEvidence';
import type { CourseTraceCaseResult } from '../../courseTestReport';

const event = { pc: '00003000', kind: 'grf' as const, target: '8', value: 'deadbeef', lineNumber: 17, raw: 'private command C:\\user\\file', cycle: 42 };
const result: CourseTraceCaseResult = { asm: 'private.asm', status: 'failed', stage: 'compare', message: 'failed', firstDiff: { index: 6, status: 'diff', oracle: event, dut: { ...event, pc: '00003004' } } };

describe('bounded failure navigation evidence', () => {
  it('keeps separate reference and DUT PCs and trace line numbers without storing raw text or paths', () => {
    const serialized = serializeFailureEvidence(result)!;
    expect(serialized).not.toContain('private');
    expect(parseFailureEvidence(serialized)?.oracle).toMatchObject({ lineNumber: 17, cycle: 42, raw: '' });
    expect(failureFocus(parseFailureEvidence(serialized), undefined)).toEqual([
      { label: '参考指令', pc: 0x3000 }, { label: 'CPU 指令', pc: 0x3004 }
    ]);
    expect(serializeFailureEvidence({ ...result, cancelled: true })).toBeUndefined();
    expect(serializeFailureEvidence({ ...result, status: 'passed' })).toBeUndefined();
  });

  it('rejects malformed, oversized or executable content from archived evidence', () => {
    for (const text of ['{', 'x'.repeat(2049), '{"version":2}', '{"version":1,"pc":-1}']) {
      expect(parseFailureEvidence(text)).toBeUndefined();
    }
    expect(parseFailureEvidence(JSON.stringify({ version: 1, oracle: { ...event, target: '<script>' } }))).toBeUndefined();
    expect(parseFailureEvidence(JSON.stringify({ version: 1, oracle: { ...event, lineNumber: 0 } }))).toBeUndefined();
    expect(failureFocus({ version: 1, dut: { ...event, pc: 'xxxxxxxx' } }, undefined)).toEqual([]);
  });

  it('locates DM checks and P7 scenario instructions without inventing reference events', () => {
    const evidence = parseFailureEvidence(serializeFailureEvidence({ ...result, firstDiff: { index: 3, status: 'diff', reason: 'DM 写事务 #4 (PC=0x00003080)：字节使能应为 0001，实际为 1111' } }));
    expect(failureFocus(evidence, undefined)).toEqual([{ label: '访存指令', pc: 0x3080 }]);
    expect(evidence?.oracle).toBeUndefined();
    expect(failureFocus({ version: 1, scenarioId: 2 }, { scenarios: [{ id: 2, victimPc: 0x30a0 }] })).toEqual([{ label: '场景关联指令', pc: 0x30a0 }]);
    expect(failureFocus({ version: 1, scenarioId: 2 }, { scenarios: [{ id: 2, victimPc: -4 }] })).toEqual([]);
    expect(failureNextStep('error', '[AUTO-COVERAGE] 未覆盖')).toContain('不能据此判定');
    expect(failureNextStep('failed', '', { version: 1, oracle: { ...event, pc: '000030a0' }, dut: { ...event, pc: '000030A0' } })).not.toContain('PC 已出现分歧');
  });

  it('allows only bounded case identifiers in report messages', () => {
    expect(acceptsInspectionMessage({ action: 'inspectCase', caseId: '20261002T000000000Z-abcd1234' })).toBe(true);
    for (const caseId of ['../escape', 'C:\\case', '/case', '', 'x'.repeat(129)]) {
      expect(acceptsInspectionMessage({ action: 'inspectCase', caseId })).toBe(false);
    }
    expect(acceptsInspectionMessage({ action: 'executeCommand', caseId: 'valid' })).toBe(false);
  });
});
