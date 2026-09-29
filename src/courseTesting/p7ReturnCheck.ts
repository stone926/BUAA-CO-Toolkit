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
      fail(`main commit at PC 0x${expected.pc.toString(16)}: expected exactly one ${expected.kind} write with value 0x${expected.value.toString(16)}`);
    }
    if (actual.length === 1) for (const record of result.records) {
      const victimPc = record.epc + ((record.cause >>> 31) ? 4 : 0);
      // These generated user paths are forward-only (apart from the write-free
      // halt). EPC/BD must describe the same retirement boundary as the writes.
      const older = expected.pc < victimPc;
      if (older ? actual[0].lineNumber >= record.firstLineNumber : actual[0].lineNumber <= record.lastLineNumber) {
        fail(`main commit at PC 0x${expected.pc.toString(16)} contradicts handler ${record.scenarioId} EPC/BD boundary`);
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
      fail(`jal link at PC 0x${link.pc.toString(16)}: expected ${count} identical writes justified by EPC/BD`);
    }
    for (const record of result.records) {
      const priorReplays = result.records.filter(item => item.scenarioId < record.scenarioId
        && (item.cause >>> 31) === 1 && item.epc === link.pc).length;
      const victimPc = record.epc + ((record.cause >>> 31) ? 4 : 0);
      const before = priorReplays + (link.pc < victimPc ? 1 : 0);
      if (actual.filter(event => event.lineNumber < record.firstLineNumber).length !== before
        || actual.some(event => event.lineNumber >= record.firstLineNumber && event.lineNumber <= record.lastLineNumber)) {
        fail(`jal link replay order contradicts handler ${record.scenarioId} EPC/BD boundary`);
      }
    }
  }
  const expectedHandlers = activeScenarios.length;
  const ackStores = [...output.matchAll(/^CO_P7_PROBE return_ack_store\b[^\r\n]*/gm)];
  if (ackStores.length !== expectedHandlers) {
    fail(`interrupt-generator store count differs: expected ${expectedHandlers}, got ${ackStores.length}`);
  }
  for (const expected of plan.handlerCommits) {
    const actual = byPc.get(expected.pc) ?? [];
    if (actual.length !== expectedHandlers) {
      fail(`handler commit at PC 0x${expected.pc.toString(16)}: expected ${expectedHandlers} writes`);
    }
    for (let index = 0; index < expectedHandlers; index++) {
      const record = result.records.find(item => item.scenarioId === index + 1);
      const value = typeof expected.value === 'number' ? expected.value + index * (expected.valueStride ?? 0)
        : record?.[expected.value];
      if (value !== undefined && !matches(actual[index], {
        kind: expected.kind, target: expected.target + index * (expected.targetStride ?? 0), value
      })) {
        fail(`handler ${index + 1} commit at PC 0x${expected.pc.toString(16)} has the wrong kind, target or value`);
      }
    }
  }
  const allowedPcs = new Set([
    ...plan.mainCommits.map(commit => commit.pc), ...plan.handlerCommits.map(commit => commit.pc),
    ...(plan.replayedLink ? [plan.replayedLink.pc] : [])
  ]);
  for (const pc of byPc.keys()) {
    if (!allowedPcs.has(pc)) fail(`unexpected architectural write at PC 0x${pc.toString(16)}`);
  }

  const firstAck = protocol(output, 'external_ack', 1);
  const seen = protocol(output, 'return_seen', 2);
  const exited = protocol(output, 'return_exit', 2);
  const secondAck = protocol(output, 'external_ack', 2);
  if (seen.length > 1 || exited.length > 1) fail('return boundary was observed more than once');
  if (secondRaised.length) {
    const order = [firstRaised, firstAck, seen, exited, secondRaised, secondAck];
    if (order.some(items => items.length !== 1)
      || order.some((items, index) => index > 0 && items[0] <= order[index - 1][0])) {
      fail('second interrupt must follow first request, acknowledgement, eret observation and boundary exit');
    }
  }
  const covered = firstRaised.length === 1 && secondRaised.length === 1;
  const coverage = [{
    covered,
    message: covered
      ? '已通过公开宏观 PC 观察真实 eret 返回边界并触发第二次中断；不假定 CP0 流水级或固定周期。'
      : '未覆盖：未观察到完整的真实 eret 返回边界与第二次中断；已有可观察行为仍被检查，不能记为重入中断通过。'
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
