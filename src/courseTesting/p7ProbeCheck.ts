import { CpuTraceEvent } from '../language/mips/traceParser';
import { P7ProbeExpectedRecord, P7ProbeMetadata, P7ProbeScenario } from './builtinAsmGenerator';
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
}

export function checkP7Probe(
  simOutput: string,
  simEvents: readonly CpuTraceEvent[],
  metadata: P7ProbeMetadata
): P7ProbeCheckResult {
  const records = reconstructProbeRecords(simEvents, metadata);
  const diagnostics = parseProbeDiagnostics(simOutput);
  const failures: P7ProbeFailure[] = [];
  for (const [name, expected] of Object.entries(metadata.initialCp0 ?? {})) {
    const writes = simEvents.filter((event) => parseHex(event.pc) === (expected.pc >>> 0));
    const matches = matchingCommits(simEvents, expected);
    if (writes.length !== 1 || matches.length !== 1) {
      failures.push({
        scenarioId: 0, kind: 'cp0-reset',
        message: `CP0 reset ${name} read-back differs: expected exactly one zero sample at PC 0x${expected.pc.toString(16)}`
      });
    } else if (records.some((record) => record.firstLineNumber <= matches[0].lineNumber)) {
      failures.push({
        scenarioId: 0, kind: 'cp0-reset',
        message: `CP0 reset ${name} sample appeared after an exception record`
      });
    }
  }
  for (const diagnostic of diagnostics) {
    if (diagnostic.includes('mmio_on_dm')
      || diagnostic.includes('external_raise_unarmed')
      || diagnostic.includes('invalid_store_effect')) {
      failures.push({ scenarioId: 0, kind: 'tb', message: diagnostic });
    }
  }
  for (const event of simEvents) {
    if (event.kind === 'dm' && parseHex(event.target) === (p7ProbeEretPoisonAddress >>> 0)) {
      failures.push({
        scenarioId: 0,
        kind: 'eret',
        message: `instruction physically following eret committed DM at poison address 0x${p7ProbeEretPoisonAddress.toString(16)}`
      });
    }
    if (event.kind === 'dm'
      && parseHex(event.target) === (p7ProbeMaskedInterruptMarkerAddress >>> 0)
      && parseHex(event.value) === (p7ProbeMode1FailureMarker >>> 0)) {
      failures.push({
        scenarioId: 0,
        kind: 'timer',
        message: 'Mode-1 timer exposed a stale IRQ before the fresh period was armed'
      });
    }
    if (event.kind === 'dm' && parseHex(event.target) > 0x2fff) {
      failures.push({
        scenarioId: 0,
        kind: 'tb',
        message: `DM trace address exceeds the tutorial range 0x0000..0x2fff: 0x${parseHex(event.target).toString(16)}`
      });
    }
  }

  const expectedRecordCount = metadata.scenarios.length;
  const scenarioIds = new Set(metadata.scenarios.map((scenario) => scenario.id));
  for (const record of records) {
    if (record.scenarioId === 0 || !scenarioIds.has(record.scenarioId)) {
      failures.push({ scenarioId: record.scenarioId, kind: 'record', message: `unexpected probe record scenario id ${record.scenarioId}` });
    }
    if (record.index >= expectedRecordCount) {
      failures.push({ scenarioId: record.scenarioId, kind: 'record', message: `unexpected probe record index ${record.index}` });
    }
    if (record.duplicateFields.length) {
      failures.push({
        scenarioId: record.scenarioId,
        kind: 'record',
        message: `probe record ${record.index} field(s) written more than once: ${record.duplicateFields.join(', ')}`
      });
    }
  }

  let recordIndex = 0;
  for (const scenario of metadata.scenarios) {
    const expectedRecords = expectedRecordsFor(scenario);
    const internalException = scenario.kind === 'internal'
      || expectedRecords.some((expected) => expected.expectedExcCode === undefined || expected.expectedExcCode !== 0);
    const victimPc = scenario.victimPc;
    if (internalException && victimPc !== undefined && Number.isFinite(victimPc)) {
      const victimCommit = findCommitAtPc(simEvents, victimPc);
      if (victimCommit) {
        const commitTarget = victimCommit.kind === 'grf' ? `$${victimCommit.target}` : `*${victimCommit.target}`;
        failures.push(failure(
          scenario,
          `exception victim PC 0x${(victimPc >>> 0).toString(16)} committed ${victimCommit.kind === 'grf' ? 'GPR' : 'DM'} ${commitTarget}`
        ));
      }
    }
    const scenarioRecords = records.filter((item) => item.scenarioId === scenario.id);
    if (scenarioRecords.length !== 1) {
      const label = scenarioRecords.length > 1 ? 'duplicate' : 'missing';
      failures.push(failure(
        scenario,
        `${label} probe records: expected 1, got ${scenarioRecords.length}`
      ));
    }
    let finalRecord: P7ProbeRecord | undefined;
    const currentIndex = recordIndex++;
    const record = records.find((item) => item.index === currentIndex);
    if (!record) {
      failures.push(failure(scenario, `missing probe record at index ${currentIndex}`));
    } else if (record.scenarioId !== scenario.id) {
      failures.push(failure(
        scenario,
        `probe record order differs at index ${currentIndex}: expected scenario id ${scenario.id}, got ${record.scenarioId}`
      ));
    } else {
      finalRecord = record;
      validateExpectedRecord(record, expectedRecords[0], scenario, 0, failures);
      if (expectedRecords.length > 1) {
        const statusSamples = scenario.replayStatusAddress === undefined ? [] : simEvents.filter((event) =>
          event.kind === 'dm' && parseHex(event.target) === (scenario.replayStatusAddress! >>> 0)
          && event.lineNumber > record.firstLineNumber && event.lineNumber < record.lastLineNumber);
        if (scenario.replayStatusAddress !== undefined && statusSamples.length !== 1) {
          failures.push(failure(scenario, `record 2: expected one independently sampled Status, got ${statusSamples.length}`));
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
        failures.push(failure(scenario, `unsupported packed CP0 observation count ${expectedRecords.length}`));
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
        failures.push(failure(scenario, 'external interrupt was not armed by software marker'));
      }
      if (requiresArm && raiseIndex < 0) {
        failures.push(failure(scenario, 'external interrupt was not raised after arm marker'));
      }
      if (ackIndex < 0) {
        failures.push(failure(scenario, `external interrupt was not acknowledged through 0x${p7ExternalInterruptAckAddress.toString(16)}`));
      }
      if (requiresArm && armCount > 1) {
        failures.push(failure(scenario, `external interrupt arm marker appeared ${armCount} times`));
      }
      if (raiseCount > 1) {
        failures.push(failure(scenario, `external interrupt was raised ${raiseCount} times`));
      }
      if (ackCount > 1) {
        failures.push(failure(scenario, `external interrupt was acknowledged ${ackCount} times`));
      }
      if (requiresArm && armIndex >= 0 && raiseIndex >= 0 && armIndex > raiseIndex) {
        failures.push(failure(scenario, 'external interrupt was raised before arm marker'));
      }
      if (raiseIndex >= 0 && ackIndex >= 0 && raiseIndex > ackIndex) {
        failures.push(failure(scenario, 'external interrupt ack appeared before raise'));
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
        failures.push(failure(scenario, `timer CTRL differs after clear: expected 0, got 0x${(record.aux0 >>> 0).toString(16)}`));
      }
      if (record.aux1 !== 0) {
        failures.push(failure(scenario, `timer COUNT differs after clear: expected 0, got 0x${(record.aux1 >>> 0).toString(16)}`));
      }
    }
    if (scenario.requireCompletion) {
      const completionEvents = findCompletionEvents(simEvents, scenario);
      if (completionEvents.length !== 1) {
        failures.push(failure(
          scenario,
          `completion marker differs: expected exactly one $1=${scenario.id} commit at 0x${(scenario.donePc >>> 0).toString(16)}, got ${completionEvents.length}`
        ));
      } else if (finalRecord && completionEvents[0].lineNumber <= finalRecord.lastLineNumber) {
        failures.push(failure(scenario, 'completion marker appeared before the final handler record'));
      }
    }
    const requiredCommits = [...(scenario.requiredPreHandlerCommits ?? []), ...(scenario.requiredCommits ?? [])];
    for (const pc of new Set(requiredCommits.map((commit) => commit.pc >>> 0))) {
      const expectedCount = requiredCommits.filter((commit) => (commit.pc >>> 0) === pc).length;
      const actualCount = simEvents.filter((event) => parseHex(event.pc) === pc).length;
      if (actualCount !== expectedCount) {
        failures.push(failure(scenario,
          `required commit PC 0x${pc.toString(16)}: expected ${expectedCount} total writes, got ${actualCount}`));
      }
    }
    for (const expectedCommit of scenario.requiredPreHandlerCommits ?? []) {
      const commits = matchingCommits(simEvents, expectedCommit);
      if (commits.length !== 1) {
        failures.push(failure(
          scenario,
          `required pre-handler ${expectedCommit.kind.toUpperCase()} commit at 0x${(expectedCommit.pc >>> 0).toString(16)}: expected exactly once, got ${commits.length}`
        ));
      } else if (finalRecord && commits[0].lineNumber >= finalRecord.lastLineNumber) {
        failures.push(failure(scenario, 'required pre-handler commit appeared after the handler record'));
      }
    }
    for (const expectedCommit of scenario.requiredCommits ?? []) {
      const commits = matchingCommits(simEvents, expectedCommit);
      if (commits.length !== 1) {
        failures.push(failure(
          scenario,
          `required ${expectedCommit.kind.toUpperCase()} commit at 0x${(expectedCommit.pc >>> 0).toString(16)}: expected exactly once, got ${commits.length}`
        ));
      } else if (finalRecord && commits[0].lineNumber <= finalRecord.lastLineNumber) {
        failures.push(failure(scenario, 'required retry commit appeared before the handler record'));
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
  const recordLabel = expectedRecordsFor(scenario).length > 1 ? `record ${scenarioRecordIndex + 1}: ` : '';
  if (record.kindCode !== kindCode(scenario.kind)) {
    failures.push(failure(scenario, `${recordLabel}kind code differs: expected ${kindCode(scenario.kind)}, got ${record.kindCode}`));
  }
  // The tutorial requires every unimplemented CP0 bit to remain zero. The probe writes the
  // complete course interrupt mask before each scenario, so Status at handler entry is exact:
  // IM[2:0], EXL, and IE are set and no other bit may leak implementation state.
  if ((record.status >>> 0) !== (p7RequiredExceptionStatusMask >>> 0)) {
    failures.push(failure(
      scenario,
      `${recordLabel}Status differs: expected exactly 0x${p7RequiredExceptionStatusMask.toString(16)}, got 0x${(record.status >>> 0).toString(16)}`
    ));
  }

  const unsupportedCauseBits = (record.cause & ~p7ImplementedCauseMask) >>> 0;
  if (unsupportedCauseBits !== 0) {
    failures.push(failure(
      scenario,
      `${recordLabel}Cause contains nonzero unimplemented bits: 0x${unsupportedCauseBits.toString(16)}`
    ));
  }

  const excCode = (record.cause & p7CauseExcCodeMask) >>> 2;
  const internalException = scenario.kind === 'internal'
    || expected.expectedExcCode === undefined
    || expected.expectedExcCode !== 0;
  if (expected.expectedExcCode !== undefined) {
    if (excCode !== expected.expectedExcCode) {
      failures.push(failure(scenario, `${recordLabel}ExcCode differs: expected ${expected.expectedExcCode}, got ${excCode}`));
    }
  } else if (scenario.kind === 'internal' && excCode === 0) {
    failures.push(failure(scenario, `${recordLabel}internal exception recorded ExcCode 0`));
  }

  const actualIp = record.cause & p7CauseIpMask;
  const expectedIp = expected.expectedIpMask & p7CauseIpMask;
  const allowedIpMasks = expected.allowedIpMasks?.map((value) => value & p7CauseIpMask) ?? [expectedIp];
  if (!allowedIpMasks.includes(actualIp)) {
    failures.push(failure(
      scenario,
      `${recordLabel}${internalException ? 'internal exception recorded unexpected' : 'Cause.IP differs: expected'} Cause.IP ${allowedIpMasks.map((value) => `0x${value.toString(16)}`).join(' or ')}, got 0x${actualIp.toString(16)}`
    ));
  }

  const inDelaySlot = (record.cause & p7CauseBdMask) !== 0;
  const expectedBd = expected.expectedBd ?? (internalException ? false : undefined);
  if (expectedBd !== undefined && inDelaySlot !== expectedBd) {
    failures.push(failure(
      scenario,
      `${recordLabel}Cause.BD differs: expected ${expectedBd ? 1 : 0}, got ${inDelaySlot ? 1 : 0}`
    ));
  } else if (expectedBd === undefined && inDelaySlot
    && !(expected.allowedBdEpc ?? (scenario.waitPc === undefined ? [] : [scenario.waitPc]))
      .includes(record.epc >>> 0)) {
    const allowedBdEpc = expected.allowedBdEpc
      ?? (scenario.waitPc === undefined ? [] : [scenario.waitPc]);
    failures.push(failure(
      scenario,
      `${recordLabel}Cause.BD=1 requires EPC to identify ${allowedBdEpc.length === 1 ? 'the probe wait branch' : 'an allowed wait branch'} at ${allowedBdEpc.length ? allowedBdEpc.map((pc) => `0x${(pc >>> 0).toString(16)}`).join(' or ') : 'an unavailable PC'}`
    ));
  }
  if (expected.allowedEpc.length && !expected.allowedEpc.includes(record.epc >>> 0)) {
    failures.push(failure(
      scenario,
      `${recordLabel}EPC 0x${(record.epc >>> 0).toString(16)} is outside allowed set ${expected.allowedEpc.map((pc) => `0x${(pc >>> 0).toString(16)}`).join(', ')}`
    ));
  }
  const auxPairDescription = expected.auxPairDescription ?? 'HI/LO';
  if (expected.requireEqualAuxPair && record.aux0 !== record.aux1) {
    failures.push(failure(
      scenario,
      `${recordLabel}${auxPairDescription} changed across the exception: before 0x${record.aux0.toString(16)}, after 0x${record.aux1.toString(16)}`
    ));
  }
  if (expected.allowedAuxPairs?.length
    && !expected.allowedAuxPairs.some(([aux0, aux1]) => (aux0 >>> 0) === record.aux0 && (aux1 >>> 0) === record.aux1)) {
    failures.push(failure(
      scenario,
      `${recordLabel}${auxPairDescription} observation differs: got 0x${record.aux0.toString(16)}/0x${record.aux1.toString(16)}`
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
      throw new Error(`unknown P7 probe scenario kind: ${String(kind)}`);
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

function findCommitAtPc(simEvents: readonly CpuTraceEvent[], pc: number): CpuTraceEvent | undefined {
  const expectedPc = pc >>> 0;
  return simEvents.find((event) => {
    const eventPc = parseHex(event.pc);
    return Number.isFinite(eventPc) && eventPc === expectedPc;
  });
}

function parseHex(value: string): number {
  const normalized = value.replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(normalized)) {
    return Number.NaN;
  }
  const parsed = Number.parseInt(normalized, 16);
  return Number.isSafeInteger(parsed) ? parsed >>> 0 : Number.NaN;
}
