// @index course-testing-oracle — phase-4 executor shadow 差异登记策略（course-correct / mars-compatible / inconclusive）

import type { CommitEvent } from '../../mips/core/events/commitEvent';

/**
 * Stable registry snapshot. A mismatch is only allowed to choose legacy when it
 * maps to a `mars-compatible` entry; a `course-correct` entry means the TS core
 * (or the course vector) is authoritative. Anything unregistered stays
 * `inconclusive` and must never count as a pass (计划阶段 4 退出标准).
 */

export type ShadowDisposition =
  | 'matched'
  | 'not-comparable'
  | 'course-correct'
  | 'mars-compatible'
  | 'inconclusive';

export interface RegisteredShadowDivergence {
  readonly id: string;
  readonly category: 'mars-bug' | 'course-correct' | 'format-only' | 'source-conflict';
  readonly disposition: Exclude<ShadowDisposition, 'matched' | 'not-comparable' | 'inconclusive'>;
  readonly summary: string;
}

export const registeredShadowDivergences: readonly RegisteredShadowDivergence[] = Object.freeze([
  Object.freeze({
    id: 'MARS-DIV-P7SYSCALL-001',
    category: 'course-correct',
    disposition: 'course-correct',
    summary: 'P7 syscall 是课程异常语义；MARS syscall service 行为仅作 legacy 兼容。'
  }),
  Object.freeze({
    id: 'MARS-DIV-EAOVERFLOW-001',
    category: 'course-correct',
    disposition: 'course-correct',
    summary: '访存有效地址加法溢出按课程契约进入 AdEL/AdES，而不是采用 MARS 环绕结果。'
  }),
  Object.freeze({
    id: 'MARS-DIV-GPSP-001',
    category: 'mars-bug',
    disposition: 'course-correct',
    summary: 'Compact 初态 $gp/$sp 是 MARS bug；课程复位 GPR 全零。'
  }),
  Object.freeze({
    id: 'MARS-DIV-REGIMM-001',
    category: 'mars-bug',
    disposition: 'course-correct',
    summary: 'BGEZAL/BLTZAL not-taken 时 MARS 遗漏 $31=PC+8。'
  }),
  Object.freeze({
    id: 'MARS-DIV-DATASEG-001',
    category: 'mars-bug',
    disposition: 'course-correct',
    summary: 'MARS-only 数据段不属于课程硬件，不能成为 golden。'
  }),
  Object.freeze({
    id: 'MARS-DIV-UNDEFINED-001',
    category: 'mars-bug',
    disposition: 'course-correct',
    summary: '课程定义为 UNPREDICTABLE 的输入不采用 MARS 结果。'
  }),
  Object.freeze({
    id: 'MARS-DIV-SWLSWR-001',
    category: 'format-only',
    disposition: 'course-correct',
    summary: 'SWL/SWR 逐字节 coL2 事件在 projection 前合并；该差异不应进入 trace comparison。'
  }),
  Object.freeze({
    id: 'MARS-DIV-VICTIM-001',
    category: 'format-only',
    disposition: 'course-correct',
    summary: 'efc 缺失 victim 头在 legacy normalizer 内补齐。'
  }),
  Object.freeze({
    id: 'MARS-DIV-HALT-001',
    category: 'format-only',
    disposition: 'course-correct',
    summary: '停机尾验证格式差异；comparison 只看投影后的架构写。'
  }),
  Object.freeze({
    id: 'MARS-DIV-COMPACT-001',
    category: 'mars-bug',
    disposition: 'course-correct',
    summary: 'Compact* 文本上界排他属于 assembler 差异，不进入 executor shadow 比较。'
  }),
  Object.freeze({
    id: 'MARS-DIV-RAW-TEXT-WORD-001',
    category: 'course-correct',
    disposition: 'course-correct',
    summary: '课程测试点允许在 text/ktext 注入 raw word；固定 MARS 汇编器拒绝该内部扩展。'
  }),
  Object.freeze({
    id: 'COURSE-DIV-TIMER-RESTART-001',
    category: 'source-conflict',
    disposition: 'course-correct',
    summary: 'Timer restart pending IRQ 按官方 RTL 裁决；device cycle vector 已覆盖。'
  }),
  Object.freeze({
    id: 'COURSE-DIV-L13-EXC-PRIORITY-001',
    category: 'source-conflict',
    disposition: 'course-correct',
    summary: '同 victim 异常码按 F>D>E>M 结构表裁决。'
  })
]);

export interface ShadowClassificationContext {
  readonly profile?: string;
  /** Commit occurrence corresponding to the first projected builtin trace diff. */
  readonly builtinEvent?: CommitEvent;
}

export interface ShadowClassification {
  readonly disposition: ShadowDisposition;
  readonly contractId?: string;
  readonly message: string;
}

/**
 * Classify one first trace difference. The matcher set is deliberately small:
 * normalizers are expected to have removed every registered format-only/bug
 * difference before comparison, so an unexplained diff remains inconclusive.
 */
export function classifyShadowDifference(context: ShadowClassificationContext): ShadowClassification {
  const builtinEvent = context.builtinEvent;
  if (builtinEvent?.trap?.name === 'syscall'
    || builtinEvent?.mnemonic === 'syscall') {
    return {
      disposition: 'course-correct',
      contractId: 'MARS-DIV-P7SYSCALL-001',
      message: 'P7 syscall 按课程异常契约执行；legacy MARS 的 service 行为是已登记差异。'
    };
  }
  return {
    disposition: 'inconclusive',
    message: 'executor shadow 发现未登记差异；不得采用任何一侧结果，等待 course vector 或 ledger 裁决。'
  };
}
