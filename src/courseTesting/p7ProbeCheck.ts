import { CpuTraceEvent } from '../language/mips/traceParser';
import { P7ProbeExpectedRecord, P7ProbeMetadata, P7ProbeScenario } from './builtinAsmGenerator';
import { checkP7ReturnProbe } from './p7ReturnCheck';
import {
  p7CauseExcCodeMask,
  p7ExcCodeAdel,
  p7ExcCodeAdes,
  p7ExcCodeOv,
  p7ExcCodeRi,
  p7ExcCodeSyscall,
  p7ProbeKindAdel,
  p7ProbeKindAdes,
  p7ProbeKindExternal,
  p7ProbeKindInternal,
  p7ProbeKindOv,
  p7ProbeKindRi,
  p7ProbeKindSyscall,
  p7ProbeKindTimer0,
  p7ProbeKindTimer1,
  p7ProbeEretPoisonAddress,
  p7ProbeMaskedInterruptMarkerAddress,
  p7ProbeMode1FailureMarker,
  p7ExternalInterruptAckAddress,
  p7ProbeMagic,
  p7StatusEnableAllCourseInterrupts
} from './builtinAsm/p7/constants';

const p7StatusExlMask = 0x0002;
const p7RequiredExceptionStatusMask = p7StatusEnableAllCourseInterrupts | p7StatusExlMask;
const p7CauseIpMask = 0xfc00;
const p7CauseBdMask = 0x80000000;
const p7ImplementedCauseMask = p7CauseBdMask | p7CauseIpMask | p7CauseExcCodeMask;

export interface P7ProbeRecord {
  index: number;
  scenarioId: number;
  kindCode: number;
  status: number;
  cause: number;
  epc: number;
  aux0: number;
  aux1: number;
  firstLineNumber: number;
  lastLineNumber: number;
  duplicateFields: number[];
}

export interface P7ProbeFailure {
  scenarioId: number;
  kind: string;
  message: string;
}

export interface P7ProbeCheckResult {
  passed: boolean;
  records: P7ProbeRecord[];
  failures: P7ProbeFailure[];
  diagnostics: string[];
  coverage?: Array<{ covered: boolean; message: string }>;
}

export function checkP7Probe(
  simOutput: string,
  simEvents: readonly CpuTraceEvent[],
  metadata: P7ProbeMetadata
): P7ProbeCheckResult {
  if (metadata.returnBoundary) {
    return checkP7ReturnProbe(simOutput, simEvents, metadata,
      activeMetadata => checkProbeRecords(simOutput, simEvents, activeMetadata));
  }
  return checkProbeRecords(simOutput, simEvents, metadata);
}

