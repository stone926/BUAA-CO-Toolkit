import { describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import type { AppServices } from '../types';
import type { CourseTraceCaseInput } from '../courseTestCases';
import type { CourseTraceRunOptions } from '../courseTesting/traceRunner';

const records = vi.hoisted(() => ({ save: vi.fn(async () => undefined) }));
vi.mock('vscode', () => ({ Uri: URI }));
vi.mock('../asmCaseStore', () => ({ recordAsmCaseTestOutcome: records.save, asmCaseIndexDirectory: () => 'E:/cpu/.co/cases' }));
vi.mock('../courseTesting/continuousCaseRetention', () => ({ markContinuousAsmCaseCancelled: vi.fn() }));
vi.mock('../courseTesting/workspaceCaseRetention', () => ({ WorkspaceCaseRetention: class {
  initialize = vi.fn(async () => undefined);
  observe = vi.fn(async () => undefined);
  prune = vi.fn(async () => ({ removed: [], refused: 0 }));
} }));

import { createUserAsmBatchReport, runUserAsmBatch } from '../courseTesting/userAsmBatch';

const services = { output: { appendLine: vi.fn() } } as unknown as AppServices;
const cpu = URI.file('E:/cpu project/rtl/mips.v');
const input = URI.file('D:/external ASM');
const cases: CourseTraceCaseInput[] = [{ asm: URI.file('D:/external ASM/a.asm') }, { asm: URI.file('D:/external ASM/b.s') }];

describe('user ASM batch', () => {
  it('keeps external assembly separate from the CPU context and saves standard history outcomes', async () => {
    const report = createUserAsmBatchReport(cpu, input, cases.length);
    const run = vi.fn(async (_services: AppServices, item: CourseTraceCaseInput, options: CourseTraceRunOptions) => {
      expect(options.cpuResource).toBe(cpu);
      expect(options.source?.kind).toBe('selected');
      expect(options.artifactOutputMode).toBe('case');
      return { asm: item.asm.fsPath, caseId: 'selected-case', caseManifest: 'E:/cpu project/.co/cases/selected-case/case.json', status: 'passed' as const, stage: 'compare' as const, message: '通过' };
    });
    await runUserAsmBatch({ services, cases, cpuResource: cpu, report, signal: new AbortController().signal, run, updateMonitor: async () => undefined });
    expect(run.mock.calls.map(call => call[1].asm.fsPath)).toEqual(cases.map(item => item.asm.fsPath));
    expect(report.iteration.summary).toEqual({ total: 2, passed: 2, failed: 0, errors: 0 });
    expect(report.iteration.status).toBe('passed');
    expect(records.save).toHaveBeenCalledWith(expect.stringContaining('selected-case'), expect.objectContaining({ status: 'passed', stage: 'compare' }));
  });

  it('cancels in-flight execution, drains it and never starts the next file', async () => {
    const controller = new AbortController();
    const report = createUserAsmBatchReport(cpu, input, cases.length);
    let drained = false;
    const run = vi.fn(async (_services: AppServices, item: CourseTraceCaseInput, options: CourseTraceRunOptions) => {
      controller.abort();
      expect(options.signal?.aborted).toBe(true);
      await Promise.resolve();
      drained = true;
      return { asm: item.asm.fsPath, status: 'error' as const, stage: 'internal' as const, message: '取消', cancelled: true as const };
    });
    await runUserAsmBatch({ services, cases, cpuResource: cpu, report, signal: controller.signal, run, updateMonitor: async () => undefined });
    expect(drained).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(report.stopRequested).toBe(true);
    expect(report.iteration.status).toBe('stopped');
    expect(report.iteration.summary.errors).toBe(0);
    expect(report.running).toBe(false);
  });

  it('stops the batch on its first functional failure while preserving its evidence', async () => {
    const report = createUserAsmBatchReport(cpu, input, cases.length);
    const run = vi.fn(async (_services: AppServices, item: CourseTraceCaseInput) => ({
      asm: item.asm.fsPath, status: 'failed' as const, stage: 'compare' as const, message: '写回不匹配'
    }));
    await runUserAsmBatch({ services, cases, cpuResource: cpu, report, signal: new AbortController().signal, run, updateMonitor: async () => undefined });
    expect(run).toHaveBeenCalledTimes(1);
    expect(report.iteration.status).toBe('failed');
    expect(report.iteration.results[0].message).toBe('写回不匹配');
    expect(report.stopRequested).toBe(false);
  });
});
