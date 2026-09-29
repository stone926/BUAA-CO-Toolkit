import * as vscode from 'vscode';
import { continuousCounts, ContinuousCounts, ContinuousRunStatus } from './courseTesting/continuous';
import { P7ProbeCheckResult } from './courseTesting/p7ProbeCheck';
import {
  NeutralTraceDiffSnapshot,
  TraceDiffSnapshot,
  TraceEventSnapshot
} from './language/mips/traceCompare';
import {
  AsmCaseManifestUnion,
  isManifestV2,
  manifestSourceOf
} from './courseTesting/manifestCodec';
import { manifestP7Of } from './courseTesting/manifestCodec';
import { probeScopeFromCase, specialTimerExlNotice } from './courseTesting/p7ProbeScope';
import type { P7ProbeScope } from './courseTesting/builtinAsm/types';
import { html, renderBadge, renderMetricGrid, renderReportPage, renderTable, SafeHtml } from './webview/reportLayout';
import {
  normalizeVerilogSimulationFailure,
  verilogSimulationFailureMessage,
  type VerilogSimulationFailure
} from './verilog/simulationDiagnostic';

const escapeHtml = html.text;
const courseTraceScopeNote = html.raw('<p class="report-footnote">通过表示本次程序的可观察结果满足对应检查；无写回指令的完整执行、课程周期范围和内部结构仍需另行验证。</p>');

export type CourseTraceStatus = 'passed' | 'failed' | 'error';
export type ExecutorShadowReportStatus = 'matched' | 'not-comparable' | 'course-correct' | 'mars-compatible' | 'inconclusive';

export interface CourseTraceShadowSummary {
  /**
   * Executor-only reuses one image; full-stack independently assembles both
   * sides. Missing is accepted only for historical phase-4 reports and must
   * never be interpreted as full-stack evidence.
   */
  evidenceKind?: 'executor-only' | 'full-stack';
  status: ExecutorShadowReportStatus;
  message: string;
  bundleDir?: string;
  resultFile?: string;
  legacyEvents?: number;
  builtinEvents?: number;
  disposition?: string;
  contractId?: string;
  assemblyMatched?: boolean;
  builtinWords?: number;
  legacyWords?: number;
}
export type NeutralCourseTraceStage = 'assemble' | 'oracle' | 'dut' | 'compare' | 'probe' | 'internal';
/** Stage values emitted by v1 reports and accepted indefinitely when reading. */
export type LegacyCourseTraceStage = 'dump' | 'mars' | 'isim' | 'logisim';
export type CourseTraceStage = NeutralCourseTraceStage | LegacyCourseTraceStage;

export interface CourseTraceCaseResult {
  asm: string;
  stdin?: string;
  caseId?: string;
  caseManifest?: string;
  asmSnapshot?: string;
  artifactsPruned?: boolean;
  status: CourseTraceStatus;
  /** True when an in-flight case ended only because its session was stopped. */
  cancelled?: true;
  stage: CourseTraceStage;
  message: string;
  /** Evidence scope of a P7 probe, retained even when execution fails before checking. */
  probeScope?: P7ProbeScope;
  machineCode?: string;
  oracleOut?: string;
  dutOut?: string;
  /** Simulator used by this run; `isim` is accepted only when reading historical reports. */
  dutBackend?: 'iverilog' | 'isim' | 'logisim';
  /** Bounded, path-safe terminal failure detail for reports and history. */
  dutFailure?: VerilogSimulationFailure;
  /** Optional raw DUT process output when dutOut is the normalized trace. */
  dutRawOut?: string;
  /** @deprecated v1 alias for oracleOut. */
  marsOut?: string;
  /** @deprecated v1 alias for dutOut. */
  simOut?: string;
  /** @deprecated v1 Logisim-specific alias for dutRawOut. */
  logisimOut?: string;
  logisimCircuit?: string;
  logisimRows?: number;
  firstDiffIndex?: number;
  firstDiff?: TraceDiffSnapshot;
  oracleEvents?: number;
  dutEvents?: number;
  /** @deprecated v1 alias for oracleEvents. */
  marsEvents?: number;
  /** @deprecated v1 alias for dutEvents. */
  simEvents?: number;
  matchedEvents?: number;
  diffEvents?: number;
  /** Phase-4/6 shadow evidence; the evidenceKind prevents cross-lane inheritance. */
  shadow?: CourseTraceShadowSummary;
  probe?: P7ProbeCheckResult;
}

