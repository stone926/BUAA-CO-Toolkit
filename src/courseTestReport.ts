import * as path from 'path';
import * as vscode from 'vscode';
import { continuousCounts, ContinuousCounts, ContinuousRunStatus } from './courseTesting/continuous';
import { logisimPrepSummary, LogisimPrepareCaseResult } from './courseTesting/logisimPrep';
import { P7ProbeCheckResult } from './courseTesting/p7ProbeCheck';
import { LogisimRomTarget } from './language/logisim/rom';
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
import { html, renderMetricGrid, renderReportPage, renderTable, SafeHtml } from './webview/reportLayout';

const escapeHtml = html.text;

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
export type NeutralCourseTraceStage = 'assemble' | 'oracle' | 'dut' | 'compare' | 'probe';
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
  machineCode?: string;
  oracleOut?: string;
  dutOut?: string;
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

export interface CourseTraceBatchSummary {
  total: number;
  passed: number;
  failed: number;
  errors: number;
}

export interface CourseTraceBatchReport {
  /** Missing means a legacy v1 report. New writes use schema 2. */
  schemaVersion?: 1 | 2;
  generatedAt: string;
  source?: CourseTraceBatchSource;
  summary: CourseTraceBatchSummary;
  results: CourseTraceCaseResult[];
}

export interface CourseTraceBatchSource {
  kind: 'selected' | 'generator';
  generator?: string;
  commandLine?: string;
  cwd?: string;
  asmFiles?: string[];
}

