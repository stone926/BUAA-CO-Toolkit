// @index hazard-report-validation — 导入报告结构与资源边界校验，不执行报告携带的路径或内容
import type { HazardReport } from '../hazardAnalysis/reportTypes';
import { courseHazardClasses } from '../hazardAnalysis/courseHazardTheory';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const range = (value: unknown, max: number): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
const nullableRange = (value: unknown, max: number): boolean => value === null || range(value, max);
const member = (value: unknown, choices: readonly string[]): boolean => typeof value === 'string' && choices.includes(value);
const list = (value: unknown, max: number, check: (item: unknown) => boolean): boolean => Array.isArray(value) && value.length <= max && value.every(check);

export function isHazardReport(value: unknown): value is HazardReport {
  if (!record(value) || value.version !== 1 || !member(value.profile, ['P5', 'P6', 'P7'])
    || value.model !== (value.profile === 'P5' ? 'P5' : 'P6') || !text(value.imageFingerprint)
    || !record(value.summary) || !count(value.omittedEvents) || !range(value.stopPc, 0xffffffff)
    || !Number.isInteger(value.stopPc)
    || !member(value.stopReason, ['course-halt-loop', 'program-end', 'step-limit', 'out-of-domain', 'cancelled', 'engine-error'])) return false;
  const summary = value.summary;
  if (!['instructions', 'cycles', 'dataStallCycles', 'multiplyDivideStallCycles', 'forwardEvents',
    'validForwardEvents', 'forwardCovered', 'forwardExpected', 'stallCovered', 'stallExpected'].every((key) => count(summary[key]))
    || !['forwardCoverage', 'stallCoverage'].every((key) => range(summary[key], 1))
    || !nullableRange(summary.forwardValidRate, 1)
    || !['forwardGrade', 'stallGrade'].every((key) => nullableRange(summary[key], 100))) return false;
  return (value.detailed === undefined || detailedStats(value.detailed))
    && (value.execution === undefined || executionContext(value.execution))
    && list(value.classCoverage, 200, classRow)
    && list(value.events, 10000, eventRow)
    && list(value.forwardTuples, 20000, text) && list(value.stallTuples, 20000, text)
    && list(value.warnings, 100, text);
}

function classRow(value: unknown): boolean {
  return record(value) && text(value.pair)
    && member(value.consumerClass, courseHazardClasses) && member(value.producerClass, courseHazardClasses)
    && ['forwardCovered', 'forwardExpected', 'stallCovered', 'stallExpected'].every((key) => count(value[key]))
    && nullableRange(value.forwardGrade, 100) && nullableRange(value.stallGrade, 100);
}

function eventRow(value: unknown): boolean {
  if (!record(value) || !member(value.kind, ['forward', 'stall', 'zero', 'priority', 'hilo'])
    || !text(value.consumer) || !count(value.consumerOrder) || !count(value.cycle) || !range(value.consumerPc, 0xffffffff)
    || !Number.isInteger(value.consumerPc)) return false;
  return ['producer', 'register', 'olderProducer', 'newerProducer'].every((key) => value[key] === undefined || text(value[key]))
    && (value.producerOrder === undefined || count(value.producerOrder))
    && (value.producerPc === undefined || (range(value.producerPc, 0xffffffff) && Number.isInteger(value.producerPc)))
    && (value.interval === undefined || count(value.interval))
    && (value.valid === undefined || typeof value.valid === 'boolean')
    && (value.observability === undefined || member(value.observability, ['observable', 'masked', 'unknown']))
    && ['gap', 'olderGap', 'newerGap'].every((key) => value[key] === undefined || count(value[key]))
    && (value.role === undefined || member(value.role, ['rs', 'rt']))
    && ['sourceStage', 'destinationStage'].every((key) => value[key] === undefined || member(value[key], ['D', 'E', 'M', 'W']));
}

const detailKeys = (value: unknown): value is string[] => list(value, 2048,
  (key) => typeof key === 'string' && key.length > 0 && key.length <= 160)
  && new Set(value as string[]).size === (value as string[]).length;

function detailGroup(value: unknown): boolean {
  if (!record(value) || !count(value.events) || !count(value.validEvents) || value.validEvents > value.events
    || !detailKeys(value.keys) || !detailKeys(value.validKeys)
    || value.keys.length > value.events || value.validKeys.length > value.validEvents
    || typeof value.keysTruncated !== 'boolean' || typeof value.validKeysTruncated !== 'boolean'
    || !record(value.observability)) return false;
  const sensitivity = value.observability;
  if (!count(sensitivity.observable) || !count(sensitivity.masked) || !count(sensitivity.unknown)
    || sensitivity.observable + sensitivity.masked + sensitivity.unknown !== value.events) return false;
  return value.keysTruncated || value.validKeys.every((key) => (value.keys as string[]).includes(key));
}

function detailedStats(value: unknown): boolean {
  if (!record(value) || value.schemaVersion !== 1
    || !['forward', 'zero', 'priority', 'hiLo'].every((key) => detailGroup(value[key]))) return false;
  const causes = value.stallCauses;
  return record(causes) && count(causes.events) && detailKeys(causes.keys)
    && causes.keys.length <= causes.events && typeof causes.keysTruncated === 'boolean';
}

function executionContext(value: unknown): boolean {
  return record(value) && member(value.source, ['standalone', 'case'])
    && (value.caseId === undefined || (text(value.caseId) && value.caseId.length > 0 && value.caseId.length <= 128))
    && list(value.externalInterrupts, 4096, (entry) => record(entry)
      && count(entry.victimPc) && entry.victimPc <= 0xffffffff && entry.victimPc % 4 === 0
      && count(entry.occurrence) && entry.occurrence > 0);
}
