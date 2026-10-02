// @index course-testing — 首失败定位证据的有界持久化与不可信历史解码
import type { CourseTraceCaseResult } from '../courseTestReport';
import type { TraceEventSnapshot } from '../language/mips/traceCompare';

/** Only navigation facts belong here; the existing diagnostic owns the explanation. */
export interface FailureEvidence {
  version: 1;
  index?: number;
  oracle?: TraceEventSnapshot;
  dut?: TraceEventSnapshot;
  pc?: number;
  scenarioId?: number;
}

const maximumEvidenceLength = 2048;
const hexWord = /^(?:0x)?[\da-fxz]{1,8}$/i;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function evidencePc(value: string | undefined): number | undefined {
  if (!value || !/^(?:0x)?[\da-f]{1,8}$/i.test(value)) return undefined;
  const pc = Number.parseInt(value.replace(/^0x/i, ''), 16);
  return pc % 4 === 0 ? pc : undefined;
}

export function serializeFailureEvidence(result: CourseTraceCaseResult): string | undefined {
  if (result.cancelled || result.status === 'passed') return undefined;
  const diff = result.firstDiff;
  const pc = /^DM 写事务 #\d+ \(PC=0x([\da-f]{8})\)/i.exec(diff?.reason ?? '')?.[1];
  const evidence = sanitizeEvidence({
    version: 1,
    index: diff?.index,
    oracle: diff?.oracle ?? diff?.mars,
    dut: diff?.dut ?? diff?.sim,
    pc: evidencePc(pc),
    scenarioId: result.probe?.failures[0]?.scenarioId
  });
  return evidence ? JSON.stringify(evidence) : undefined;
}

export function parseFailureEvidence(text: string | undefined): FailureEvidence | undefined {
  if (!text || text.length > maximumEvidenceLength) return undefined;
  try { return sanitizeEvidence(JSON.parse(text)); } catch { return undefined; }
}

function sanitizeEvidence(value: unknown): FailureEvidence | undefined {
  if (!record(value) || value.version !== 1) return undefined;
  const oracle = event(value.oracle);
  const dut = event(value.dut);
  const pc = integer(value.pc) && value.pc <= 0xffffffff && value.pc % 4 === 0 ? value.pc : undefined;
  const scenarioId = integer(value.scenarioId) ? value.scenarioId : undefined;
  if (!oracle && !dut && pc === undefined && scenarioId === undefined) return undefined;
  return {
    version: 1,
    ...(integer(value.index) ? { index: value.index } : {}),
    ...(oracle ? { oracle } : {}), ...(dut ? { dut } : {}),
    ...(pc === undefined ? {} : { pc }), ...(scenarioId === undefined ? {} : { scenarioId })
  };
}

function event(value: unknown): TraceEventSnapshot | undefined {
  if (!record(value) || typeof value.pc !== 'string' || !hexWord.test(value.pc)
    || typeof value.value !== 'string' || !hexWord.test(value.value)
    || typeof value.target !== 'string' || !hexWord.test(value.target)
    || (value.kind !== 'grf' && value.kind !== 'dm')
    || !integer(value.lineNumber) || value.lineNumber < 1) return undefined;
  return {
    pc: value.pc, value: value.value, target: value.target, kind: value.kind,
    lineNumber: value.lineNumber, raw: '',
    ...(integer(value.cycle) ? { cycle: value.cycle } : {})
  };
}
