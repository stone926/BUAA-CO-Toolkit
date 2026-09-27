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
  return list(value.classCoverage, 200, classRow)
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
  return ['producer', 'register'].every((key) => value[key] === undefined || text(value[key]))
    && (value.producerOrder === undefined || count(value.producerOrder))
    && (value.producerPc === undefined || (range(value.producerPc, 0xffffffff) && Number.isInteger(value.producerPc)))
    && (value.interval === undefined || count(value.interval))
    && (value.valid === undefined || typeof value.valid === 'boolean')
    && (value.role === undefined || member(value.role, ['rs', 'rt']))
    && ['sourceStage', 'destinationStage'].every((key) => value[key] === undefined || member(value[key], ['D', 'E', 'M', 'W']));
}
