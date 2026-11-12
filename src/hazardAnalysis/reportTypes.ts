// @index hazard-report-types — 内置冲突冒险报告的可序列化稳定契约
import type { CourseHazardClass, CourseHazardModel } from './courseHazardTheory';
import type { PipelineStage, SourceRole } from './hazardTiming';
import type { ExternalInterruptRequest } from '../mips/core/devices/interruptController';

export type HazardObservability = 'observable' | 'masked' | 'unknown';

/** Current consumer's single-operand architectural-effect sensitivity, not a program fault rate. */
export interface HazardDetailGroup {
  readonly events: number;
  readonly validEvents: number;
  readonly keys: readonly string[];
  readonly validKeys: readonly string[];
  readonly keysTruncated: boolean;
  readonly validKeysTruncated: boolean;
  readonly observability: Readonly<Record<HazardObservability, number>>;
}

/** Full-stream observations; deliberately no claimed exhaustive feasibility denominator. */
export interface HazardDetailedStats {
  readonly schemaVersion: 1;
  readonly forward: HazardDetailGroup;
  readonly zero: HazardDetailGroup;
  readonly priority: HazardDetailGroup;
  readonly hiLo: HazardDetailGroup;
  readonly stallCauses: { readonly events: number; readonly keys: readonly string[]; readonly keysTruncated: boolean };
}

export interface HazardExecutionContext {
  readonly source: 'standalone' | 'case';
  readonly externalInterrupts: readonly ExternalInterruptRequest[];
  readonly caseId?: string;
}

export type HazardProfile = 'P5' | 'P6' | 'P7';
export type HazardStopReason = 'course-halt-loop' | 'program-end' | 'step-limit' | 'out-of-domain' | 'cancelled' | 'engine-error';

export interface HazardClassCoverage {
  readonly pair: string;
  readonly consumerClass: CourseHazardClass;
  readonly producerClass: CourseHazardClass;
  readonly forwardCovered: number;
  readonly forwardExpected: number;
  readonly stallCovered: number;
  readonly stallExpected: number;
  readonly forwardGrade: number | null;
  readonly stallGrade: number | null;
}

export interface HazardSummary {
  readonly instructions: number;
  readonly cycles: number;
  readonly dataStallCycles: number;
  readonly multiplyDivideStallCycles: number;
  readonly forwardEvents: number;
  readonly validForwardEvents: number;
  readonly forwardValidRate: number | null;
  readonly forwardCovered: number;
  readonly forwardExpected: number;
  readonly forwardCoverage: number;
  readonly stallCovered: number;
  readonly stallExpected: number;
  readonly stallCoverage: number;
  readonly forwardGrade: number | null;
  readonly stallGrade: number | null;
}

export interface HazardReportEvent {
  readonly kind: 'forward' | 'stall' | 'zero' | 'priority' | 'hilo';
  readonly consumerPc: number;
  readonly consumerOrder: number;
  /** Estimated cycle when the consumer leaves D (0-based). */
  readonly cycle: number;
  readonly consumer: string;
  readonly producer?: string;
  readonly producerPc?: number;
  readonly producerOrder?: number;
  readonly register?: string;
  readonly role?: SourceRole;
  readonly sourceStage?: PipelineStage;
  readonly destinationStage?: PipelineStage;
  readonly interval?: number;
  readonly valid?: boolean;
  readonly observability?: HazardObservability;
  readonly gap?: number;
  readonly olderProducer?: string;
  readonly newerProducer?: string;
  readonly olderGap?: number;
  readonly newerGap?: number;
}

/** Every numeric rate is in [0,1]; absent rate/grade is JSON null, never NaN. */
export interface HazardReport {
  readonly version: 1;
  readonly profile: HazardProfile;
  readonly model: CourseHazardModel;
  readonly imageFingerprint: string;
  readonly summary: HazardSummary;
  readonly classCoverage: readonly HazardClassCoverage[];
  readonly forwardTuples: readonly string[];
  readonly stallTuples: readonly string[];
  readonly events: readonly HazardReportEvent[];
  readonly omittedEvents: number;
  readonly warnings: readonly string[];
  readonly stopReason: HazardStopReason;
  readonly stopPc: number;
  /** Absent in historical v1 reports. */
  readonly detailed?: HazardDetailedStats;
  readonly execution?: HazardExecutionContext;
}
