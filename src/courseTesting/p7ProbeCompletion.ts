// @index course-testing — Distinguish observed P7 violations from incomplete DUT execution
import type { P7ProbeCheckResult } from './p7ProbeCheck';

export function observedP7Halt(output: string, haltPc: number): boolean {
  return new RegExp(`^CO_P7_HALT pc=${haltPc.toString(16).padStart(8, '0')}\\r?$`, 'm').test(output);
}

export function isP7ObservationLimit(reason: string | undefined): boolean {
  return reason === 'stdout-limit' || reason === 'timeout';
}

export function concludeP7Probe(
  result: P7ProbeCheckResult, output: string, haltPc: number, limited = false
): P7ProbeCheckResult {
  if (!limited && observedP7Halt(output, haltPc)) return result;
  // An incomplete suffix cannot establish a missing write, IRQ, handler or record.
  // A wrong value or forbidden write that was actually observed remains decisive.
  const failures = result.failures.filter(failure => failure.observed);
  const coverage = result.coverage?.some(item => !item.covered) ? result.coverage : [
    ...(result.coverage ?? []),
    { covered: false, message: '未覆盖：仿真结束前未取得完整的 P7 执行记录和停机循环见证' }
  ];
  return { ...result, passed: false, failures, coverage };
}