/** Canonical result emitted by new pipeline code; v1 aliases exist only on the read model above. */
export type NeutralCourseTraceCaseResult = Omit<
  CourseTraceCaseResult,
  'stage' | 'marsOut' | 'simOut' | 'logisimOut' | 'marsEvents' | 'simEvents' | 'firstDiff'
> & {
  stage: NeutralCourseTraceStage;
  firstDiff?: NeutralTraceDiffSnapshot;
};

export interface CourseTraceBatchSource {
  kind: 'selected' | 'generator';
  generator?: string;
  commandLine?: string;
  cwd?: string;
  asmFiles?: string[];
}

export interface ContinuousTraceIteration {
  index: number;
  status: ContinuousRunStatus;
  startedAt: string;
  finishedAt?: string;
  source?: CourseTraceBatchSource;
  summary: ContinuousCounts;
  results: CourseTraceCaseResult[];
  message?: string;
}

export interface ContinuousTraceReport {
  /** Missing means a legacy report. New writes use the role-neutral v2 shape. */
  schemaVersion?: 1 | 2;
  generatedAt: string;
  running: boolean;
  stopRequested: boolean;
  totalIterations?: number;
  /** @deprecated legacy report provenance; new automatic reports keep it in each case manifest. */
  generator?: string;
  /** @deprecated legacy report provenance; new automatic reports keep it in each case manifest. */
  commandLine?: string;
  /** @deprecated legacy report provenance; new automatic reports keep it in each case manifest. */
  cwd?: string;
  /** @deprecated legacy internal controls; new automatic reports do not serialize them. */
  options?: {
    intervalMs: number;
    maxIterations: number;
    stopOnFailure: boolean;
  };
  /** @deprecated legacy internal controls; new automatic reports do not serialize them. */
  retention?: {
    retainedPassingCases: number;
    reportRetainedIterations: number;
    artifactOutputMode: 'workspace' | 'case';
  };
  iterations: ContinuousTraceIteration[];
}

export interface AsmCaseManifestEntry {
  manifest: AsmCaseManifestUnion;
  uri: vscode.Uri;
}

export const continuousTraceMonitorMaxRows = 100;

/** Map v1 engine/tool names to the stable pipeline role used by new reports. */
export function neutralCourseTraceStage(stage: CourseTraceStage): NeutralCourseTraceStage {
  switch (stage) {
    case 'dump':
      return 'assemble';
    case 'mars':
      return 'oracle';
    case 'isim':
    case 'logisim':
      return 'dut';
    default:
      return stage;
  }
}

export function courseTraceOracleOutput(item: CourseTraceCaseResult): string | undefined {
  return item.oracleOut ?? item.marsOut;
}

export function courseTraceDutOutput(item: CourseTraceCaseResult): string | undefined {
  // Legacy Logisim reports used `logisimOut` for the raw CLI stream, not the
  // normalized commit trace. Treating it as `dutOut` fabricates a canonical
  // trace when parsing failed before one was produced.
  return item.dutOut ?? item.simOut;
}

export function courseTraceDutRawOutput(item: CourseTraceCaseResult): string | undefined {
  return item.dutRawOut ?? item.logisimOut;
}

export function courseTraceOracleEvents(item: CourseTraceCaseResult): number | undefined {
  return item.oracleEvents ?? item.marsEvents;
}

export function courseTraceDutEvents(item: CourseTraceCaseResult): number | undefined {
  return item.dutEvents ?? item.simEvents;
}

/**
 * Convert either report generation into the v2 role-neutral wire shape.
 * Legacy aliases remain accepted by the renderer but are not written anew.
 */
export function neutralCourseTraceCaseResult(item: CourseTraceCaseResult): NeutralCourseTraceCaseResult {
  const {
    marsOut: _marsOut,
    simOut: _simOut,
    logisimOut: _logisimOut,
    marsEvents: _marsEvents,
    simEvents: _simEvents,
    firstDiff,
    ...rest
  } = item;
  const oracleOut = courseTraceOracleOutput(item);
  const dutOut = courseTraceDutOutput(item);
  const dutRawOut = courseTraceDutRawOutput(item);
  const oracleEvents = courseTraceOracleEvents(item);
  const dutEvents = courseTraceDutEvents(item);
  return {
    ...rest,
    stage: neutralCourseTraceStage(item.stage),
    ...(oracleOut === undefined ? {} : { oracleOut }),
    ...(dutOut === undefined ? {} : { dutOut }),
    ...(dutRawOut === undefined ? {} : { dutRawOut }),
    ...(oracleEvents === undefined ? {} : { oracleEvents }),
    ...(dutEvents === undefined ? {} : { dutEvents }),
    ...(firstDiff ? { firstDiff: neutralTraceDiffSnapshot(firstDiff) } : {})
  };
}