function checkProbeRecords(
  simOutput: string,
  simEvents: readonly CpuTraceEvent[],
  metadata: P7ProbeMetadata
): P7ProbeCheckResult {
  const records = reconstructProbeRecords(simEvents, metadata);
  const diagnostics = parseProbeDiagnostics(simOutput);
  const failures: P7ProbeFailure[] = [];
  // Each scenario has several exact commit obligations. Index once instead of rescanning the
  // complete trace for every operand/result/forbidden PC as coverage grows.
  const commitsByPc = new Map<number, CpuTraceEvent[]>();
  for (const event of simEvents) {
    const pc = parseHex(event.pc);
    if (!Number.isFinite(pc)) continue;
    const commits = commitsByPc.get(pc);
    if (commits) commits.push(event);
    else commitsByPc.set(pc, [event]);
  }
  const atPc = (pc: number): readonly CpuTraceEvent[] => commitsByPc.get(pc >>> 0) ?? [];
  for (const [name, expected] of Object.entries(metadata.initialCp0 ?? {})) {
    const writes = atPc(expected.pc);
    const matches = matchingCommits(writes, expected);
    if (writes.length !== 1 || matches.length !== 1) {
      failures.push({
        scenarioId: 0, kind: 'cp0-reset',
        message: `CP0 复位后 ${cp0DisplayName(name)} 读回值不符合预期：PC 0x${expected.pc.toString(16)} 应恰好记录一次零值样本`
      });
    } else if (records.some((record) => record.firstLineNumber <= matches[0].lineNumber)) {
      failures.push({
        scenarioId: 0, kind: 'cp0-reset',
        message: `CP0 复位后 ${cp0DisplayName(name)} 的样本出现在异常记录之后`
      });
    }
  }
  for (const diagnostic of diagnostics) {
    if (diagnostic.includes('mmio_on_dm')
      || diagnostic.includes('external_raise_unarmed')
      || diagnostic.includes('invalid_store_effect')) {
      failures.push({ scenarioId: 0, kind: 'tb', message: protocolDiagnosticMessage(diagnostic) });
    }
  }
  for (const event of simEvents) {
    if (event.kind === 'dm' && parseHex(event.target) === (p7ProbeEretPoisonAddress >>> 0)) {
      failures.push({
        scenarioId: 0,
        kind: 'eret',
        message: `紧随 eret 的指令向毒值地址 0x${p7ProbeEretPoisonAddress.toString(16)} 提交了 DM 写入`
      });
    }
    if (event.kind === 'dm'
      && parseHex(event.target) === (p7ProbeMaskedInterruptMarkerAddress >>> 0)
      && parseHex(event.value) === (p7ProbeMode1FailureMarker >>> 0)) {
      failures.push({
        scenarioId: 0,
        kind: 'timer',
        message: '模式 1 定时器在下一次中断的等待准备完成前仍产生了残留中断请求'
      });
    }
    if (event.kind === 'dm' && parseHex(event.target) > 0x2fff) {
      failures.push({
        scenarioId: 0,
        kind: 'tb',
        message: `DM 轨迹地址超出课程规定范围 0x0000..0x2fff：0x${parseHex(event.target).toString(16)}`
      });
    }
  }

  const expectedRecordCount = metadata.scenarios.length;
  const scenarioIds = new Set(metadata.scenarios.map((scenario) => scenario.id));
  for (const record of records) {
    if (record.scenarioId === 0 || !scenarioIds.has(record.scenarioId)) {
      failures.push({ scenarioId: record.scenarioId, kind: 'record', message: `探针记录中的场景编号 ${record.scenarioId} 不在预期范围内` });
    }
    if (record.index >= expectedRecordCount) {
      failures.push({ scenarioId: record.scenarioId, kind: 'record', message: `探针记录索引 ${record.index} 不在预期范围内` });
    }
    if (record.duplicateFields.length) {
      failures.push({
        scenarioId: record.scenarioId,
        kind: 'record',
        message: `探针记录 ${record.index} 的字段被重复写入：${record.duplicateFields.join(', ')}`
      });
    }
  }

  let recordIndex = 0;
  for (const scenario of metadata.scenarios) {
    for (const pc of scenario.forbiddenCommitPcs ?? []) {
      if (atPc(pc).length) {
        failures.push(failure(scenario, `禁止提交的后续指令/错误路径 PC 0x${(pc >>> 0).toString(16)} 已提交`));
      }
    }
    const expectedRecords = expectedRecordsFor(scenario);
    const internalException = scenario.kind === 'internal'
      || expectedRecords.some((expected) => expected.expectedExcCode === undefined || expected.expectedExcCode !== 0);
    const victimPc = scenario.victimPc;
    if (internalException && victimPc !== undefined && Number.isFinite(victimPc)) {
      const victimCommit = atPc(victimPc)[0];
      if (victimCommit) {
        const commitTarget = victimCommit.kind === 'grf' ? `$${victimCommit.target}` : `*${victimCommit.target}`;
        failures.push(failure(
          scenario,
          `触发异常的指令 PC 0x${(victimPc >>> 0).toString(16)} 不应提交，但已写入 ${victimCommit.kind === 'grf' ? 'GPR' : 'DM'} ${commitTarget}`
        ));
      }
    }
    const scenarioRecords = records.filter((item) => item.scenarioId === scenario.id);
    if (scenarioRecords.length !== 1) {
      const label = scenarioRecords.length > 1 ? 'duplicate' : 'missing';
      failures.push(failure(
        scenario,
        `探针记录${label === 'duplicate' ? '重复' : '缺失'}：应有 1 条，实际 ${scenarioRecords.length} 条`
      ));
    }
    let finalRecord: P7ProbeRecord | undefined;
    const currentIndex = recordIndex++;
    const record = records.find((item) => item.index === currentIndex);
    if (!record) {
      failures.push(failure(scenario, `缺少索引为 ${currentIndex} 的探针记录`));
    } else if (record.scenarioId !== scenario.id) {
      failures.push(failure(
        scenario,
        `探针记录顺序错误：索引 ${currentIndex} 应为场景 ${scenario.id}，实际为 ${record.scenarioId}`
      ));
    } else {
      finalRecord = record;
      validateExpectedRecord(record, expectedRecords[0], scenario, 0, failures);
      if (expectedRecords.length > 1) {
        const statusSamples = scenario.replayStatusAddress === undefined ? [] : simEvents.filter((event) =>
          event.kind === 'dm' && parseHex(event.target) === (scenario.replayStatusAddress! >>> 0)
          && event.lineNumber > record.firstLineNumber && event.lineNumber < record.lastLineNumber);
        if (scenario.replayStatusAddress !== undefined && statusSamples.length !== 1) {
          failures.push(failure(scenario, `记录 2：应独立采样一次 Status，实际 ${statusSamples.length} 次`));
        }
        const replayRecord: P7ProbeRecord = {
          ...record,
          // Historical metadata predates the separate observation. Newly generated probes
          // must supply it; never infer the second EXL from the first interrupt entry.
          status: scenario.replayStatusAddress === undefined ? record.status
            : statusSamples.length === 1 ? parseHex(statusSamples[0].value) : 0,
          cause: record.aux0,
          epc: record.aux1,
          aux0: 0,
          aux1: 0
        };
        validateExpectedRecord(replayRecord, expectedRecords[1], scenario, 1, failures);
      }
      if (expectedRecords.length > 2) {
        failures.push(failure(scenario, `不支持打包 ${expectedRecords.length} 组 CP0 观测值`));
      }
    }
    if (scenario.kind === 'external') {
      const armIndex = diagnostics.indexOf(`external_arm:${scenario.id}`);
      const raiseIndex = diagnostics.indexOf(`external_raise:${scenario.id}`);
      const ackIndex = diagnostics.indexOf(`external_ack:${scenario.id}`);
      const armCount = diagnostics.filter((item) => item === `external_arm:${scenario.id}`).length;
      const raiseCount = diagnostics.filter((item) => item === `external_raise:${scenario.id}`).length;
      const ackCount = diagnostics.filter((item) => item === `external_ack:${scenario.id}`).length;
      const requiresArm = Number.isFinite(scenario.armAddress) && Number.isFinite(scenario.armValue);
      if (requiresArm && armIndex < 0) {
        failures.push(failure(scenario, '软件标记未能启动外部中断'));
      }
      if (requiresArm && raiseIndex < 0) {
        failures.push(failure(scenario, '启动标记之后未发出外部中断请求'));
      }
      if (ackIndex < 0) {
        failures.push(failure(scenario, `外部中断未通过 0x${p7ExternalInterruptAckAddress.toString(16)} 应答`));
      }
      if (requiresArm && armCount > 1) {
        failures.push(failure(scenario, `外部中断启动标记出现了 ${armCount} 次`));
      }
      if (raiseCount > 1) {
        failures.push(failure(scenario, `外部中断请求发出了 ${raiseCount} 次`));
      }
      if (ackCount > 1) {
        failures.push(failure(scenario, `外部中断应答了 ${ackCount} 次`));
      }
      if (requiresArm && armIndex >= 0 && raiseIndex >= 0 && armIndex > raiseIndex) {
        failures.push(failure(scenario, '外部中断请求早于启动标记发出'));
      }
      if (raiseIndex >= 0 && ackIndex >= 0 && raiseIndex > ackIndex) {
        failures.push(failure(scenario, '外部中断应答早于请求发出'));
      }
    }
    if ((scenario.kind === 'timer0' || scenario.kind === 'timer1')
      && expectedRecords.length === 1
      && !expectedRecords[0].allowedAuxPairs?.length
      && !expectedRecords[0].requireEqualAuxPair) {
      const record = scenarioRecords[0];
      if (!record) {
        continue;
      }
      if (record.aux0 !== 0) {
        failures.push(failure(scenario, `计时器清除后的 CTRL 不符：应为 0，实际为 0x${(record.aux0 >>> 0).toString(16)}`));
      }
      if (record.aux1 !== 0) {
        failures.push(failure(scenario, `计时器清除后的 COUNT 不符：应为 0，实际为 0x${(record.aux1 >>> 0).toString(16)}`));
      }
    }
    if (scenario.requireCompletion) {
      const completionEvents = findCompletionEvents(atPc(scenario.donePc), scenario);
      if (completionEvents.length !== 1) {
        failures.push(failure(
          scenario,
          `完成标记不符：应在 0x${(scenario.donePc >>> 0).toString(16)} 恰好提交一次 $1=${scenario.id}，实际 ${completionEvents.length} 次`
        ));
      } else if (finalRecord && completionEvents[0].lineNumber <= finalRecord.lastLineNumber) {
        failures.push(failure(scenario, '完成标记出现在最后一条异常处理程序记录之前'));
      }
    }
    const requiredCommits = [...(scenario.requiredPreHandlerCommits ?? []), ...(scenario.requiredCommits ?? [])];
    for (const pc of new Set(requiredCommits.map((commit) => commit.pc >>> 0))) {
      const expectedCount = requiredCommits.filter((commit) => (commit.pc >>> 0) === pc).length;
      const actualCount = atPc(pc).length;
      if (actualCount !== expectedCount) {
        failures.push(failure(scenario,
          `必要提交 PC 0x${pc.toString(16)}：应有 ${expectedCount} 次写入，实际 ${actualCount} 次`));
      }
    }
    for (const expectedCommit of scenario.requiredPreHandlerCommits ?? []) {
      const commits = matchingCommits(atPc(expectedCommit.pc), expectedCommit);
      if (commits.length !== 1) {
        failures.push(failure(
          scenario,
          `必要的异常前 ${expectedCommit.kind.toUpperCase()} 提交（PC 0x${(expectedCommit.pc >>> 0).toString(16)}）：应恰好一次，实际 ${commits.length} 次`
        ));
      } else if (finalRecord && commits[0].lineNumber >= finalRecord.firstLineNumber) {
        failures.push(failure(scenario, '必要的异常前提交出现在异常处理程序记录开始之后'));
      }
    }
    for (const expectedCommit of scenario.requiredCommits ?? []) {
      const commits = matchingCommits(atPc(expectedCommit.pc), expectedCommit);
      if (commits.length !== 1) {
        failures.push(failure(
          scenario,
          `必要的 ${expectedCommit.kind.toUpperCase()} 提交（PC 0x${(expectedCommit.pc >>> 0).toString(16)}）：应恰好一次，实际 ${commits.length} 次`
        ));
      } else if (finalRecord && commits[0].lineNumber <= finalRecord.lastLineNumber) {
        failures.push(failure(scenario, '必要的重试提交出现在异常处理程序记录之前'));
      }
    }
  }

  return {
    passed: failures.length === 0,
    records,
    failures,
    diagnostics
  };
}

