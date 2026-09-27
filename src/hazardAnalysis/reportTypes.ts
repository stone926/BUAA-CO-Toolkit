// @index hazard-report-types — 内置冲突冒险报告的可序列化稳定契约
import type { CourseHazardClass, CourseHazardModel } from './courseHazardTheory';
import type { PipelineStage, SourceRole } from './hazardTiming';

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
}
