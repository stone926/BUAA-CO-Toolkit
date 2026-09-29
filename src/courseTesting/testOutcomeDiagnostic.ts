// @index test-outcome-diagnostic — bounded, path-safe public summaries of automatic test outcomes
import { p7ProbeKindLabel, probeFailureMessage, traceDifferenceMessage } from '../courseTestMessages';
import type { CourseTraceCaseResult, CourseTraceStage, NeutralCourseTraceStage } from '../courseTestReport';
import type { P7ProbeCheckResult } from './p7ProbeCheck';
import type { TraceDiffSnapshot, TraceEventSnapshot } from '../language/mips/traceCompare';
import { specialTimerExlNotice } from './p7ProbeScope';
import { verilogSimulationFailureMessage } from '../verilog/simulationDiagnostic';

const maximumBaseLength = 340;
const maximumEvidenceLength = 190;
const traceToken = /^(?:0x)?[0-9a-fxz]{1,8}$/i;
const knownTraceReasons = new Set([
  'DUT has an extra event.', 'Oracle has an extra event.', 'Cycle/time differs.',
  'PC differs.', 'Write target kind differs.', 'Write target differs.', 'Write value differs.',
  '待测 CPU 多出一条写回事件。', '待测 CPU 缺少一条参考结果中的写回事件。',
  '周期或时间不一致。', '指令地址（PC）不一致。',
  '写入目标类型不一致（寄存器或存储器）。', '写入目标不一致。', '写入值不一致。'
]);
const dmHex = '0x[0-9a-f]{8}';
const dmStoreReason = new RegExp(
  `^DM 写事务 #[1-9][0-9]{0,9}(?: \\(PC=${dmHex}\\))?：(?:`
  + '待测 CPU 多出有效写事务|缺少待测 CPU 的原始写事务记录|原始写事务字段未知或格式不合法|'
  + '未知原始地址缺少确定的字地址|记录的字地址未对齐|'
  + `PC 应为 ${dmHex}，实际为 ${dmHex}|`
  + `目标字地址应为 ${dmHex}，实际地址为 ${dmHex}|`
  + '字节使能应为 [01]{4}，实际为 [01]{4}|'
  + '有效字节通道 [0-3] 应为 [0-9a-f]{2}，实际为 [0-9a-fxz]{2}'
  + ')$', 'i'
);

/** One bounded, path-safe diagnosis shared by history and public reports. */
export function publicAutomaticDiagnosticMessage(item: CourseTraceCaseResult): string {
  const message = bounded(baseAutomaticDiagnosticMessage(item), maximumBaseLength);
  return item.probeScope === 'special-timer-exl' && !message.includes(specialTimerExlNotice)
    ? `${message}。${specialTimerExlNotice}` : message;
}

export function baseAutomaticDiagnosticMessage(item: CourseTraceCaseResult): string {
  if (item.cancelled) return '[AUTO-STOPPED] 测试已停止';
  if (item.status === 'error' && uncoveredProbeCoverage(item.probe).length) {
    return '[AUTO-COVERAGE] 未覆盖：返回后中断触发窗口未观测，无法判定';
  }
  if (item.status === 'passed') return '通过';
  if (item.status === 'failed') {
    const failure = item.probe?.failures[0];
    if (failure) {
      const scenario = Number.isSafeInteger(failure.scenarioId) && failure.scenarioId >= 0
        ? `场景 ${failure.scenarioId} ` : '';
      const label = safeProbeKind(failure.kind);
      const detail = safeEvidenceText(probeFailureMessage(failure.message.slice(0, 4096)));
      return `[AUTO-PROBE] ${scenario}${label}${detail ? `：${detail}` : '未通过'}`;
    }
    if (item.firstDiff) return `[AUTO-MISMATCH] ${firstDiffSummary(item.firstDiff)}`;
    return item.probe
      ? '[AUTO-PROBE] P7 定向检查未通过'
      : '[AUTO-MISMATCH] CPU 输出与参考结果不一致';
  }
  switch (neutralCourseTraceStage(item.stage)) {
    case 'assemble':
      return '[AUTO-ASSEMBLE] 测试点汇编未完成';
    case 'oracle':
      return '[AUTO-ORACLE] 参考结果未生成';
    case 'dut':
      return item.dutFailure
        ? `[AUTO-DUT] ${verilogSimulationFailureMessage(item.dutFailure, item.dutBackend === 'isim' ? undefined : item.dutBackend)}`
        : '[AUTO-DUT] CPU 仿真未完成；请检查工具链和顶层接口';
    case 'compare':
      return '[AUTO-COMPARE] 结果比较未完成';
    case 'probe':
      return '[AUTO-PROBE] P7 定向检查未完成';
    case 'internal':
      return '[AUTO-INTERNAL] 自动测试内部流程未完成；请使用复现编号定位';
  }
}

/** Keep the report renderer and summary on the same coverage decision. */
export function probeCoverage(probe: P7ProbeCheckResult | undefined): Array<{ covered: boolean; message: string }> {
  const entries = probe?.coverage;
  return Array.isArray(entries) ? entries : [];
}

export function uncoveredProbeCoverage(probe: P7ProbeCheckResult | undefined): Array<{ covered: boolean; message: string }> {
  if (probe?.failures.length) return [];
  return probeCoverage(probe).filter((entry) => !entry.covered);
}

/** Map historical engine names to the stable role used by public reports. */
export function neutralCourseTraceStage(stage: CourseTraceStage): NeutralCourseTraceStage {
  if (stage === 'dump') return 'assemble';
  if (stage === 'mars') return 'oracle';
  if (stage === 'isim' || stage === 'logisim') return 'dut';
  return stage;
}

function safeProbeKind(kind: string): string {
  const label = p7ProbeKindLabel(kind);
  return label !== kind || /^[\p{Script=Han}\s()（）0-9]+$/u.test(label)
    ? bounded(label, 36) : '定向检查';
}

function firstDiffSummary(diff: TraceDiffSnapshot): string {
  const reason = dmStoreReason.test(diff.reason ?? '')
    ? diff.reason!
    : traceDifferenceMessage(knownTraceReasons.has(diff.reason ?? '') ? diff.reason : undefined, diff.status);
  if (dmStoreReason.test(diff.reason ?? '')) return reason;
  const oracle = traceEventSummary(diff.oracle ?? diff.mars);
  const dut = traceEventSummary(diff.dut ?? diff.sim);
  return `${reason} 参考结果 ${oracle}；待测 CPU ${dut}`;
}

function traceEventSummary(event: TraceEventSnapshot | undefined): string {
  if (!event) return '（无对应事件）';
  // Snapshots are report input too. Only the parser's bounded event tokens may enter metadata.
  if (!traceToken.test(event.pc) || !traceToken.test(event.target)
    || !traceToken.test(event.value) || (event.kind !== 'grf' && event.kind !== 'dm')) {
    return '（事件格式无效）';
  }
  const target = event.kind === 'grf' ? `$${event.target}` : `*${event.target}`;
  return `PC ${event.pc}，${target} <= ${event.value}`;
}

function safeEvidenceText(message: string): string {
  const clean = message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bfile:\/\/.*$/gi, '<path>')
    .replace(/\b[A-Za-z]:[\\/].*$/g, '<path>')
    .replace(/\\\\[^\s].*$/g, '<path>')
    .replace(/(^|[\s"'(：:，,（\[=])\/\/[^/\s].*$/g, '$1<path>')
    .replace(/(^|[\s"'(：:，,（\[=])\/[^/].*$/g, '$1<path>');
  return bounded(clean, maximumEvidenceLength);
}

function bounded(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1).trimEnd()}…`;
}