/**
 * Public automatic reports keep actionable CPU evidence and a replay id, but never serialize
 * private paths, generator controls, backend commands, or raw artifact locations.
 * The stable backend label is retained so a report identifies the simulator used.
 */
export function publicAutomaticCourseTraceCaseResult(
  item: CourseTraceCaseResult,
  index: number
): NeutralCourseTraceCaseResult {
  const neutral = neutralCourseTraceCaseResult(item);
  return {
    asm: `测试点 ${index + 1}`,
    ...(neutral.caseId ? { caseId: neutral.caseId } : {}),
    ...(neutral.artifactsPruned ? { artifactsPruned: true } : {}),
    status: neutral.status,
    ...(neutral.cancelled ? { cancelled: true } : {}),
    stage: neutral.stage,
    ...(neutral.dutBackend ? { dutBackend: neutral.dutBackend } : {}),
    ...(neutral.dutFailure ? {
      dutFailure: normalizeVerilogSimulationFailure(neutral.dutFailure)
    } : {}),
    message: publicAutomaticDiagnosticMessage(neutral),
    ...(neutral.probeScope ? { probeScope: neutral.probeScope } : {}),
    ...(neutral.firstDiffIndex === undefined ? {} : { firstDiffIndex: neutral.firstDiffIndex }),
    ...(neutral.firstDiff ? { firstDiff: neutral.firstDiff } : {}),
    ...(neutral.probe ? {
      probe: {
        passed: neutral.probe.passed,
        records: [],
        failures: neutral.probe.failures,
        diagnostics: [],
        ...(probeCoverage(neutral.probe).length ? { coverage: probeCoverage(neutral.probe) } : {})
      }
    } : {})
  };
}

/** Serialize the continuous monitor through the compact public result boundary. */
export function publicContinuousTraceReport(report: ContinuousTraceReport): ContinuousTraceReport {
  return {
    ...(report.schemaVersion === undefined ? {} : { schemaVersion: report.schemaVersion }),
    generatedAt: report.generatedAt,
    running: report.running,
    stopRequested: report.stopRequested,
    ...(report.totalIterations === undefined ? {} : { totalIterations: report.totalIterations }),
    iterations: report.iterations.map((iteration) => ({
      index: iteration.index,
      status: iteration.status,
      startedAt: iteration.startedAt,
      ...(iteration.finishedAt ? { finishedAt: iteration.finishedAt } : {}),
      source: { kind: 'generator' },
      summary: iteration.summary,
      results: iteration.results.map(publicAutomaticCourseTraceCaseResult),
      ...(iteration.message ? {
        message: '[AUTO-ITERATION] 本轮未完成；请使用失败用例的复现编号定位'
      } : {})
    }))
  };
}

/** Stable, path-free diagnosis shown by every public automatic-test surface. */
export function publicAutomaticDiagnosticMessage(item: CourseTraceCaseResult): string {
  const message = baseAutomaticDiagnosticMessage(item);
  return item.probeScope === 'special-timer-exl' ? `${message}。${specialTimerExlNotice}` : message;
}

function baseAutomaticDiagnosticMessage(item: CourseTraceCaseResult): string {
  if (item.cancelled) return '[AUTO-STOPPED] 测试已停止';
  if (item.status === 'error' && uncoveredProbeCoverage(item.probe).length) {
    return '[AUTO-COVERAGE] 未覆盖：返回后中断触发窗口未观测，无法判定';
  }
  if (item.status === 'passed') return '通过';
  if (item.status === 'failed') {
    return item.probe
      ? '[AUTO-PROBE] P7 定向检查未通过'
      : '[AUTO-MISMATCH] CPU 输出与参考结果不一致';
  }
  switch (neutralCourseTraceStage(item.stage)) {
    case 'assemble':
      return '[AUTO-ASSEMBLE] 测试点汇编未完成';
    case 'oracle':
      return '[AUTO-ORACLE] 参考结果未生成';
    case 'dut':
      return item.dutFailure
        ? `[AUTO-DUT] ${verilogSimulationFailureMessage(item.dutFailure, item.dutBackend === 'isim' ? undefined : item.dutBackend)}`
        : '[AUTO-DUT] CPU 仿真未完成；请检查工具链和顶层接口';
    case 'compare':
      return '[AUTO-COMPARE] 结果比较未完成';
    case 'probe':
      return '[AUTO-PROBE] P7 定向检查未完成';
    case 'internal':
      return '[AUTO-INTERNAL] 自动测试内部流程未完成；请使用复现编号定位';
  }
}