function matchingCommits(
  simEvents: readonly CpuTraceEvent[],
  expected: { pc: number; kind: 'grf' | 'dm'; target: number; value: number }
): CpuTraceEvent[] {
  return simEvents.filter((event) => event.kind === expected.kind
    && parseHex(event.pc) === (expected.pc >>> 0)
    && (event.kind === 'grf' ? Number(event.target) : parseHex(event.target)) === (expected.target >>> 0)
    && parseHex(event.value) === (expected.value >>> 0));
}

function expectedRecordsFor(scenario: P7ProbeScenario): P7ProbeExpectedRecord[] {
  if (scenario.expectedRecords?.length) {
    return scenario.expectedRecords;
  }
  return [{
    expectedIpMask: scenario.expectedIpMask,
    expectedExcCode: scenario.expectedExcCode ?? expectedExcCodeForKind(scenario.kind),
    expectedBd: scenario.expectedBd,
    allowedEpc: scenario.allowedEpc
  }];
}

function validateExpectedRecord(
  record: P7ProbeRecord,
  expected: P7ProbeExpectedRecord,
  scenario: P7ProbeScenario,
  scenarioRecordIndex: number,
  failures: P7ProbeFailure[]
): void {
  const recordLabel = expectedRecordsFor(scenario).length > 1 ? `记录 ${scenarioRecordIndex + 1}：` : '';
  if (record.kindCode !== kindCode(scenario.kind)) {
    failures.push(failure(scenario, `${recordLabel}场景类型编码不符：应为 ${kindCode(scenario.kind)}，实际为 ${record.kindCode}`));
  }
  // The tutorial requires every unimplemented CP0 bit to remain zero. The probe writes the
  // complete course interrupt mask before each scenario, so Status at handler entry is exact:
  // IM[2:0], EXL, and IE are set and no other bit may leak implementation state.
  if ((record.status >>> 0) !== (p7RequiredExceptionStatusMask >>> 0)) {
    failures.push(failure(
      scenario,
      `${recordLabel}SR/Status 不符：应恰为 0x${p7RequiredExceptionStatusMask.toString(16)}，实际为 0x${(record.status >>> 0).toString(16)}`
    ));
  }

  const unsupportedCauseBits = (record.cause & ~p7ImplementedCauseMask) >>> 0;
  if (unsupportedCauseBits !== 0) {
    failures.push(failure(
      scenario,
      `${recordLabel}Cause 的未实现位应为 0，实际非零位为 0x${unsupportedCauseBits.toString(16)}`
    ));
  }

  const excCode = (record.cause & p7CauseExcCodeMask) >>> 2;
  const internalException = scenario.kind === 'internal'
    || expected.expectedExcCode === undefined
    || expected.expectedExcCode !== 0;
  if (expected.expectedExcCode !== undefined) {
    if (excCode !== expected.expectedExcCode) {
      failures.push(failure(scenario, `${recordLabel}Cause.ExcCode 不符：应为 ${expected.expectedExcCode}，实际为 ${excCode}`));
    }
  } else if (scenario.kind === 'internal' && excCode === 0) {
    failures.push(failure(scenario, `${recordLabel}内部异常记录的 Cause.ExcCode 为 0`));
  }

  const actualIp = record.cause & p7CauseIpMask;
  const expectedIp = expected.expectedIpMask & p7CauseIpMask;
  const allowedIpMasks = expected.allowedIpMasks?.map((value) => value & p7CauseIpMask) ?? [expectedIp];
  if (!allowedIpMasks.includes(actualIp)) {
    failures.push(failure(
      scenario,
      `${recordLabel}Cause.IP 不符：允许 ${allowedIpMasks.map((value) => `0x${value.toString(16)}`).join(' 或 ')}，实际为 0x${actualIp.toString(16)}`
    ));
  }

  const inDelaySlot = (record.cause & p7CauseBdMask) !== 0;
  const expectedBd = expected.expectedBd ?? (internalException ? false : undefined);
  if (expectedBd !== undefined && inDelaySlot !== expectedBd) {
    failures.push(failure(
      scenario,
      `${recordLabel}Cause.BD 不符：应为 ${expectedBd ? 1 : 0}，实际为 ${inDelaySlot ? 1 : 0}`
    ));
  } else if (expectedBd === undefined && inDelaySlot
    && !(expected.allowedBdEpc ?? (scenario.waitPc === undefined ? [] : [scenario.waitPc]))
      .includes(record.epc >>> 0)) {
    const allowedBdEpc = expected.allowedBdEpc
      ?? (scenario.waitPc === undefined ? [] : [scenario.waitPc]);
    failures.push(failure(
      scenario,
      `${recordLabel}Cause.BD=1 时，EPC 必须指向${allowedBdEpc.length === 1 ? '探针等待分支' : '允许的等待分支'}：${allowedBdEpc.length ? allowedBdEpc.map((pc) => `0x${(pc >>> 0).toString(16)}`).join(' 或 ') : '无可用 PC'}`
    ));
  }
  if (expected.allowedEpc.length && !expected.allowedEpc.includes(record.epc >>> 0)) {
    failures.push(failure(
      scenario,
      `${recordLabel}EPC 0x${(record.epc >>> 0).toString(16)} 不在允许范围内（${expected.allowedEpc.map((pc) => `0x${(pc >>> 0).toString(16)}`).join(', ')}）`
    ));
  }
  const auxPairDescription = expected.auxPairDescription ?? 'HI/LO';
  if (expected.requireEqualAuxPair && record.aux0 !== record.aux1) {
    failures.push(failure(
      scenario,
      `${recordLabel}${auxPairDescription} 在异常前后发生变化：之前为 0x${record.aux0.toString(16)}，之后为 0x${record.aux1.toString(16)}`
    ));
  }
  if (expected.allowedAuxPairs?.length
    && !expected.allowedAuxPairs.some(([aux0, aux1]) => (aux0 >>> 0) === record.aux0 && (aux1 >>> 0) === record.aux1)) {
    failures.push(failure(
      scenario,
      `${recordLabel}${auxPairDescription} 观测值不符：实际为 0x${record.aux0.toString(16)}/0x${record.aux1.toString(16)}`
    ));
  }
}