export interface LogisimPrepareReport {
  generatedAt: string;
  source: CourseTraceBatchSource;
  circuitTemplate: string;
  romTarget: {
    index: number;
    label?: string;
    loc?: string;
    addrWidth?: number;
    dataWidth?: number;
  };
  summary: ReturnType<typeof logisimPrepSummary>;
  results: LogisimPrepareCaseResult[];
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

export function createCourseTraceBatchReport(
  results: CourseTraceCaseResult[],
  source?: CourseTraceBatchSource,
  generatedAt = new Date().toISOString()
): CourseTraceBatchReport {
  const neutralResults = source?.kind === 'generator'
    ? results.map(publicAutomaticCourseTraceCaseResult)
    : results.map(neutralCourseTraceCaseResult);
  return {
    schemaVersion: 2,
    generatedAt,
    ...(source ? { source: publicBatchReportSource(source) } : {}),
    summary: batchSummary(neutralResults),
    results: neutralResults
  };
}

/**
 * Public automatic reports keep actionable CPU evidence and a replay id, but never serialize
 * private paths, generator controls, backend commands, or raw artifact locations.
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
    message: publicAutomaticDiagnosticMessage(neutral),
    ...(neutral.firstDiffIndex === undefined ? {} : { firstDiffIndex: neutral.firstDiffIndex }),
    ...(neutral.firstDiff ? { firstDiff: neutral.firstDiff } : {}),
    ...(neutral.probe ? {
      probe: {
        passed: neutral.probe.passed,
        records: [],
        failures: neutral.probe.failures,
        diagnostics: []
      }
    } : {})
  };
}

/** Serialize the continuous monitor through the same compact public boundary as one-shot runs. */
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
  if (item.cancelled) return '[AUTO-STOPPED] 测试已停止';
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
      return '[AUTO-DUT] CPU 仿真未完成；请检查工具链和顶层接口';
    case 'compare':
      return '[AUTO-COMPARE] 结果比较未完成';
    case 'probe':
      return '[AUTO-PROBE] P7 定向检查未完成';
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

const traceStatusCss = `
    .passed td:nth-child(2) {
      color: var(--vscode-testing-iconPassed);
      font-weight: 600;
    }
    .failed td:nth-child(2), .error td:nth-child(2) {
      color: var(--vscode-testing-iconFailed);
      font-weight: 600;
    }
    .running td:nth-child(2), .stopped td:nth-child(2) {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
`;

const logisimPrepareStatusCss = `
    .prepared td:nth-child(2) {
      color: var(--vscode-testing-iconPassed);
      font-weight: 600;
    }
    .error td:nth-child(2) {
      color: var(--vscode-testing-iconFailed);
      font-weight: 600;
    }
`;

const historyStatusCss = `
    .passed td:nth-child(6) {
      color: var(--vscode-testing-iconPassed);
      font-weight: 600;
    }
    .failed td:nth-child(6), .error td:nth-child(6) {
      color: var(--vscode-testing-iconFailed);
      font-weight: 600;
    }
`;

export function showLogisimPrepareReport(
  report: vscode.Uri,
  results: LogisimPrepareCaseResult[],
  source: CourseTraceBatchSource,
  circuit: vscode.Uri,
  target: LogisimRomTarget
): void {
  const panel = vscode.window.createWebviewPanel('coLogisimPrepareReport', 'CO Logisim 用例准备', vscode.ViewColumn.Beside, {
    enableScripts: false
  });
  panel.webview.html = renderLogisimPrepareReport(report, results, source, circuit, target);
}

export function showBatchTraceReport(
  results: CourseTraceCaseResult[],
  report: vscode.Uri,
  generatedAt?: string,
  source?: CourseTraceBatchSource
): void {
  const panel = vscode.window.createWebviewPanel(
    'coBatchTraceReport',
    source?.kind === 'generator' ? '自动测试结果' : 'CO 批量 Trace 测试',
    vscode.ViewColumn.Beside,
    {
    enableScripts: false
    }
  );
  panel.webview.html = renderBatchTraceReport(results, report, generatedAt, source);
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
        escapeHtml(continuousStatusLabel(iteration.status)),
        String(iteration.summary.total),
        String(iteration.summary.passed),
        String(iteration.summary.failed),
        String(iteration.summary.errors),
        firstProblem ? renderAutomaticCaseLabel(firstProblemIndex, firstProblem) : '',
        firstProblem
          ? renderContinuousFirstProblem(firstProblem)
          : iteration.status === 'error'
            ? escapeHtml('本轮未完成，请打开完整报告查看诊断')
            : ''
      ]
    };
  });
  const hiddenNote = hiddenIterations
    ? html.raw(`<p class="muted">仅显示最近 ${html.text(visibleIterations.length)} / ${html.text(totalIterations)} 轮。</p>`)
    : html.raw('');
  const state = report.running ? (report.stopRequested ? '正在停止' : '运行中') : '已停止';

  return renderReportPage({
    title: '持续测试',
    extraCss: traceStatusCss,
    body: html.raw(`
  ${renderMetricGrid([
    { label: '状态', value: state },
    { label: '轮数', value: totalIterations },
    { label: '最近一轮通过', value: latestSummary.passed },
    { label: '最近一轮失败', value: latestSummary.failed },
    { label: '最近一轮错误', value: latestSummary.errors }
  ])}
  <div class="paths">
    <div>失败用例可在“测试历史”中查看诊断摘要，并用复现编号定位；完整复现数据已自动保存。</div>
  </div>
  ${hiddenNote}
  ${renderTable(['#', '状态', '用例', '通过', '失败', '错误', '失败用例', '首个差异'], rows)}
`)
  });
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
  const probeFailure = item.probe?.failures[0];
  if (probeFailure) {
    return html.raw(`<div>${html.text(probeFailure.kind)}: ${html.text(probeFailure.message)}</div>`);
  }
  if (item.firstDiff) {
    return renderFirstDiffSummary(item);
  }
  return html.text(publicAutomaticDiagnosticMessage(item));
}

export function renderBatchTraceReport(
  results: CourseTraceCaseResult[],
  report: vscode.Uri,
  generatedAt?: string,
  source?: CourseTraceBatchSource
): string {
  if (source?.kind === 'generator') {
    return renderAutomaticBatchTraceReport(results);
  }
  const summary = batchSummary(results);
  const rows = results.map((item, index) => ({
    className: item.status,
    cells: [
      String(index + 1),
      escapeHtml(item.status.toUpperCase()),
      item.caseId ? html.code(item.caseId) : '',
      escapeHtml(path.basename(item.asm)),
      item.stdin ? escapeHtml(path.basename(item.stdin)) : '',
      escapeHtml(neutralCourseTraceStage(item.stage)),
      item.firstDiffIndex === undefined ? '' : String(item.firstDiffIndex + 1),
      renderFirstDiffSummary(item),
      renderCaseArtifacts(item),
      escapeHtml(summaryText(item)),
      escapeHtml(item.message)
    ]
  }));

  return renderReportPage({
    title: 'CO 批量 Trace 测试',
    extraCss: traceStatusCss,
    body: html.raw(`
  ${renderMetricGrid([
    { label: '总数', value: summary.total },
    { label: '通过', value: summary.passed },
    { label: '失败', value: summary.failed },
    { label: '错误', value: summary.errors }
  ])}
  ${generatedAt ? `<div class="paths">生成时间: <code>${escapeHtml(generatedAt)}</code></div>` : ''}
  ${renderBatchSource(source)}
  <div class="paths">JSON 报告: <code>${escapeHtml(report.fsPath)}</code></div>
  ${renderTable(['#', '状态', 'Case', 'ASM', '输入', '阶段', '首个差异', '首个差异详情', '产物', '事件', '消息'], rows)}
`)
  });
}

