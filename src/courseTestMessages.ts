import { firstTraceDiffEntry, TraceDiffResult, TraceDiffStatus } from './language/mips/traceCompare';

const probeKindLabels = new Map<string, string>(Object.entries({
  'cp0-reset': 'CP0 复位',
  'return-boundary': '中断返回边界',
  tb: '测试平台接口',
  record: '异常记录',
  eret: '异常返回（eret）',
  timer: '定时器',
  timer0: '定时器 0',
  timer1: '定时器 1',
  external: '外部中断',
  internal: '内部异常',
  adel: '取指或读地址异常（AdEL）',
  ades: '写地址异常（AdES）',
  syscall: '系统调用异常（syscall）',
  ri: '保留指令异常（RI）',
  ov: '算术溢出异常（Ov）'
}));

export function p7ProbeKindLabel(kind: string): string {
  return probeKindLabels.get(kind) ?? kind;
}

/** Known legacy report text only; preserve unfamiliar diagnostics and all raw evidence. */
export function probeFailureMessage(message: string): string {
  const reset = /^CP0 reset (status|cause|epc) (.+)$/.exec(message);
  if (!reset) return message;
  const register = reset[1] === 'status' ? 'Status' : reset[1] === 'cause' ? 'Cause' : 'EPC';
  const sample = /^read-back differs: expected exactly one zero sample at PC (0x[0-9a-f]+)$/i.exec(reset[2]);
  if (sample) return `CP0 复位后 ${register} 读回值不符合预期：PC ${sample[1]} 应恰好记录一次零值样本`;
  return reset[2] === 'sample appeared after an exception record'
    ? `CP0 复位后 ${register} 的样本出现在异常记录之后` : message;
}

const legacyTraceReasons = new Map<string, string>(Object.entries({
  'DUT has an extra event.': '待测 CPU 多出一条写回事件。',
  'Oracle has an extra event.': '待测 CPU 缺少一条参考结果中的写回事件。',
  'Cycle/time differs.': '周期或时间不一致。',
  'PC differs.': '指令地址（PC）不一致。',
  'Write target kind differs.': '写入目标类型不一致（寄存器或存储器）。',
  'Write target differs.': '写入目标不一致。',
  'Write value differs.': '写入值不一致。'
}));

export function traceDifferenceMessage(reason?: string, status?: TraceDiffStatus): string {
  if (reason) return legacyTraceReasons.get(reason) ?? reason;
  switch (status) {
    case 'ok': return '写回事件一致';
    case 'diff': return '写回事件不一致';
    case 'cycle-diff': return '周期或时间不一致';
    case 'oracle-only':
    case 'mars-only': return '待测 CPU 缺少一条参考结果中的写回事件';
    case 'dut-only':
    case 'sim-only': return '待测 CPU 多出一条写回事件';
    default: return '差异原因未知';
  }
}

/** Accepts both legacy RunResult and provider-neutral EngineRunStatus. */
export function engineStageFailureMessage(prefix: string, result?: { stdout: string; stderr: string }): string {
  const detail = firstNonEmptyLine(result?.stderr) ?? firstNonEmptyLine(result?.stdout);
  return detail ? `${prefix}: ${detail}` : prefix;
}

export function engineRunWasCancelled(
  result?: { stopped?: boolean; stopReason?: string },
  signal?: AbortSignal
): boolean {
  if (result !== undefined) {
    return result.stopReason === 'cancelled'
      || (result.stopped === true && result.stopReason === 'aborted');
  }
  return signal?.aborted === true;
}

export function diffMessage(diff: TraceDiffResult): string {
  if (diff.matched) {
    return `${diff.summary.matchedEvents} 个事件匹配`;
  }
  const first = firstTraceDiffEntry(diff);
  return `第 ${diff.firstDiffIndex + 1} 个事件首次出现差异：${traceDifferenceMessage(first?.reason, first?.status)}`;
}

function firstNonEmptyLine(text?: string): string | undefined {
  return text?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}
