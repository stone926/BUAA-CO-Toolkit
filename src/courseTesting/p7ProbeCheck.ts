import { checkRequiredProbeCommits, matchingCommits } from './p7ProbeCommits';
import { matchesP7ObservedWord, p7Cp0ObservationMask, p7StatusObservationMask } from './p7Cp0Observation';
import { CpuTraceEvent, iterCpuTraceEvents } from '../language/mips/traceParser';
import type { ProgramImage } from '../mips/core/api';
import { P7ProbeExpectedRecord, P7ProbeMetadata, P7ProbeScenario } from './builtinAsmGenerator';
import { checkP7ReturnProbe } from './p7ReturnCheck';
import { isP7MaskedExternalVariant } from './builtinAsm/types';
import {
  checkTimerCounter, checkTimerIpSampling, readFirstTimerCapture, timerIpCoverageMarker
} from './p7TimerProbeCheck';
import { expectedProbeRecordPath, ordinaryProbeRecordSources, type P7ProbeRecordSources } from './p7ProbeRecordSources';
import { readP7ProbeCapture } from './p7ProbeCapture';
import { parseProbeHexWord as parseHex, parseProbeRegister } from './p7ProbeTraceWord';
import { p7DataMemoryWords, p7ExceptionHandlerAddress, p7ProbeStateScenarioId } from './p7Hardware';
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
  /** The sampled trace already proves the violation, even if execution ended early. */
  observed?: true;
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
  metadata: P7ProbeMetadata,
  image?: ProgramImage
): P7ProbeCheckResult {
  if (metadata.returnBoundary) {
    // The first execution dirties the CPU state. Only the execution following
    // the clock edge that samples IRQ and reset is compared to a fresh CPU.
    if (metadata.shard === 'reset') {
      const restart = /^CO_P7_RESET_RESTART\r?$/m.exec(simOutput);
      if (!restart) return {
        passed: false, failures: [], records: [], diagnostics: [],
        coverage: [{ covered: false, message: '未覆盖：未在目标宏观 PC 同时施加外部中断与同步复位' }]
      };
      simOutput = simOutput.slice(restart.index + restart[0].length);
      simEvents = [...iterCpuTraceEvents(simOutput)];
    }
    return checkP7ReturnProbe(simOutput, simEvents, metadata,
      activeMetadata => checkProbeRecords(simOutput, simEvents, activeMetadata), image);
  }
  return checkProbeRecords(simOutput, simEvents, metadata, image && ordinaryProbeRecordSources(image, metadata), image);
}

