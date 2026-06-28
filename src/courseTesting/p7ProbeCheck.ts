import { CpuTraceEvent } from '../language/mips/traceParser';
import { P7ProbeMetadata, P7ProbeScenario } from './builtinAsmGenerator';
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
  p7ExternalInterruptAckAddress,
  p7ProbeMagic
} from './builtinAsm/p7/constants';

export interface P7ProbeRecord {
  index: number;
  scenarioId: number;
  kindCode: number;
  status: number;
  cause: number;
  epc: number;
  aux0: number;
  aux1: number;
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
  for (const diagnostic of diagnostics) {
    if (diagnostic.includes('mmio_on_dm') || diagnostic.includes('external_raise_unarmed')) {
      failures.push({ scenarioId: 0, kind: 'tb', message: diagnostic });
    }
  }

  const scenarioIds = new Set(metadata.scenarios.map((scenario) => scenario.id));
  for (const record of records) {
    if (record.scenarioId === 0 || !scenarioIds.has(record.scenarioId)) {
      failures.push({ scenarioId: record.scenarioId, kind: 'record', message: `unexpected probe record scenario id ${record.scenarioId}` });
    }
  }

  for (const scenario of metadata.scenarios) {
    const scenarioRecords = records.filter((item) => item.scenarioId === scenario.id);
    const record = scenarioRecords[0];
    if (!record) {
      failures.push(failure(scenario, 'missing probe record'));
      continue;
    }
    if (scenarioRecords.length > 1) {
      failures.push(failure(scenario, `duplicate probe records: ${scenarioRecords.length}`));
    }
    if (record.kindCode !== kindCode(scenario.kind)) {
      failures.push(failure(scenario, `kind code differs: expected ${kindCode(scenario.kind)}, got ${record.kindCode}`));
    }
    const excCode = (record.cause & p7CauseExcCodeMask) >>> 2;
    const expectedExcCode = scenario.expectedExcCode ?? expectedExcCodeForKind(scenario.kind);
    if (expectedExcCode !== undefined && expectedExcCode !== 0) {
      if (excCode !== expectedExcCode) {
        failures.push(failure(scenario, `ExcCode differs: expected ${expectedExcCode}, got ${excCode}`));
      }
    } else if (scenario.kind === 'internal') {
      if (excCode === 0) {
        failures.push(failure(scenario, 'internal exception recorded ExcCode 0'));
      }
    } else {
      if (excCode !== 0) {
        failures.push(failure(scenario, `interrupt recorded nonzero ExcCode ${excCode}`));
      }
      if ((record.cause & scenario.expectedIpMask) === 0) {
        failures.push(failure(scenario, `Cause.IP missing expected mask 0x${scenario.expectedIpMask.toString(16)}`));
      }
    }
    if (scenario.allowedEpc.length && !scenario.allowedEpc.includes(record.epc >>> 0)) {
      failures.push(failure(scenario, `EPC 0x${(record.epc >>> 0).toString(16)} is outside allowed set ${scenario.allowedEpc.map((pc) => `0x${(pc >>> 0).toString(16)}`).join(', ')}`));
    }
    if (scenario.kind === 'external') {
      const armIndex = diagnostics.indexOf(`external_arm:${scenario.id}`);
      const raiseIndex = diagnostics.indexOf(`external_raise:${scenario.id}`);
      const ackIndex = diagnostics.indexOf(`external_ack:${scenario.id}`);
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
      if (requiresArm && armIndex >= 0 && raiseIndex >= 0 && armIndex > raiseIndex) {
        failures.push(failure(scenario, 'external interrupt was raised before arm marker'));
      }
      if (raiseIndex >= 0 && ackIndex >= 0 && raiseIndex > ackIndex) {
        failures.push(failure(scenario, 'external interrupt ack appeared before raise'));
      }
    }
    if ((scenario.kind === 'timer0' || scenario.kind === 'timer1') && (record.aux0 & 1) !== 0) {
      failures.push(failure(scenario, `timer CTRL was not cleared, aux0=0x${(record.aux0 >>> 0).toString(16)}`));
    }
  }

  return {
    passed: failures.length === 0,
    records,
    failures,
    diagnostics
  };
}

function reconstructProbeRecords(
  simEvents: readonly CpuTraceEvent[],
  metadata: P7ProbeMetadata
): P7ProbeRecord[] {
  const fields = new Map<number, number[]>();
  const maxUsefulRecords = Math.min(Math.max(metadata.scenarios.length + 8, metadata.scenarios.length * 2, 1), 64);
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
    const record = fields.get(recordIndex) ?? [];
    record[fieldIndex] = parseHex(event.value);
    fields.set(recordIndex, record);
  }

  const records: P7ProbeRecord[] = [];
  for (const [index, values] of [...fields.entries()].sort((a, b) => a[0] - b[0])) {
    if (values.length < metadata.recordWords || values.some((value) => !Number.isFinite(value))) {
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
      aux1: values[7] >>> 0
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

function parseHex(value: string): number {
  const normalized = value.replace(/^0x/i, '');
  return Number.parseInt(normalized, 16) >>> 0;
}
