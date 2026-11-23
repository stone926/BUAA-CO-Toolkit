// @index course-testing — Exact main-program commits and public eret-boundary protocol checks
import type { CpuTraceEvent } from '../language/mips/traceParser';
import type { P7ProbeMetadata } from './builtinAsmGenerator';
import type { P7ProbeCheckResult } from './p7ProbeCheck';
import { parseProbeHexWord, parseProbeRegister } from './p7ProbeTraceWord';

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
  const fail = (message: string, observed = false) => failures.push({
    scenarioId: 2, kind: 'return-boundary', message, ...(observed ? { observed: true as const } : {})
  });
  const byPc = new Map<number, CpuTraceEvent[]>();
  for (const event of events) {
    const pc = parseProbeHexWord(event.pc);
    if (!Number.isFinite(pc)) {
      fail(`架构写入的 PC 含未知位或格式无效：${event.pc}`, true);
      continue;
    }
    const list = byPc.get(pc);
    if (list) list.push(event); else byPc.set(pc, [event]);
  }
  const lastObservedMainPc = plan.mainCommits.reduce((last, commit) => byPc.has(commit.pc)
    ? Math.max(last, commit.pc) : last, 0);
  for (const expected of plan.mainCommits) {
    const actual = byPc.get(expected.pc) ?? [];
    const required = secondRaised.length || lastObservedMainPc > expected.pc || result.records.some(record =>
      expected.pc < record.epc + ((record.cause >>> 31) ? 4 : 0));
    if ((required || actual.length) && (actual.length !== 1 || !matches(actual[0], expected))) {
      fail(`主程序在 PC 0x${expected.pc.toString(16)} 的提交不符：应恰好有一次 ${expected.kind === 'grf' ? '寄存器' : '存储器'}写入，值为 0x${expected.value.toString(16)}`, actual.length > 0);
    }
    if (actual.length === 1) for (const record of result.records) {
      const victimPc = record.epc + ((record.cause >>> 31) ? 4 : 0);
      // These generated user paths are forward-only (apart from the write-free
      // halt). EPC/BD must describe the same retirement boundary as the writes.
      const older = expected.pc < victimPc;
      if (older ? actual[0].lineNumber >= record.firstLineNumber : actual[0].lineNumber <= record.lastLineNumber) {
        fail(`主程序 PC 0x${expected.pc.toString(16)} 的提交与异常处理程序 ${record.scenarioId} 的 EPC/BD 边界矛盾`, true);
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
    const wrongLink = actual.some(event => !matches(event, link));
    if (actual.length > count || ((secondRaised.length || lastObservedMainPc > link.pc) && actual.length !== count) || wrongLink) {
      fail(`PC 0x${link.pc.toString(16)} 的 jal 链接写入不符：根据 EPC/BD 应有 ${count} 次相同写入`, actual.length > count || wrongLink);
    }
    for (const record of result.records) {
      const priorReplays = result.records.filter(item => item.scenarioId < record.scenarioId
        && (item.cause >>> 31) === 1 && item.epc === link.pc).length;
      const victimPc = record.epc + ((record.cause >>> 31) ? 4 : 0);
      const before = priorReplays + (link.pc < victimPc ? 1 : 0);
      if (actual.filter(event => event.lineNumber < record.firstLineNumber).length !== before
        || actual.some(event => event.lineNumber >= record.firstLineNumber && event.lineNumber <= record.lastLineNumber)) {
        fail(`jal 链接写入的重放顺序与异常处理程序 ${record.scenarioId} 的 EPC/BD 边界矛盾`, true);
      }
    }
  }
  const expectedHandlers = activeScenarios.length;
  for (const expected of plan.handlerCommits) {
    const actual = byPc.get(expected.pc) ?? [];
    if (actual.length !== expectedHandlers) {
      fail(`异常处理程序在 PC 0x${expected.pc.toString(16)} 的提交次数不符：应有 ${expectedHandlers} 次写入`, actual.length > expectedHandlers);
    }
    for (let index = 0; index < expectedHandlers; index++) {
      const record = result.records.find(item => item.scenarioId === index + 1);
      const value = typeof expected.value === 'number' ? expected.value + index * (expected.valueStride ?? 0)
        : record?.[expected.value];
      if (value !== undefined && !matches(actual[index], {
        kind: expected.kind, target: expected.target + index * (expected.targetStride ?? 0), value
      })) {
        fail(`异常处理程序 ${index + 1} 在 PC 0x${expected.pc.toString(16)} 的提交类型、目标或值错误`, actual[index] !== undefined);
      }
    }
  }
  const allowedPcs = new Set([
    ...plan.mainCommits.map(commit => commit.pc), ...plan.handlerCommits.map(commit => commit.pc),
    ...(plan.replayedLink ? [plan.replayedLink.pc] : [])
  ]);
  for (const pc of byPc.keys()) {
    if (!allowedPcs.has(pc)) fail(`PC 0x${pc.toString(16)} 出现非预期的架构写入`, true);
  }

  const firstAck = protocol(output, 'external_ack', 1);
  const seen = protocol(output, 'return_seen', 2);
  const exited = protocol(output, 'return_exit', 2);
  const secondAck = protocol(output, 'external_ack', 2);
  // Archived traces predate the TB's early-ACK marker. Their public ACK
  // timestamp and the timestamp of the required DM write still prove order.
  for (const [index, acks] of [firstAck, secondAck].entries()) {
    const id = index + 1;
    const time = acks[0]?.time;
    if (time === undefined || result.diagnostics.includes(`external_ack_early:${id}`)) continue;
    const record = result.records.find(item => item.scenarioId === id);
    const tail = events.find(event => event.lineNumber === record?.lastLineNumber);
    if (!record || (tail?.cycle !== undefined && tail.cycle >= Number(time))) {
      failures.push({ scenarioId: id, kind: 'external', observed: true,
        message: '中断发生器在处理程序完成 DM 记录之前已应答' });
    }
  }
  if (firstRaised[0]?.pc !== undefined && rawMacroPc(firstRaised[0].pc) !== metadata.scenarios[0].triggerPc) {
    fail('首次中断触发时的原始宏观 PC 与预定受害指令不符', true);
  }
  if (seen.length > 1 || exited.length > 1) fail('返回边界被重复观测');
  const second = metadata.scenarios[1];
  const expected = second.expectedRecords?.[0];
  const directPcs = new Set(expected?.allowedEpc ?? second.allowedEpc);
  const delayPcs = new Set(expected?.allowedBdEpc?.map(pc => pc + 4));
  const returnPc = exited[0] && rawMacroPc(exited[0].pc);
  const sawEret = seen[0] && rawMacroPc(seen[0].pc) === second.afterReturnOf?.eretPc;
  const legalReturn = returnPc !== undefined && (directPcs.has(returnPc) || delayPcs.has(returnPc));
  if (seen[0] && !sawEret) {
    fail('返回观测中的宏观 PC 与 eret 指令地址不符', true);
  }
  if (returnPc !== undefined && !legalReturn) {
    fail(`eret 离开后观测到非法返回地址 ${displayMacroPc(exited[0].pc)}`, true);
  }
  const requestOrder = [firstRaised, firstAck, seen, exited, secondRaised];
  const orderedRequest = requestOrder.every((items, index) => items.length === 1
    && (index === 0 || items[0].position > requestOrder[index - 1][0].position));
  // Older testbenches captured the raw PC in return_exit on the same edge
  // and printed external_raise immediately afterwards without its own PC.
  const legacyPc = firstRaised[0]?.pc === undefined && secondRaised[0]?.pc === undefined;
  const raisedPc = legacyPc ? returnPc : rawMacroPc(secondRaised[0]?.pc);
  const sameObservation = raisedPc !== undefined && Number.isFinite(raisedPc) && raisedPc === returnPc
    && secondRaised[0]?.time === exited[0]?.time;
  if (secondRaised.length) {
    if (!orderedRequest || secondAck.length !== 1 || secondAck[0].position <= secondRaised[0].position) {
      fail('第二次中断必须发生在首次请求、应答、eret 观测和返回边界离开之后');
    }
    if (!sameObservation) {
      fail('第二次中断触发时的原始宏观 PC 与返回边界观测不符');
    }
    const record = result.records.find(item => item.scenarioId === second.id);
    if (record) {
      const bd = (record.cause >>> 31) === 1;
      const actualVictim = record.epc + (bd ? 4 : 0);
      if (!(bd ? delayPcs : directPcs).has(actualVictim) || actualVictim !== raisedPc) {
        fail('第二次中断的 EPC/BD 边界与触发时的原始宏观 PC 或程序的实际分支延迟槽不符', sameObservation);
      }
    }
  }
  const covered = orderedRequest && !!sawEret && legalReturn && sameObservation;
  const coverage = [{
    covered,
    message: covered
      ? '已通过公开宏观 PC 观测到真实 eret 返回边界，并触发第二次中断；不假定 CP0 流水级或固定周期。'
      : '未覆盖：未观测到完整的真实 eret 返回边界和第二次中断；仍会检查已观测到的行为，但不能判定重入中断通过。'
  }];
  return { ...result, passed: failures.length === 0 && covered, failures, coverage };
}

function protocol(output: string, event: string, id: number): Array<{ position: number; pc?: string; time?: string }> {
  const pattern = new RegExp(`^CO_P7_PROBE ${event} scenario=${id}(?=[ \\t]|$)[^\\r\\n]*`, 'gm');
  return [...output.matchAll(pattern)].map(match => ({
    position: match.index!,
    pc: /[ \t]pc=([^ \t]*)/.exec(match[0])?.[1],
    time: /[ \t]time=(\d+)/.exec(match[0])?.[1]
  }));
}

function rawMacroPc(token: string | undefined): number {
  return token !== undefined && /^[0-9a-f]{8}$/i.test(token) ? parseProbeHexWord(token) : Number.NaN;
}

function displayMacroPc(token: string | undefined): string {
  return token !== undefined && /^[0-9a-fxz]{8}$/i.test(token) ? `0x${token}` : '（字段无效）';
}

function matches(event: CpuTraceEvent | undefined, expected: {
  kind: 'grf' | 'dm'; target: number; value: number;
}): boolean {
  return event !== undefined && event.kind === expected.kind
    && (event.kind === 'grf' ? parseProbeRegister(event.target) : parseProbeHexWord(event.target)) === expected.target
    && parseProbeHexWord(event.value) === (expected.value >>> 0);
}