function checkProbeRecords(
  simOutput: string,
  simEvents: readonly CpuTraceEvent[],
  metadata: P7ProbeMetadata,
  sources?: P7ProbeRecordSources,
  image?: ProgramImage
): P7ProbeCheckResult {
  const diagnostics = parseProbeDiagnostics(simOutput);
  const failures: P7ProbeFailure[] = [];
  const { records, replayStatusPcs } = reconstructProbeRecords(simEvents, metadata, failures, sources);
  // Each scenario has several exact commit obligations. Index once instead of rescanning the
  // complete trace for every operand/result/forbidden PC as coverage grows.
  const commitsByPc = new Map<number, CpuTraceEvent[]>();
  const scenarioStarts = new Map<number, number>();
  for (const event of simEvents) {
    const pc = parseHex(event.pc);
    if (!Number.isFinite(pc)) continue;
    if (event.kind === 'dm' && pc < p7ExceptionHandlerAddress && parseHex(event.target) === p7ProbeStateScenarioId) {
      const id = parseHex(event.value);
      if (!scenarioStarts.has(id)) scenarioStarts.set(id, event.lineNumber);
    }
    const commits = commitsByPc.get(pc);
    if (commits) commits.push(event);
    else commitsByPc.set(pc, [event]);
  }
  const atPc = (pc: number): readonly CpuTraceEvent[] => commitsByPc.get(pc >>> 0) ?? [];
  const firstHandlerWrite = simEvents.find(event => parseHex(event.pc) >= p7ExceptionHandlerAddress);
  for (const [name, expected] of Object.entries(metadata.initialCp0 ?? {})) {
    const writes = atPc(expected.pc);
    const sample = writes[0];
    const label = cp0DisplayName(name);
    const pc = expected.pc.toString(16);
    if (!sample || sample.kind !== expected.kind || parseHex(sample.target) !== expected.target) {
      failures.push({
        scenarioId: 0, kind: 'cp0-reset-sample',
        ...(sample ? { observed: true as const } : {}),
        message: `CP0 复位后 ${label} 在 PC 0x${pc} 缺少来自指定 DM 地址的样本`
      });
    } else if (firstHandlerWrite && sample.lineNumber >= firstHandlerWrite.lineNumber) {
      failures.push({
        scenarioId: 0, kind: 'cp0-reset-sample', observed: true,
        message: `CP0 复位后 ${label} 的首个样本出现在异常处理程序开始之后`
      });
    } else if (!matchesP7ObservedWord(parseHex(sample.value), expected.value, p7Cp0ObservationMask(name))) {
      failures.push({
        scenarioId: 0, kind: 'cp0-reset', observed: true,
        message: `CP0 复位后 ${label} 读回值不符合预期：PC 0x${pc} 的受检位应为零，原始值为 0x${sample.value}`
      });
    }
    if (writes.length > 1) {
      failures.push({
        scenarioId: 0, kind: 'cp0-reset-replay', observed: true,
        message: `CP0 ${label} 的启动采样指令 PC 0x${pc} 重复提交：应有 1 次，实际 ${writes.length} 次`
      });
    }
  }
  for (const diagnostic of diagnostics) {
    if (diagnostic.includes('mmio_on_dm')
      || diagnostic.includes('external_raise_unarmed')
      || diagnostic.includes('invalid_store_effect')) {
      failures.push({ scenarioId: 0, kind: 'tb', observed: true, message: protocolDiagnosticMessage(diagnostic) });
    }
    const earlyAck = /^external_ack_early:(\d+)$/.exec(diagnostic);
    if (earlyAck) {
      failures.push({ scenarioId: Number(earlyAck[1]), kind: 'external', observed: true,
        message: '中断发生器在处理程序完成 DM 记录之前已应答' });
    }
  }
  for (const event of simEvents) {
    if (event.kind === 'dm' && parseHex(event.target) === (p7ProbeEretPoisonAddress >>> 0)) {
      failures.push({
        scenarioId: 0,
        kind: 'eret',
        observed: true,
        message: `紧随 eret 的指令向毒值地址 0x${p7ProbeEretPoisonAddress.toString(16)} 提交了 DM 写入`
      });
    }
    if (event.kind === 'dm'
      && parseHex(event.target) === (p7ProbeMaskedInterruptMarkerAddress >>> 0)
      && parseHex(event.value) === (p7ProbeMode1FailureMarker >>> 0)) {
      failures.push({
        scenarioId: 0,
        kind: 'timer',
        observed: true,
        message: '模式 1 定时器在准备等待第二次中断前记录了意外中断或状态错误'
      });
    }
    if (event.kind === 'dm' && parseHex(event.target) >= p7DataMemoryWords * 4) {
      failures.push({
        scenarioId: 0,
        kind: 'tb',
        observed: true,
        message: `DM 轨迹地址超出课程规定范围 0x0000..0x2fff：0x${parseHex(event.target).toString(16)}`
      });
    }
  }

  const scenarioIds = new Set(metadata.scenarios.map((scenario) => scenario.id));
  for (const [position, record] of records.entries()) {
    if (record.scenarioId === 0 || !scenarioIds.has(record.scenarioId)) {
      failures.push({ scenarioId: record.scenarioId, kind: 'record', observed: true,
        message: `探针记录中的场景编号 ${record.scenarioId} 不在预期范围内` });
    }
    if (position > 0 && record.firstLineNumber <= records[position - 1].lastLineNumber) {
      failures.push({ scenarioId: record.scenarioId, kind: 'record', observed: true,
        message: `探针记录 ${record.index} 与前一条记录交错或提前写入` });
    }
  }

  const recordsByIndex = new Map(records.map(record => [record.index, record]));
  let timerCoverage: P7ProbeCheckResult['coverage'];
  const ackTimes = new Map<number, number>();
  for (const match of simOutput.matchAll(/^CO_P7_PROBE external_ack scenario=(\d+) time=(\d+)\r?$/gm)) {
    const id = Number(match[1]);
    if (!ackTimes.has(id)) ackTimes.set(id, Number(match[2]));
  }
  for (const [recordIndex, scenario] of metadata.scenarios.entries()) {
    for (const pc of scenario.forbiddenCommitPcs ?? []) {
      if (atPc(pc).length) {
        failures.push(failure(scenario, `禁止提交的后续指令/错误路径 PC 0x${(pc >>> 0).toString(16)} 已提交`, true));
      }
    }
    const expectedRecords = expectedRecordsFor(scenario);
    const record = recordsByIndex.get(recordIndex);
    const finalRecord = record?.scenarioId === scenario.id ? record : undefined;
    // The first-IRQ handler uses the same store PCs in every scenario. A truncated
    // run may never reach this scenario or its predecessor's record.
    const captureStart = scenarioStarts.get(scenario.id) ?? recordsByIndex.get(recordIndex - 1)?.lastLineNumber
      ?? (recordIndex === 0 ? 0 : undefined);
    const next = metadata.scenarios[recordIndex + 1];
    const captureEnd = (next && scenarioStarts.get(next.id)) ?? Infinity;
    if (scenario.timerObservation) {
      const report = (message: string, observed?: true) => failures.push(failure(scenario, message, observed));
      const marker = timerIpCoverageMarker(scenario, atPc);
      checkTimerCounter(scenario, atPc, finalRecord?.firstLineNumber ?? marker?.lineNumber ?? Infinity, report);
      checkTimerIpSampling(scenario, atPc, marker, report);
      const firstReadPc = scenario.requiredPreHandlerCommits?.[0]?.pc;
      const firstRead = firstReadPc === undefined ? undefined : atPc(firstReadPc)[0];
      const captured = readFirstTimerCapture(scenario, atPc, captureStart,
        Math.min(firstRead?.lineNumber ?? finalRecord?.firstLineNumber ?? marker?.lineNumber ?? Infinity, captureEnd), report);
      if (captured && finalRecord
        && (captured.status !== finalRecord.status || captured.cause !== finalRecord.cause || captured.epc !== finalRecord.epc)) {
        report('模式 1 定时器的首次中断样本与打包记录不一致', true);
      } else if (captured && !finalRecord) {
        validateExpectedRecord({
          ...captured, index: recordIndex, scenarioId: scenario.id, kindCode: kindCode(scenario.kind),
          aux0: 0, aux1: 0, firstLineNumber: 0, lastLineNumber: 0, duplicateFields: []
        }, expectedRecords[0], scenario, 0, failures);
      }
      if (marker) {
        const markerPc = parseHex(marker.pc);
        if (records.some(item => item.index >= recordIndex)
          || simEvents.some(event => event.lineNumber > marker.lineNumber && parseHex(event.pc) >= markerPc)) {
          report('模式 1 定时器未观测标记之后出现了不应执行的提交', true);
        }
        timerCoverage = [{ covered: false, message: `P7 定时器场景 ${scenario.id} 未覆盖：轮询未采样到首次中断之后的 Cause.IP 去断言` }];
        break;
      }
    }
    const internalException = scenario.kind === 'internal'
      || expectedRecords.some((expected) => expected.expectedExcCode === undefined || expected.expectedExcCode !== 0);
    const victimPc = scenario.victimPc;
    if (internalException && victimPc !== undefined && Number.isFinite(victimPc)) {
      const victimCommit = atPc(victimPc)[0];
      if (victimCommit) {
        const commitTarget = victimCommit.kind === 'grf' ? `$${victimCommit.target}` : `*${victimCommit.target}`;
        failures.push(failure(
          scenario,
          `触发异常的指令 PC 0x${(victimPc >>> 0).toString(16)} 不应提交，但已写入 ${victimCommit.kind === 'grf' ? 'GPR' : 'DM'} ${commitTarget}`,
          true
        ));
      }
    }
    const scenarioRecords = records.filter((item) => item.scenarioId === scenario.id);
    if (scenarioRecords.length !== 1) {
      const label = scenarioRecords.length > 1 ? 'duplicate' : 'missing';
      failures.push(failure(
        scenario,
        `探针记录${label === 'duplicate' ? '重复' : '缺失'}：应有 1 条，实际 ${scenarioRecords.length} 条`,
        scenarioRecords.length > 1 ? true : undefined
      ));
    }
    if (!record) {
      failures.push(failure(scenario, `缺少索引为 ${recordIndex} 的探针记录`));
    } else if (record.scenarioId !== scenario.id) {
      failures.push(failure(
        scenario,
        `探针记录顺序错误：索引 ${recordIndex} 应为场景 ${scenario.id}，实际为 ${record.scenarioId}`, true
      ));
    } else {
      validateExpectedRecord(record, expectedRecords[0], scenario, 0, failures);
      if (expectedRecords.length > 1) {
        const statusSamples = scenario.replayStatusAddress === undefined ? [] : simEvents.filter((event) =>
          event.kind === 'dm' && parseHex(event.target) === (scenario.replayStatusAddress! >>> 0)
          && event.lineNumber > record.firstLineNumber && event.lineNumber < record.lastLineNumber);
        if (scenario.replayStatusAddress !== undefined && statusSamples.length !== 1) {
          failures.push(failure(scenario, `记录 2：应独立采样一次 Status，实际 ${statusSamples.length} 次`, true));
        } else if (sources && statusSamples.length === 1
          && parseHex(statusSamples[0].pc) !== replayStatusPcs.get(record.index)) {
          failures.push(failure(scenario, '记录 2：Status 样本来自错误的异常处理程序存储指令', true));
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
        validateExpectedRecord(replayRecord, expectedRecords[1], scenario, 1, failures,
          scenario.replayStatusAddress === undefined || statusSamples.length === 1);
      }
      if (expectedRecords.length > 2) {
        failures.push(failure(scenario, `不支持打包 ${expectedRecords.length} 组 CP0 观测值`));
      }
    }
    const completionWrites = scenario.requireCompletion ? atPc(scenario.donePc) : [];
    const completionEvents = findCompletionEvents(completionWrites, scenario);
    if (sources && expectedProbeRecordPath(scenario) === 'priority') {
      const stageEnd = Math.min(finalRecord?.firstLineNumber ?? completionEvents[0]?.lineNumber ?? Infinity, captureEnd);
      const { capture, invalid } = readP7ProbeCapture(atPc, sources.priorityCapture, captureStart, stageEnd);
      if (!capture) {
        failures.push(failure(scenario, '优先级探针应在重试前依次写入首次中断的 Status、Cause 和 EPC',
          invalid ? true : undefined));
      } else if (finalRecord
        && (capture.status !== finalRecord.status || capture.cause !== finalRecord.cause || capture.epc !== finalRecord.epc)) {
        failures.push(failure(scenario, '优先级探针的首次中断样本与打包记录不一致', true));
      } else if (!finalRecord) {
        validateExpectedRecord({
          ...capture, index: recordIndex, scenarioId: scenario.id, kindCode: kindCode(scenario.kind),
          aux0: 0, aux1: 0, firstLineNumber: 0, lastLineNumber: 0, duplicateFields: []
        }, expectedRecords[0], scenario, 0, failures);
      }
    }
    if (scenario.kind === 'external') {
      const armIndex = diagnostics.indexOf(`external_arm:${scenario.id}`);
      const raiseIndex = diagnostics.indexOf(`external_raise:${scenario.id}`);
      const ackIndex = diagnostics.indexOf(`external_ack:${scenario.id}`);
      const armCount = diagnostics.filter((item) => item === `external_arm:${scenario.id}`).length;
      const raiseCount = diagnostics.filter((item) => item === `external_raise:${scenario.id}`).length;
      const ackCount = diagnostics.filter((item) => item === `external_ack:${scenario.id}`).length;
      const masked = isP7MaskedExternalVariant(scenario.variant);
      // Return and masked windows use a unique trigger PC, including archived
      // images whose metadata still describes the preceding setup store.
      const requiresArm = !metadata.returnBoundary && !masked
        && Number.isFinite(scenario.armAddress) && Number.isFinite(scenario.armValue);
      if (masked) {
        const marker = scenario.requiredPreHandlerCommits?.find(commit =>
          commit.kind === 'dm' && commit.target === p7ProbeMaskedInterruptMarkerAddress);
        const ackTime = ackTimes.get(scenario.id);
        if (marker && ackTime !== undefined) {
          const sample = matchingCommits(atPc(marker.pc), marker)[0];
          if (!sample || (sample.cycle !== undefined && sample.cycle >= ackTime)) {
            failures.push(failure(scenario, '屏蔽外部中断时，中断发生器在软件启用前已应答', true));
          }
        }
      }
      if (requiresArm && armIndex < 0) {
        failures.push(failure(scenario, '软件标记未能启动外部中断'));
      }
      if ((requiresArm || masked) && raiseIndex < 0) {
        failures.push(failure(scenario, requiresArm ? '启动标记之后未发出外部中断请求' : '未在指定宏观 PC 发出外部中断请求'));
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
    if (finalRecord && (scenario.kind === 'timer0' || scenario.kind === 'timer1')
      && expectedRecords.length === 1
      && !expectedRecords[0].allowedAuxPairs?.length
      && !expectedRecords[0].requireEqualAuxPair) {
      if (finalRecord.aux0 !== 0) {
        failures.push(failure(scenario, `计时器清除后的 CTRL 不符：应为 0，实际为 0x${finalRecord.aux0.toString(16)}`, true));
      }
      if (finalRecord.aux1 !== 0) {
        failures.push(failure(scenario, `计时器清除后的 COUNT 不符：应为 0，实际为 0x${finalRecord.aux1.toString(16)}`, true));
      }
    }
    if (scenario.requireCompletion) {
      if (completionWrites.length !== 1 || completionEvents.length !== 1) {
        failures.push(failure(
          scenario,
          `完成标记不符：应在 0x${(scenario.donePc >>> 0).toString(16)} 恰好提交一次 $1=${scenario.id}，实际 ${completionWrites.length} 次写入，其中 ${completionEvents.length} 次符合`,
          completionWrites.length ? true : undefined
        ));
      } else if (!finalRecord) {
        failures.push(failure(scenario, '已提交完成标记，但缺少该场景的异常处理程序记录', true));
      } else if (completionEvents[0].lineNumber <= finalRecord.lastLineNumber) {
        failures.push(failure(scenario, '完成标记出现在最后一条异常处理程序记录之前', true));
      }
    }
    checkRequiredProbeCommits(scenario, atPc, finalRecord,
      (message, observed) => failures.push(failure(scenario, message, observed)), image);
  }

  return {
    passed: failures.length === 0 && !timerCoverage,
    records,
    failures,
    diagnostics,
    ...(timerCoverage ? { coverage: timerCoverage } : {})
  };
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
  failures: P7ProbeFailure[],
  statusObserved = true
): void {
  const recordLabel = expectedRecordsFor(scenario).length > 1 ? `记录 ${scenarioRecordIndex + 1}：` : '';
  const reject = (message: string) => failures.push(failure(scenario, `${recordLabel}${message}`, true));
  if (record.kindCode !== kindCode(scenario.kind)) {
    reject(`场景类型编码不符：应为 ${kindCode(scenario.kind)}，实际为 ${record.kindCode}`);
  }
  // Entry sets EXL while retaining the scenario's IM and IE. Older probes used one fixed SR.
  const expectedStatus = expected.statusBeforeException === undefined
    ? p7RequiredExceptionStatusMask
    : (expected.statusBeforeException | p7StatusExlMask) >>> 0;
  if (!matchesP7ObservedWord(record.status, expectedStatus, p7StatusObservationMask)) {
    const actual = Number.isFinite(record.status) ? `0x${record.status.toString(16)}` : '含未知位';
    failures.push(failure(
      scenario,
      `${recordLabel}SR/Status 不符：IM、EXL、IE 应为 0x${(expectedStatus & p7StatusObservationMask).toString(16)}，原始值为 ${actual}`,
      statusObserved ? true : undefined
    ));
  }

  const excCode = (record.cause & p7CauseExcCodeMask) >>> 2;
  const internalException = scenario.kind === 'internal'
    || expected.expectedExcCode === undefined
    || expected.expectedExcCode !== 0;
  if (expected.expectedExcCode !== undefined) {
    if (excCode !== expected.expectedExcCode) {
      reject(`Cause.ExcCode 不符：应为 ${expected.expectedExcCode}，实际为 ${excCode}`);
    }
  } else if (scenario.kind === 'internal' && excCode === 0) {
    reject('内部异常记录的 Cause.ExcCode 为 0');
  }

  const actualIp = record.cause & p7CauseIpMask;
  const expectedIp = expected.expectedIpMask & p7CauseIpMask;
  const allowedIpMasks = expected.allowedIpMasks?.map((value) => value & p7CauseIpMask) ?? [expectedIp];
  if (!allowedIpMasks.includes(actualIp)) {
    reject(`Cause.IP 不符：允许 ${allowedIpMasks.map((value) => `0x${value.toString(16)}`).join(' 或 ')}，实际为 0x${actualIp.toString(16)}`);
  }

  const inDelaySlot = (record.cause & p7CauseBdMask) !== 0;
  const expectedBd = expected.expectedBd ?? (internalException ? false : undefined);
  if (expectedBd !== undefined && inDelaySlot !== expectedBd) {
    reject(`Cause.BD 不符：应为 ${expectedBd ? 1 : 0}，实际为 ${inDelaySlot ? 1 : 0}`);
  } else if (expectedBd === undefined && inDelaySlot
    && !(expected.allowedBdEpc ?? (scenario.waitPc === undefined ? [] : [scenario.waitPc]))
      .includes(record.epc >>> 0)) {
    const allowedBdEpc = expected.allowedBdEpc
      ?? (scenario.waitPc === undefined ? [] : [scenario.waitPc]);
    reject(`Cause.BD=1 时，EPC 必须指向${allowedBdEpc.length === 1 ? '探针等待分支' : '允许的等待分支'}：${allowedBdEpc.length ? allowedBdEpc.map((pc) => `0x${(pc >>> 0).toString(16)}`).join(' 或 ') : '无可用 PC'}`);
  }
  if (expected.allowedEpc.length && !expected.allowedEpc.includes(record.epc >>> 0)) {
    reject(`EPC 0x${(record.epc >>> 0).toString(16)} 不在允许范围内（${expected.allowedEpc.map((pc) => `0x${(pc >>> 0).toString(16)}`).join(', ')}）`);
  }
  const auxPairDescription = expected.auxPairDescription ?? 'HI/LO';
  if (expected.requireEqualAuxPair && record.aux0 !== record.aux1) {
    reject(`${auxPairDescription} 在异常前后发生变化：之前为 0x${record.aux0.toString(16)}，之后为 0x${record.aux1.toString(16)}`);
  }
  if (expected.allowedAuxPairs?.length
    && !expected.allowedAuxPairs.some(([aux0, aux1]) => (aux0 >>> 0) === record.aux0 && (aux1 >>> 0) === record.aux1)) {
    reject(`${auxPairDescription} 观测值不符：实际为 0x${record.aux0.toString(16)}/0x${record.aux1.toString(16)}`);
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
  metadata: P7ProbeMetadata,
  failures: P7ProbeFailure[],
  sources?: P7ProbeRecordSources
): { records: P7ProbeRecord[]; replayStatusPcs: ReadonlyMap<number, number> } {
  const fields = new Map<number, { events: CpuTraceEvent[]; counts: number[] }>();
  const replayStatusPcs = new Map<number, number>();
  const mainStoreTargets = new Map<number, Set<number>>();
  for (const scenario of metadata.scenarios) {
    for (const commit of [...(scenario.requiredPreHandlerCommits ?? []), ...(scenario.requiredCommits ?? [])]) {
      if (commit.kind !== 'dm' || commit.pc >= p7ExceptionHandlerAddress || commit.target < metadata.logBase) continue;
      const targets = mainStoreTargets.get(commit.pc) ?? new Set<number>();
      targets.add(commit.target);
      mainStoreTargets.set(commit.pc, targets);
    }
  }
  for (const event of simEvents) {
    if (event.kind !== 'dm') continue;
    const address = parseHex(event.target);
    if (!Number.isFinite(address) || address < metadata.logBase || address >= p7DataMemoryWords * 4) {
      if (sources?.fields.has(parseHex(event.pc))) {
        failures.push({ scenarioId: 0, kind: 'record', observed: true,
          message: `探针记录存储指令 PC 0x${event.pc} 写到了记录区之外：0x${event.target}` });
      }
      continue;
    }
    // Directed boundary cases also use the last DM word as a main-program witness.
    // Its declared commit PC and address distinguish it from a stray record write.
    if (mainStoreTargets.get(parseHex(event.pc))?.has(address)) continue;
    const offset = address - metadata.logBase;
    if (offset % 4 !== 0) {
      failures.push({ scenarioId: 0, kind: 'record', observed: true, message: `探针记录地址未按字对齐：0x${event.target}` });
      continue;
    }
    const wordOffset = offset / 4;
    const recordIndex = Math.floor(wordOffset / metadata.recordWords);
    const fieldIndex = wordOffset % metadata.recordWords;
    const record = fields.get(recordIndex) ?? { events: [], counts: [] };
    record.events[fieldIndex] ??= event;
    record.counts[fieldIndex] = (record.counts[fieldIndex] ?? 0) + 1;
    fields.set(recordIndex, record);
  }

  const records: P7ProbeRecord[] = [];
  for (const [index, fieldState] of [...fields.entries()].sort((a, b) => a[0] - b[0])) {
    const { events, counts } = fieldState;
    const scenario = metadata.scenarios[index];
    const recordFailure = (message: string, observed: boolean = true) => failures.push({
      scenarioId: scenario?.id ?? 0, kind: 'record', message, ...(observed ? { observed: true as const } : {})
    });
    const values = Array.from({ length: metadata.recordWords }, (_, field) => parseHex(events[field]?.value ?? ''));
    const duplicateFields = counts.flatMap((count, field) => count > 1 ? [field] : []);
    if (duplicateFields.length) {
      recordFailure(`探针记录 ${index} 的字段被重复写入：${duplicateFields.join(', ')}`);
    }
    if (!scenario) {
      recordFailure(`探针记录索引 ${index} 不在预期范围内，且存在 DM 写入`);
    }
    if (values.some(value => !Number.isFinite(value))) {
      recordFailure(`探针记录 ${index} 包含缺失或含未知位的字段`,
        events.some(event => !Number.isFinite(parseHex(event.value))));
      continue;
    }
    if (values[0] !== p7ProbeMagic) {
      recordFailure(`探针记录 ${index} 的魔数不符`);
      continue;
    }
    if (events.some((event, field) => field > 0 && event.lineNumber <= events[field - 1].lineNumber)) {
      recordFailure(`探针记录 ${index} 的字段写入顺序错误`);
    }
    if (sources) {
      const block = parseHex(events[0].pc);
      const path = sources.paths.get(block);
      if (scenario && path !== undefined && path !== expectedProbeRecordPath(scenario)) {
        recordFailure(`探针记录 ${index} 来自错误的异常处理程序路径`);
      }
      for (const [field, event] of events.entries()) {
        const store = sources.fields.get(parseHex(event.pc));
        if (store?.block !== block || store.field !== field
          || (field === 7 && store.aux0 !== parseHex(events[6].pc))) {
          recordFailure(`探针记录 ${index} 的字段 ${field} 来自错误的存储指令 PC 0x${event.pc}`);
        }
      }
      const expectedAuxiliary = scenario && sources.expectedAuxiliary.get(scenario.id);
      if (expectedAuxiliary !== undefined
        && sources.fields.get(parseHex(events[7].pc))?.auxiliarySource !== expectedAuxiliary) {
        recordFailure(`探针记录 ${index} 的辅助字段来自错误的异常处理程序观测分支`);
      }
      const replayStatusPc = sources.replayStatus.get(block);
      if (replayStatusPc !== undefined) replayStatusPcs.set(index, replayStatusPc);
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
      firstLineNumber: Math.min(...events.map(event => event.lineNumber)),
      lastLineNumber: Math.max(...events.map(event => event.lineNumber)),
      duplicateFields
    });
  }
  return { records, replayStatusPcs };
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
    const earlyAck = /^CO_P7_PROBE external_ack_early scenario=(\d+) time=\d+\r?$/.exec(line);
    if (earlyAck) diagnostics.push(`external_ack_early:${earlyAck[1]}`);
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
    if (/CO_P7_PROBE\s+invalid_store_effect\s+source=return_poison\b/.test(line)) {
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

function failure(scenario: P7ProbeScenario, message: string, observed?: true): P7ProbeFailure {
  return {
    scenarioId: scenario.id,
    kind: scenario.kind,
    message,
    ...(observed ? { observed } : {})
  };
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