function neutralTraceDiffSnapshot(snapshot: TraceDiffSnapshot): NeutralTraceDiffSnapshot {
  const { mars, sim, ...rest } = snapshot;
  const oracle = snapshot.oracle ?? mars;
  const dut = snapshot.dut ?? sim;
  return {
    ...rest,
    status: snapshot.status === 'mars-only'
      ? 'oracle-only'
      : snapshot.status === 'sim-only'
        ? 'dut-only'
        : snapshot.status,
    ...(oracle ? { oracle } : {}),
    ...(dut ? { dut } : {})
  };
}

export function renderContinuousTraceMonitor(report: ContinuousTraceReport, _reportFile: vscode.Uri): string {
  const latest = report.iterations[0];
  const latestSummary = latest?.summary ?? continuousCounts([]);
  const totalIterations = report.totalIterations ?? report.iterations.length;
  const visibleIterations = report.iterations.slice(0, continuousTraceMonitorMaxRows);
  const hiddenIterations = Math.max(0, totalIterations - visibleIterations.length);
  const rows = visibleIterations.map((iteration) => {
    const firstProblemIndex = iteration.results.findIndex((item) => item.status !== 'passed');
    const firstProblem = firstProblemIndex >= 0 ? iteration.results[firstProblemIndex] : undefined;
    return {
      className: iteration.status,
      cells: [
        String(iteration.index),
        renderBadge(firstProblem && uncoveredProbeCoverage(firstProblem.probe).length
          ? '未覆盖' : continuousStatusLabel(iteration.status), statusTone(iteration.status)),
        String(iteration.summary.total),
        String(iteration.summary.passed),
        String(iteration.summary.failed),
        String(iteration.summary.errors),
        firstProblem ? renderAutomaticCaseLabel(firstProblemIndex, firstProblem) : '',
        firstProblem
          ? renderContinuousFirstProblem(firstProblem)
          : iteration.status === 'error'
            ? escapeHtml('本轮未完成，请在测试历史中查看诊断')
            : iteration.status === 'running' ? escapeHtml('正在执行本轮测试…') : '—'
      ]
    };
  });
  const hiddenNote = hiddenIterations
    ? html.raw(`<p class="muted">仅显示最近 ${html.text(visibleIterations.length)} / ${html.text(totalIterations)} 轮。</p>`)
    : html.raw('');
  const state = report.running ? (report.stopRequested ? '正在停止' : '运行中') : '已停止';

  return renderReportPage({
    title: '持续测试',
    subtitle: '持续生成测试点并与参考结果比较；发现首个失败或错误时自动停止。',
    extraCss: 'table { min-width: 960px; } td:nth-child(7) { min-width: 160px; } td:last-child { min-width: 280px; }',
    script: 'continuous',
    actions: html.raw(`<button type="button" class="secondary" data-report-action="openHistory">查看测试历史</button>${report.running && !report.stopRequested
      ? '<button type="button" class="secondary" data-report-action="stop">停止测试</button>' : ''}`),
    body: html.raw(`
  ${renderMetricGrid([
    { label: '状态', value: state },
    { label: '轮数', value: totalIterations },
    { label: '最近一轮通过', value: latestSummary.passed, tone: latestSummary.passed ? 'ok' : 'neutral' },
    { label: '最近一轮失败', value: latestSummary.failed, tone: latestSummary.failed ? 'bad' : 'neutral' },
    { label: '最近一轮错误', value: latestSummary.errors, tone: latestSummary.errors ? 'warn' : 'neutral' }
  ])}
  <div class="notice${latestSummary.failed || latestSummary.errors ? ' bad' : ''}">
    <div>失败用例可在“测试历史”中查看诊断摘要，并用复现编号定位；完整复现数据已自动保存。</div>
  </div>
  <div class="section-heading"><h2>最近测试轮次</h2><span class="muted">最新记录在前</span></div>
  ${hiddenNote}
  ${renderTable(['轮次', '状态', '用例', '通过', '失败', '错误', '失败用例', '首个差异'], rows, {
    label: '最近测试轮次',
    emptyMessage: report.running ? '正在准备第一轮测试，结果将自动显示在这里。' : '本次测试尚未产生记录。'
  })}
  ${courseTraceScopeNote}
`)
  });
}

