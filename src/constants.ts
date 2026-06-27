// @index constants — 集中常量：Profile分组/路径约定/输出目录名
import { ProjectProfile } from './projectProfile';

// ── Profile 分组 ──

/** 所有可选 Profile（含 auto）。 */
export const ALL_PROFILES: ProjectProfile[] = [
  'auto', 'P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'
];

/** 具体 Project Profile（不含 auto）。 */
export const CONCRETE_PROFILES: ProjectProfile[] = [
  'P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'
];

/** 产生 CPU Trace 的 Profile。 */
export const TRACE_PROFILES = new Set<ProjectProfile>([
  'P3', 'P4', 'P5', 'P6', 'P7'
]);

/** 使用 Verilog 开发流程的 Profile。 */
export const VERILOG_PROFILES = new Set<ProjectProfile>([
  'P1', 'P4', 'P5', 'P6', 'P7'
]);

/** 使用 MIPS 汇编（Mars 运行）的 Profile。 */
export const MIPS_PROFILES = new Set<ProjectProfile>([
  'P2', 'P4', 'P5', 'P6', 'P7'
]);

/** Logisim 电路相关的 Profile。 */
export const LOGISIM_PROFILES = new Set<ProjectProfile>([
  'P0', 'P3'
]);

/** 需要 ASM case 才能仿真对拍的 Verilog Profile。 */
export const ASM_NEEDED_VERILOG_PROFILES = new Set<ProjectProfile>([
  'P4', 'P5', 'P6', 'P7'
]);

/** 需要 Hazard 对拍的 Profile。 */
export const HAZARD_PROFILES = new Set<ProjectProfile>([
  'P5', 'P6', 'P7'
]);

/** 流水线 CPU（有延迟槽）的 Profile。 */
export const DELAYED_BRANCHING_PROFILES = new Set<ProjectProfile>([
  'P5', 'P6', 'P7'
]);

/** 需要停机自环的 CPU Profile（P7 自带内核合并，单独处理）。 */
export const CPU_HALT_PROFILES = new Set<ProjectProfile>([
  'P4', 'P5', 'P6'
]);

/** 追踪产生时配置文件/上下文 Profile 映射。 */
export const TRACE_CONTEXT_PROFILES = new Set<ProjectProfile>([
  'P3', 'P4', 'P5', 'P6', 'P7'
]);

export const VERILOG_CONTEXT_PROFILES = new Set<ProjectProfile>([
  'P1', 'P4', 'P5', 'P6', 'P7'
]);

// ── 路径约定 ──

/** 插件输出根目录（相对于工作区）。 */
export const CO_DIR = '.co';

/** 课程测试用例存储目录。 */
export const CO_CASES_DIR = '.co/cases';

/** MARS/ISim 输出目录。 */
export const CO_OUT_DIR = '.co/out';

/** ISim 工程目录。 */
export const CO_ISIM_DIR = '.co/isim';

/** Hazard 分析输出目录。 */
export const CO_HAZARD_DIR = '.co/hazard';

/** 临时文件目录。 */
export const CO_TMP_DIR = '.co/tmp';

/** ISE 语法检查临时目录。 */
export const CO_ISE_CHECK_DIR = '.co/ise-check';