function findCompletionEvents(
  simEvents: readonly CpuTraceEvent[],
  scenario: P7ProbeScenario
): CpuTraceEvent[] {
  return simEvents.filter((event) => event.kind === 'grf'
    && parseHex(event.pc) === (scenario.donePc >>> 0)
    && event.target === '1'
    && parseHex(event.value) === (scenario.id >>> 0));
}

function reconstructProbeRecords(
  simEvents: readonly CpuTraceEvent[],
  metadata: P7ProbeMetadata
): P7ProbeRecord[] {
  const fields = new Map<number, { values: number[]; counts: number[]; lineNumbers: number[] }>();
  const maxUsefulRecords = Math.min(Math.max(metadata.scenarios.length + 8, 1), 64);
  const logByteLength = metadata.recordWords * maxUsefulRecords * 4;
  for (const event of simEvents) {
    if (event.kind !== 'dm') {
      continue;
    }
    const address = parseHex(event.target);
    if (address < metadata.logBase || address >= metadata.logBase + logByteLength) {
      continue;
    }
    const offset = address - metadata.logBase;
    if (offset % 4 !== 0) {
      continue;
    }
    const wordOffset = offset / 4;
    const recordIndex = Math.floor(wordOffset / metadata.recordWords);
    const fieldIndex = wordOffset % metadata.recordWords;
    const record = fields.get(recordIndex) ?? { values: [], counts: [], lineNumbers: [] };
    record.values[fieldIndex] = parseHex(event.value);
    record.counts[fieldIndex] = (record.counts[fieldIndex] ?? 0) + 1;
    record.lineNumbers[fieldIndex] = event.lineNumber;
    fields.set(recordIndex, record);
  }

  const records: P7ProbeRecord[] = [];
  for (const [index, fieldState] of [...fields.entries()].sort((a, b) => a[0] - b[0])) {
    const { values, counts, lineNumbers } = fieldState;
    const requiredValues = Array.from({ length: metadata.recordWords }, (_, fieldIndex) => values[fieldIndex]);
    if (requiredValues.some((value) => !Number.isFinite(value))) {
      continue;
    }
    if ((values[0] >>> 0) !== (p7ProbeMagic >>> 0)) {
      continue;
    }
    records.push({
      index,
      scenarioId: values[1] >>> 0,
      kindCode: values[2] >>> 0,
      status: values[3] >>> 0,
      cause: values[4] >>> 0,
      epc: values[5] >>> 0,
      aux0: values[6] >>> 0,
      aux1: values[7] >>> 0,
      firstLineNumber: Math.min(...lineNumbers.filter(Number.isFinite)),
      lastLineNumber: Math.max(...lineNumbers.filter(Number.isFinite)),
      duplicateFields: counts
        .map((count, fieldIndex) => count > 1 ? fieldIndex : -1)
        .filter((fieldIndex) => fieldIndex >= 0)
    });
  }
  return records;
}

