// @index course-testing — Exact main-program commits and public eret-boundary protocol checks
import type { CpuTraceEvent } from '../language/mips/traceParser';
import type { P7ProbeMetadata } from './builtinAsmGenerator';
import type { P7ProbeCheckResult } from './p7ProbeCheck';

export function checkP7ReturnProbe(
  output: string,
  events: readonly CpuTraceEvent[],
  metadata: P7ProbeMetadata,
  checkRecords: (metadata: P7ProbeMetadata) => P7ProbeCheckResult
): P7ProbeCheckResult {
  const plan = metadata.returnBoundary!;
  const raised = (id: number) => protocol(output, 'external_raise', id);
  const firstRaised = raised(1);
  const secondRaised = raised(2);
  // Absence of a sampled return boundary is an explicit observation gap. Still
  // check every main-program write and every handler which was actually requested.
  const activeScenarios = secondRaised.length ? metadata.scenarios
    : firstRaised.length ? metadata.scenarios.slice(0, 1) : [];
  const result = checkRecords({ ...metadata, scenarios: activeScenarios });
  const failures = [...result.failures];
  const fail = (message: string) => failures.push({ scenarioId: 2, kind: 'return-boundary', message });
  const byPc = new Map<number, CpuTraceEvent[]>();
  for (const event of events) {
    const pc = Number.parseInt(event.pc, 16);
    const list = byPc.get(pc);
    if (list) list.push(event); else byPc.set(pc, [event]);
  }
  for (const expected of plan.mainCommits) {
    const actual = byPc.get(expected.pc) ?? [];
    if (actual.length !== 1 || !matches(actual[0], expected)) {
      fail(`主程序在 PC 0x${expected.pc.toString(16)} 的提交不符：应恰好有一次 ${expected.kind === 'grf' ? '寄存器' : '存储器'}写入，值为 0x${expected.value.toString(16)}`);
    }
    if (actual.length === 1) for (const record of result.records) {
      const victimPc = record.epc + ((record.cause >>> 31) ? 4 : 0);
      // These generated user paths are forward-only (apart from the write-free
      // halt). EPC/BD must describe the same retirement boundary as the writes.
      const older = expected.pc < victimPc;
      if (older ? actual[0].lineNumber >= record.firstLineNumber : actual[0].lineNumber <= record.lastLineNumber) {
        fail(`主程序 PC 0x${expected.pc.toString(16)} 的提交与异常处理程序 ${record.scenarioId} 的 EPC/BD 边界矛盾`);
      }
    }
  }
  if (plan.replayedLink) {
    const link = plan.replayedLink;
    // A taken jal itself precedes a BD=1 victim and is legally retried from EPC.
    // Accept only the link repetitions justified by the observed exception records.
    const count = 1 + result.records.filter(record =>
      (record.cause >>> 31) === 1 && record.epc === link.pc).length;
    const actual = byPc.get(link.pc) ?? [];
    if (actual.length !== count || actual.some(event => !matches(event, link))) {
      fail(`PC 0x${link.pc.toString(16)} 的 jal 链接写入不符：根据 EPC/BD 应有 ${count} 次相同写入`);
    }
    for (const record of result.records) {
      const priorReplays = result.records.filter(item => item.scenarioId < record.scenarioId
        && (item.cause >>> 31) === 1 && item.epc === link.pc).length;
      const victimPc = record.epc + ((record.cause >>> 31) ? 4 : 0);
      const before = priorReplays + (link.pc < victimPc ? 1 : 0);
      if (actual.filter(event => event.lineNumber < record.firstLineNumber).length !== before
        || actual.some(event => event.lineNumber >= record.firstLineNumber && event.lineNumber <= record.lastLineNumber)) {
        fail(`jal 链接写入的重放顺序与异常处理程序 ${record.scenarioId} 的 EPC/BD 边界矛盾`);
      }
    }
  }
  const expectedHandlers = activeScenarios.length;
  const ackStores = [...output.matchAll(/^CO_P7_PROBE return_ack_store\b[^\r\n]*/gm)];
  if (ackStores.length !== expectedHandlers) {
    fail(`中断发生器的存储次数不符：应为 ${expectedHandlers} 次，实际为 ${ackStores.length} 次`);
  }
  for (const expected of plan.handlerCommits) {
    const actual = byPc.get(expected.pc) ?? [];
    if (actual.length !== expectedHandlers) {
      fail(`异常处理程序在 PC 0x${expected.pc.toString(16)} 的提交次数不符：应有 ${expectedHandlers} 次写入`);
    }
    for (let index = 0; index < expectedHandlers; index++) {
      const record = result.records.find(item => item.scenarioId === index + 1);
      const value = typeof expected.value === 'number' ? expected.value + index * (expected.valueStride ?? 0)
        : record?.[expected.value];
      if (value !== undefined && !matches(actual[index], {
        kind: expected.kind, target: expected.target + index * (expected.targetStride ?? 0), value
      })) {
        fail(`异常处理程序 ${index + 1} 在 PC 0x${expected.pc.toString(16)} 的提交类型、目标或值错误`);
      }
    }
  }
  const allowedPcs = new Set([
    ...plan.mainCommits.map(commit => commit.pc), ...plan.handlerCommits.map(commit => commit.pc),
    ...(plan.replayedLink ? [plan.replayedLink.pc] : [])
  ]);
  for (const pc of byPc.keys()) {
    if (!allowedPcs.has(pc)) fail(`PC 0x${pc.toString(16)} 出现非预期的架构写入`);
  }

  const firstAck = protocol(output, 'external_ack', 1);
  const seen = protocol(output, 'return_seen', 2);
  const exited = protocol(output, 'return_exit', 2);
  const secondAck = protocol(output, 'external_ack', 2);
  if (seen.length > 1 || exited.length > 1) fail('返回边界被重复观测');
  if (secondRaised.length) {
    const order = [firstRaised, firstAck, seen, exited, secondRaised, secondAck];
    if (order.some(items => items.length !== 1)
      || order.some((items, index) => index > 0 && items[0] <= order[index - 1][0])) {
      fail('第二次中断必须发生在首次请求、应答、eret 观测和返回边界离开之后');
    }
  }
  const covered = firstRaised.length === 1 && secondRaised.length === 1;
  const coverage = [{
    covered,
    message: covered
      ? '已通过公开宏观 PC 观测到真实 eret 返回边界，并触发第二次中断；不假定 CP0 流水级或固定周期。'
      : '未覆盖：未观测到完整的真实 eret 返回边界和第二次中断；仍会检查已观测到的行为，但不能判定重入中断通过。'
  }];
  return { ...result, passed: failures.length === 0 && covered, failures, coverage };
}

function protocol(output: string, event: string, id: number): number[] {
  const pattern = new RegExp(`^CO_P7_PROBE ${event} scenario=${id}(?:\\s|$)[^\\r\\n]*`, 'gm');
  return [...output.matchAll(pattern)].map(match => match.index!);
}

function matches(event: CpuTraceEvent | undefined, expected: {
  kind: 'grf' | 'dm'; target: number; value: number;
}): boolean {
  return event !== undefined && event.kind === expected.kind
    && (event.kind === 'grf' ? Number(event.target) : Number.parseInt(event.target, 16)) === expected.target
    && Number.parseInt(event.value, 16) === (expected.value >>> 0);
}
