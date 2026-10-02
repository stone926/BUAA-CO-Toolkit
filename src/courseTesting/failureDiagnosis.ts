// @index course-testing — 失败诊断的判定、定位目标与下一步提示（无宿主依赖）
import type { FailureEvidence } from './failureEvidence';
import { evidencePc } from './failureEvidence';

export interface FailureFocus { label: string; pc: number }
export type RecordedTestStatus = 'passed' | 'failed' | 'error' | 'cancelled' | 'unknown';

export function recordedTestStatus(metadata: Record<string, string> | undefined): RecordedTestStatus {
  const value = metadata?.['test.status'] ?? metadata?.['rerun.state'] ?? metadata?.['continuous.state'];
  return value === 'passed' || value === 'failed' || value === 'error' || value === 'cancelled' ? value : 'unknown';
}

export function failureFocus(evidence: FailureEvidence | undefined, probe: unknown): FailureFocus[] {
  if (!evidence) return [];
  const oracle = evidencePc(evidence.oracle?.pc);
  const dut = evidencePc(evidence.dut?.pc);
  const targets: FailureFocus[] = [];
  if (oracle !== undefined) targets.push({ label: dut !== undefined && dut !== oracle ? '参考指令' : '差异指令', pc: oracle });
  if (dut !== undefined && dut !== oracle) targets.push({ label: oracle !== undefined ? 'CPU 指令' : '多出的写回指令', pc: dut });
  if (targets.length) return targets;
  if (evidence.pc !== undefined) return [{ label: '访存指令', pc: evidence.pc }];
  if (evidence.scenarioId === undefined || !probe || typeof probe !== 'object') return [];
  const scenarios = (probe as { scenarios?: unknown }).scenarios;
  if (!Array.isArray(scenarios)) return [];
  const scenario: unknown = scenarios.find(item => item && typeof item === 'object' && item.id === evidence.scenarioId);
  if (!scenario || typeof scenario !== 'object') return [];
  const victim = (scenario as { victimPc?: unknown }).victimPc;
  return typeof victim === 'number' && Number.isInteger(victim) && victim >= 0 && victim <= 0xffffffff && victim % 4 === 0
    ? [{ label: '场景关联指令', pc: victim }] : [];
}

export function failureNextStep(status: RecordedTestStatus, diagnostic: string, evidence?: FailureEvidence): string {
  if (status === 'passed') return '此用例当前已通过。可返回持续测试，继续检查其他指令组合。';
  if (status === 'cancelled' || status === 'unknown') return '本用例没有完成判定。可以查看已保存的程序，或重跑后再判断。';
  if (status === 'error') return diagnostic.startsWith('[AUTO-COVERAGE]')
    ? '测试没有观察到所需触发边界。先查看 CPU 输出与触发条件，再重跑；当前不能据此判定 CPU 功能错误。'
    : '先处理测试未完成的原因。查看运行日志中的首条错误，检查编译、顶层接口或仿真输出，再重跑此用例。';
  const oraclePc = evidencePc(evidence?.oracle?.pc);
  const dutPc = evidencePc(evidence?.dut?.pc);
  if (oraclePc !== undefined && dutPc !== undefined && oraclePc !== dutPc) {
    return '两侧执行 PC 已出现分歧。建议从对应指令向前检查跳转目标、延迟槽与流水线清空；首个可观察差异不一定是根因。';
  }
  return '先查看关联汇编与差异之前的写回，再用波形检查指令输入、控制信号及写回。流水线 CPU 可结合转发、阻塞分析；这些是排查方向，尚未确定根因。';
}

export function acceptsInspectionMessage(message: unknown): message is { action: 'inspectCase'; caseId: string } {
  if (!message || typeof message !== 'object') return false;
  const value = message as { action?: unknown; caseId?: unknown };
  return value.action === 'inspectCase' && typeof value.caseId === 'string'
    && value.caseId.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value.caseId);
}