function parseProbeDiagnostics(text: string): string[] {
  const diagnostics: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const arm = /CO_P7_PROBE\s+external_arm\s+scenario=(\d+)/.exec(line);
    if (arm) {
      diagnostics.push(`external_arm:${Number(arm[1])}`);
    }
    const raise = /CO_P7_PROBE\s+external_raise\s+scenario=(\d+)/.exec(line);
    if (raise) {
      diagnostics.push(`external_raise:${Number(raise[1])}`);
    }
    const ack = /CO_P7_PROBE\s+external_ack\s+scenario=(\d+)/.exec(line);
    if (ack) {
      diagnostics.push(`external_ack:${Number(ack[1])}`);
    }
    const timeout = /CO_P7_PROBE\s+timeout\s+scenario=(\d+)/.exec(line);
    if (timeout) {
      diagnostics.push(`timeout:${Number(timeout[1])}`);
    }
    if (/CO_P7_PROBE\s+mmio_on_dm\b/.test(line)) {
      diagnostics.push(line.trim());
    }
    if (/CO_P7_PROBE\s+external_raise_unarmed\b/.test(line)) {
      diagnostics.push(line.trim());
    }
    if (/CO_P7_PROBE\s+invalid_store_effect\b/.test(line)) {
      diagnostics.push(line.trim());
    }
  }
  return diagnostics;
}