function renderAutomaticBatchTraceReport(results: CourseTraceCaseResult[]): string {
  const summary = batchSummary(results);
  const rows = results.map((item, index) => ({
    className: item.status,
    cells: [
      String(index + 1),
      escapeHtml(item.status === 'passed' ? '通过' : item.status === 'failed' ? '失败' : '错误'),
      renderAutomaticCaseLabel(index, item),
      item.status === 'passed' ? html.text('通过') : renderContinuousFirstProblem(item)
    ]
  }));
  return renderReportPage({
    title: '自动测试',
    extraCss: traceStatusCss,
    body: html.raw(`
  ${renderMetricGrid([
    { label: '总数', value: summary.total },
    { label: '通过', value: summary.passed },
    { label: '失败', value: summary.failed },
    { label: '错误', value: summary.errors }
  ])}
  <div class="paths">失败用例可在“测试历史”中查看诊断摘要，并用复现编号定位；完整复现信息已自动保存。</div>
  ${renderTable(['#', '状态', '测试点', '结果'], rows)}
`)
  });
}

function publicBatchReportSource(source: CourseTraceBatchSource): CourseTraceBatchSource {
  if (source.kind === 'generator') {
    // Full generator provenance is already sealed in each case manifest. Keep only the marker
    // required to reopen this JSON with the compact automatic-test renderer.
    return { kind: 'generator' };
  }
  return source;
}

function renderAutomaticCaseLabel(index: number, item: CourseTraceCaseResult): SafeHtml {
  const label = `测试点 ${index + 1}`;
  if (item.status === 'passed' || !item.caseId) {
    return html.text(label);
  }
  return html.raw(`${html.text(label)}<div class="muted">Case ${html.code(item.caseId)}</div>`);
}

export function renderLogisimPrepareReport(
  report: vscode.Uri,
  results: LogisimPrepareCaseResult[],
  source: CourseTraceBatchSource,
  circuit: vscode.Uri,
  target: LogisimRomTarget
): string {
  const summary = logisimPrepSummary(results);
  const rows = results.map((item, index) => ({
    className: item.status,
    cells: [
      String(index + 1),
      escapeHtml(item.status.toUpperCase()),
      item.caseId ? html.code(item.caseId) : '',
      escapeHtml(path.basename(item.asm)),
      item.wordCount === undefined ? '' : String(item.wordCount),
      item.circuit ? html.code(item.circuit) : '',
      escapeHtml(item.message)
    ]
  }));

  return renderReportPage({
    title: 'CO Logisim 用例准备',
    extraCss: logisimPrepareStatusCss,
    body: html.raw(`
  ${renderMetricGrid([
    { label: '总数', value: summary.total },
    { label: '已准备', value: summary.prepared },
    { label: '错误', value: summary.errors }
  ])}
  ${renderBatchSource(source)}
  <div class="paths">
    <div>电路模板: <code>${escapeHtml(circuit.fsPath)}</code></div>
    <div>ROM 目标: <code>${escapeHtml(target.label ?? 'ROM')} #${target.index}${target.loc ? ` ${target.loc}` : ''}</code></div>
    <div>JSON 报告: <code>${escapeHtml(report.fsPath)}</code></div>
  </div>
  ${renderTable(['#', '状态', 'Case', 'ASM', '字数', '已准备电路', '消息'], rows)}
`)
  });
}

export function renderBatchSource(source: CourseTraceBatchSource | undefined): SafeHtml {
  if (!source) {
    return html.raw('');
  }
  if (source.kind !== 'generator') {
    return html.raw('<div class="paths">来源: 手动选择的 ASM 文件</div>');
  }
  const asmCount = source.asmFiles?.length ?? 0;
  return html.raw(`<div class="paths">
    <div>来源: 自动测试${asmCount ? ` (${asmCount})` : ''}</div>
  </div>`);
}