function statusTone(status: string | undefined): 'ok' | 'bad' | 'warn' | 'neutral' {
  return status === 'passed' ? 'ok' : status === 'failed' ? 'bad' : status === 'error' ? 'warn' : 'neutral';
}

function continuousStatusLabel(status: ContinuousRunStatus): string {
  switch (status) {
    case 'running':
      return '测试中';
    case 'passed':
      return '通过';
    case 'failed':
      return '失败';
    case 'error':
      return '错误';
    case 'stopped':
      return '已停止';
  }
}

function renderContinuousFirstProblem(item: CourseTraceCaseResult): SafeHtml {
  const scopeNotice = item.probeScope === 'special-timer-exl'
    ? html.raw(`<div class="notice">${html.text(specialTimerExlNotice)}</div>`)
    : html.raw('');
  const probeFailure = item.probe?.failures[0];
  if (probeFailure) {
    return html.raw(`<div>${html.text(probeFailure.kind)}: ${html.text(probeFailure.message)}</div>${scopeNotice}`);
  }
  const uncovered = uncoveredProbeCoverage(item.probe);
  if (uncovered.length) {
    return html.raw(`<div>未覆盖：${html.text(uncovered[0].message)}</div>${scopeNotice}`);
  }
  if (item.firstDiff) {
    return html.raw(`${renderFirstDiffSummary(item)}${scopeNotice}`);
  }
  return html.raw(`${html.text(baseAutomaticDiagnosticMessage(item))}${scopeNotice}`);
}

export function renderAsmCaseIndex(cases: AsmCaseManifestEntry[]): string {
  const rows = cases.map(({ manifest }) => {
    const automatic = manifestSourceOf(manifest).kind !== 'selected';
    const metadata = isManifestV2(manifest) ? manifest.metadata : undefined;
    const outcome = metadata?.['test.status'];
    const diagnostic = metadata?.['test.diagnostic'];
    const uncovered = outcome === 'error' && diagnostic?.startsWith('[AUTO-COVERAGE]');
    const scope = probeScopeFromCase(manifestP7Of(manifest)?.probe, metadata);
    const scopeNotice = scope === 'special-timer-exl'
      ? html.raw(`<div class="notice">${html.text(specialTimerExlNotice)}</div>`)
      : html.raw('');
    const conciseDiagnostic = scope === 'special-timer-exl' && diagnostic?.endsWith(specialTimerExlNotice)
      ? diagnostic.slice(0, -specialTimerExlNotice.length).replace(/。$/, '') : diagnostic;
    return {
      className: outcome === 'passed' || outcome === 'failed' || outcome === 'error' ? outcome : 'saved',
      cells: [
        renderBadge(outcome === 'passed' ? '通过' : outcome === 'failed' ? '失败' : uncovered ? '未覆盖'
          : outcome === 'error' ? '错误' : '已保存', statusTone(outcome)),
        html.code(manifest.caseId),
        html.raw(`${html.text(conciseDiagnostic ?? '—')}${scopeNotice}`),
        escapeHtml(manifest.profile),
        escapeHtml(automatic ? '自动测试' : '手动测试'),
        renderCreatedAt(manifest.createdAt)
      ]
    };
  });
  return renderReportPage({
    title: '测试历史 / 失败用例',
    subtitle: '按创建时间倒序排列。使用复现编号定位已保存的用例，诊断信息已脱敏。',
    extraCss: `
      table { table-layout: fixed; min-width: 800px; }
      th:nth-child(1) { width: 78px; }
      th:nth-child(2) { width: 170px; }
      th:nth-child(4) { width: 80px; }
      th:nth-child(5) { width: 84px; }
      th:nth-child(6) { width: 108px; }
      td:nth-child(4), td:nth-child(5) { white-space: nowrap; }
      td:last-child { color: var(--co-muted); font-size: 12px; }
      .timestamp span { display: block; }
    `,
    script: cases.length > 0 ? 'history' : undefined,
    body: html.raw(`
  ${renderMetricGrid([
    { label: '已保存测试点', value: cases.length },
    { label: '通过', value: rows.filter((row) => row.className === 'passed').length, tone: 'ok' },
    { label: '失败 / 错误', value: rows.filter((row) => row.className === 'failed' || row.className === 'error').length, tone: 'bad' }
  ])}
  ${cases.length ? `<div class="filters" data-report-filters role="search" aria-label="筛选测试历史">
    <label class="search-field">搜索记录<input type="search" placeholder="复现编号、课程阶段或诊断关键词" aria-controls="history-results"></label>
    <label>测试结果<select aria-controls="history-results">
      <option value="">全部结果</option><option value="problem">失败 / 错误</option>
      <option value="passed">通过</option><option value="failed">失败</option><option value="error">错误</option><option value="saved">已保存</option>
    </select></label>
    <button type="button" class="secondary">清除筛选</button>
  </div>
  <p class="filter-count" id="filter-count" role="status" aria-live="polite">共 ${cases.length} 个测试点</p>
  <div class="empty-state" id="filter-empty" hidden><strong>没有匹配的记录</strong><p>试试其他关键词，或清除筛选查看全部测试点。</p></div>` : ''}
  <section id="history-results" aria-label="测试历史">
  ${renderTable(['结果', '复现编号', '诊断', '阶段', '来源', '时间'], rows, {
    label: '测试历史', emptyMessage: '还没有测试记录。使用侧边栏的“启动持续测试”开始检查 CPU。'
  })}
  </section>
`)
  });
}