function kindCode(kind: P7ProbeScenario['kind']): number {
  switch (kind) {
    case 'external':
      return p7ProbeKindExternal;
    case 'timer0':
      return p7ProbeKindTimer0;
    case 'timer1':
      return p7ProbeKindTimer1;
    case 'adel':
      return p7ProbeKindAdel;
    case 'ades':
      return p7ProbeKindAdes;
    case 'syscall':
      return p7ProbeKindSyscall;
    case 'ri':
      return p7ProbeKindRi;
    case 'ov':
      return p7ProbeKindOv;
    case 'internal':
      return p7ProbeKindInternal;
    default:
      throw new Error(`未知的 P7 探针场景类型：${String(kind)}`);
  }
}

function expectedExcCodeForKind(kind: P7ProbeScenario['kind']): number | undefined {
  switch (kind) {
    case 'adel':
      return p7ExcCodeAdel;
    case 'ades':
      return p7ExcCodeAdes;
    case 'syscall':
      return p7ExcCodeSyscall;
    case 'ri':
      return p7ExcCodeRi;
    case 'ov':
      return p7ExcCodeOv;
    case 'external':
    case 'timer0':
    case 'timer1':
      return 0;
    case 'internal':
      return undefined;
  }
}

function failure(scenario: P7ProbeScenario, message: string): P7ProbeFailure {
  return {
    scenarioId: scenario.id,
    kind: scenario.kind,
    message
  };
}

function parseHex(value: string): number {
  const normalized = value.replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(normalized)) {
    return Number.NaN;
  }
  const parsed = Number.parseInt(normalized, 16);
  return Number.isSafeInteger(parsed) ? parsed >>> 0 : Number.NaN;
}

function cp0DisplayName(name: string): string {
  switch (name.toLowerCase()) {
    case 'status':
    case 'sr': return 'Status';
    case 'cause': return 'Cause';
    case 'epc': return 'EPC';
    default: return name;
  }
}

function protocolDiagnosticMessage(diagnostic: string): string {
  let explanation: string;
  if (diagnostic.includes('mmio_on_dm')) {
    explanation = 'MMIO 错误写入了 DM';
  } else if (diagnostic.includes('external_raise_unarmed')) {
    explanation = '软件尚未准备外部中断，请求便已触发';
  } else if (diagnostic.includes('invalid_store_effect')) {
    explanation = '无效存储产生了不应有的副作用';
  } else {
    return diagnostic;
  }
  return `${explanation}（${diagnostic}）`;
}