export function renderAsmCaseIndex(cases: AsmCaseManifestEntry[]): string {
  const rows = cases.map(({ manifest }, index) => {
    const automatic = manifestSourceOf(manifest).kind !== 'selected';
    const metadata = isManifestV2(manifest) ? manifest.metadata : undefined;
    const outcome = metadata?.['test.status'];
    const diagnostic = metadata?.['test.diagnostic'];
    return {
      className: outcome,
      cells: [
        String(index + 1),
        escapeHtml(manifest.createdAt),
        escapeHtml(manifest.profile),
        escapeHtml(automatic ? '自动测试' : '手动测试'),
        html.code(manifest.caseId),
        escapeHtml(outcome === 'passed' ? '通过' : outcome === 'failed' ? '失败' : outcome === 'error' ? '错误' : '已保存'),
        escapeHtml(diagnostic ?? '—')
      ]
    };
  });
  return renderReportPage({
    title: '测试历史 / 失败用例',
    extraCss: historyStatusCss,
    body: html.raw(`
  <div class="summary">共 ${cases.length} 个测试点，按创建时间倒序排列。诊断已脱敏；发现问题后，可用复现编号定位已保存的数据。</div>
  ${renderTable(['#', '时间', '课程阶段', '来源', '复现编号', '结果', '诊断'], rows)}
`)
  });
}

export function batchSummary(results: CourseTraceCaseResult[]): CourseTraceBatchSummary {
  return {
    total: results.length,
    passed: results.filter((item) => item.status === 'passed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    errors: results.filter((item) => item.status === 'error').length
  };
}

function summaryText(item: CourseTraceCaseResult): string {
  if (item.probe) {
    return `Probe records ${item.probe.records.length}, failures ${item.probe.failures.length}`;
  }
  const oracleEvents = courseTraceOracleEvents(item);
  const dutEvents = courseTraceDutEvents(item);
  if (oracleEvents === undefined || dutEvents === undefined) {
    return '';
  }
  return `Oracle ${oracleEvents}, DUT ${dutEvents}, matched ${item.matchedEvents ?? 0}, diff ${item.diffEvents ?? 0}`;
}

function renderCaseArtifacts(item: CourseTraceCaseResult): SafeHtml {
  const dutOut = courseTraceDutOutput(item);
  const dutRawOut = courseTraceDutRawOutput(item);
  const entries = [
    ['ASM Snapshot', item.asmSnapshot],
    ['Machine Code', item.machineCode],
    ['Oracle', courseTraceOracleOutput(item)],
    ['DUT', dutOut],
    ['DUT Raw', dutRawOut === dutOut ? undefined : dutRawOut],
    [item.shadow?.evidenceKind === 'full-stack' ? 'Full-stack Evidence' : 'Executor Shadow', item.shadow?.resultFile]
  ].filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0);
  if (!entries.length) {
    return html.raw('');
  }
  return html.raw(entries
    .map(([label, value]) => `<div>${html.text(label)}: ${html.path(value)}</div>`)
    .join(''));
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
    `<div><code>Oracle ${html.text(traceEventSummary(oracle))}</code></div>`,
    `<div><code>DUT ${html.text(traceEventSummary(dut))}</code></div>`
  ].join(''));
}

function renderProbeDetails(probe: P7ProbeCheckResult): SafeHtml {
  const failures = probe.failures.slice(0, 5).map((failure) =>
    `<div><code>#${html.text(failure.scenarioId)} ${html.text(failure.kind)}: ${html.text(failure.message)}</code></div>`
  );
  const records = probe.records.slice(0, 5).map((record) =>
    `<div><code>#${html.text(record.scenarioId)}: Cause=0x${html.text((record.cause >>> 0).toString(16))} EPC=0x${html.text((record.epc >>> 0).toString(16))} aux0=0x${html.text((record.aux0 >>> 0).toString(16))}</code></div>`
  );
  return html.raw([...failures, ...records].join(''));
}

function traceEventSummary(event: TraceEventSnapshot | undefined): string {
  if (!event) {
    return '(missing)';
  }
  const cycle = event.cycle === undefined ? '' : `${event.cycle}@`;
  const target = event.kind === 'grf' ? `$${event.target}` : `*${event.target}`;
  return `${cycle}${event.pc}: ${target} <= ${event.value} (line ${event.lineNumber})`;
}