let createdAtFormatter: Intl.DateTimeFormat | undefined;

function renderCreatedAt(value: string): SafeHtml {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return html.text(value);
  createdAtFormatter ??= new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = createdAtFormatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '';
  const day = `${part('year')}/${part('month')}/${part('day')}`;
  const time = `${part('hour')}:${part('minute')}:${part('second')}`;
  return html.raw(`<time class="timestamp" datetime="${html.text(value)}" title="${html.text(value)}"><span>${html.text(day)}</span><span>${html.text(time)}</span></time>`);
}

function renderFirstDiffSummary(item: CourseTraceCaseResult): SafeHtml {
  if (item.probe) {
    return renderProbeDetails(item.probe);
  }
  if (!item.firstDiff) {
    return html.raw('');
  }
  const reason = item.firstDiff.reason ?? item.firstDiff.status;
  const oracle = item.firstDiff.oracle ?? item.firstDiff.mars;
  const dut = item.firstDiff.dut ?? item.firstDiff.sim;
  return html.raw([
    `<div>${html.text(reason)}</div>`,
    `<div class="diff-line"><span>Oracle</span><code>${html.text(traceEventSummary(oracle))}</code></div>`,
    `<div class="diff-line"><span>DUT</span><code>${html.text(traceEventSummary(dut))}</code></div>`
  ].join(''));
}

function renderProbeDetails(probe: P7ProbeCheckResult): SafeHtml {
  const failures = probe.failures.slice(0, 5).map((failure) =>
    `<div><code>#${html.text(failure.scenarioId)} ${html.text(failure.kind)}: ${html.text(failure.message)}</code></div>`
  );
  const records = probe.records.slice(0, 5).map((record) =>
    `<div><code>#${html.text(record.scenarioId)}: Cause=0x${html.text((record.cause >>> 0).toString(16))} EPC=0x${html.text((record.epc >>> 0).toString(16))} aux0=0x${html.text((record.aux0 >>> 0).toString(16))}</code></div>`
  );
  const coverage = probeCoverage(probe).map((entry) =>
    `<div>${entry.covered ? '已覆盖' : '未覆盖'}：${html.text(entry.message)}</div>`
  );
  return html.raw([...coverage, ...failures, ...records].join(''));
}

function probeCoverage(probe: P7ProbeCheckResult | undefined): Array<{ covered: boolean; message: string }> {
  const entries = probe?.coverage;
  return Array.isArray(entries) ? entries : [];
}

function uncoveredProbeCoverage(probe: P7ProbeCheckResult | undefined): Array<{ covered: boolean; message: string }> {
  if (probe?.failures.length) return [];
  return probeCoverage(probe).filter((entry) => !entry.covered);
}

function traceEventSummary(event: TraceEventSnapshot | undefined): string {
  if (!event) {
    return '(missing)';
  }
  const cycle = event.cycle === undefined ? '' : `${event.cycle}@`;
  const target = event.kind === 'grf' ? `$${event.target}` : `*${event.target}`;
  return `${cycle}${event.pc}: ${target} <= ${event.value} (line ${event.lineNumber})`;
}

function renderAutomaticCaseLabel(index: number, item: CourseTraceCaseResult): SafeHtml {
  const label = `测试点 ${index + 1}`;
  if (item.status === 'passed' || !item.caseId) {
    return html.text(label);
  }
  return html.raw(`${html.text(label)}<div class="muted">Case ${html.code(item.caseId)}</div>`);
}
