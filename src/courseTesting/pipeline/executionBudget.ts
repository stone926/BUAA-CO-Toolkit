// @index course-testing-pipeline — provider-neutral 执行预算与 Verilog 仿真时间策略

/**
 * Probe 没有 oracle 执行阶段可用来推导 maxSteps，因此使用一个内部的、
 * 覆盖完整 P7 probe 的保守预算。该值只用于自动课程 Trace，不是用户配置项。
 */
export const p7ProbeExecutionInstructionBudget = 65_536;

const minimumCourseTraceSimulationTimeUs = 200;
const maximumCourseTraceSimulationTimeUs = 5_000;

/**
 * 课程 testbench 的一个完整时钟周期为 4ns。每个架构步预留 16 个时钟周期，
 * 可覆盖最慢的课程 MDU 停顿及流水线填充/排空，且 4094 条最强 payload
 * 不再被公共的 200us 波形仿真默认值截断。
 */
const nanosecondsPerCourseExecutionStep = 64;

/**
 * 从已经由 provider-neutral policy 计算的 maxSteps 派生自动 Verilog 仿真时间。
 *
 * 下限保持旧有短用例的容错窗口；5ms 上限仍相当于 125 万个课程时钟周期，
 * 在 4096-word IM 边界上有充足余量，同时避免畸形输入导致无界仿真。
 */
export function courseTraceSimulationTime(maxSteps: number): string {
  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
    throw new RangeError('course trace maxSteps must be a positive safe integer');
  }

  const stepsAtMaximum = Math.ceil(
    maximumCourseTraceSimulationTimeUs * 1_000 / nanosecondsPerCourseExecutionStep
  );
  if (maxSteps >= stepsAtMaximum) {
    return `${maximumCourseTraceSimulationTimeUs}us`;
  }
  const uncappedMicroseconds = Math.ceil(maxSteps * nanosecondsPerCourseExecutionStep / 1_000);
  const microseconds = Math.min(
    maximumCourseTraceSimulationTimeUs,
    Math.max(minimumCourseTraceSimulationTimeUs, uncappedMicroseconds)
  );
  return `${microseconds}us`;
}

export {
  courseExecutionInstructionBudget,
  courseExecutionInstructionBudgetFromCount
} from '../executionBudget';
