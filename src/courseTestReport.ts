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
  manifestArtifactsOf,
  manifestMachineCodeOf,
  manifestSourceOf
} from './courseTesting/manifestCodec';
import { html, renderMetricGrid, renderReportPage, renderTable, SafeHtml } from './webview/reportLayout';

const escapeHtml = html.text;

export type CourseTraceStatus = 'passed' | 'failed' | 'error';
export type ExecutorShadowReportStatus = 'matched' | 'not-comparable' | 'course-correct' | 'mars-compatible' | 'inconclusive';

export interface CourseTraceShadowSummary {
  status: ExecutorShadowReportStatus;
  message: string;
  bundleDir?: string;
  resultFile?: string;
  legacyEvents?: number;
  builtinEvents?: number;
  disposition?: string;
  contractId?: string;
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
  /** Phase-4 executor shadow evidence; absent unless verify-both was requested. */
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
  generator: string;
  commandLine: string;
  cwd: string;
  options: {
    intervalMs: number;
    maxIterations: number;
    stopOnFailure: boolean;
  };
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

/** Typed empty map so Object.entries keeps its string value overload. */
const EMPTY_STRING_MAP: Record<string, string> = {};

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
  const neutralResults = results.map(neutralCourseTraceCaseResult);
  return {
    schemaVersion: 2,
    generatedAt,
    ...(source ? { source } : {}),
    summary: batchSummary(neutralResults),
    results: neutralResults
  };
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
  const panel = vscode.window.createWebviewPanel('coBatchTraceReport', 'CO 批量 Trace 测试', vscode.ViewColumn.Beside, {
    enableScripts: false
  });
  panel.webview.html = renderBatchTraceReport(results, report, generatedAt, source);
}

export function renderContinuousTraceMonitor(report: ContinuousTraceReport, reportFile: vscode.Uri): string {
  const latest = report.iterations[0];
  const latestSummary = latest?.summary ?? continuousCounts([]);
  const totalIterations = report.totalIterations ?? report.iterations.length;
  const visibleIterations = report.iterations.slice(0, continuousTraceMonitorMaxRows);
  const hiddenIterations = Math.max(0, totalIterations - visibleIterations.length);
  const rows = visibleIterations.map((iteration) => {
    const firstProblem = iteration.results.find((item) => item.status !== 'passed');
    const pruned = !firstProblem && iteration.results.some((item) => item.artifactsPruned);
    return {
      className: iteration.status,
      cells: [
        String(iteration.index),
        escapeHtml(iteration.status.toUpperCase()),
        escapeHtml(iteration.startedAt),
        iteration.finishedAt ? escapeHtml(iteration.finishedAt) : '',
        String(iteration.summary.total),
        String(iteration.summary.passed),
        String(iteration.summary.failed),
        String(iteration.summary.errors),
        firstProblem ? escapeHtml(path.basename(firstProblem.asm)) : '',
        firstProblem ? escapeHtml(firstProblem.message) : escapeHtml(iteration.message ?? (pruned ? '通过产物已按留存策略清理' : ''))
      ]
    };
  });
  const hiddenNote = hiddenIterations
    ? html.raw(`<p class="muted">仅显示最近 ${html.text(visibleIterations.length)} / ${html.text(totalIterations)} 轮；旧通过轮可能已从 JSON 报告和 case 产物中清理。</p>`)
    : html.raw('');
  const retentionNote = report.retention
    ? html.raw(`<div>留存: 通过 case 最近 ${html.text(report.retention.retainedPassingCases)} 个，报告最近 ${html.text(report.retention.reportRetainedIterations || '无限制')} 轮，输出 ${html.text(report.retention.artifactOutputMode === 'case' ? '写入 ASM case' : '写入 .co/out')}</div>`)
    : html.raw('');
  const state = report.running ? (report.stopRequested ? '正在停止' : '运行中') : '已停止';

  return renderReportPage({
    title: '持续测试',
    extraCss: traceStatusCss,
    body: html.raw(`
  ${renderMetricGrid([
    { label: '状态', value: state },
    { label: '轮数', value: totalIterations },
    { label: '最近通过', value: latestSummary.passed },
    { label: '最近失败', value: latestSummary.failed },
    { label: '最近错误', value: latestSummary.errors }
  ])}
  <div class="paths">
    <div>生成器: <code>${escapeHtml(report.generator)}</code></div>
    <div>命令: <code>${escapeHtml(report.commandLine)}</code></div>
    <div>工作目录: <code>${escapeHtml(report.cwd)}</code></div>
    <div>选项: 间隔 ${report.options.intervalMs} 毫秒, 最大 ${report.options.maxIterations || '无限制'}, 失败时停止 ${report.options.stopOnFailure}</div>
    ${retentionNote}
    <div>JSON 报告: <code>${escapeHtml(reportFile.fsPath)}</code></div>
  </div>
  ${hiddenNote}
  ${renderTable(['#', '状态', '开始', '结束', '总数', '通过', '失败', '错误', '首个问题', '消息'], rows)}
`)
  });
}

export function renderBatchTraceReport(
  results: CourseTraceCaseResult[],
  report: vscode.Uri,
  generatedAt?: string,
  source?: CourseTraceBatchSource
): string {
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
    <div>来源: 生成的 ASM 文件${asmCount ? ` (${asmCount})` : ''}</div>
    ${source.generator ? `<div>生成器: ${html.code(source.generator)}</div>` : ''}
    ${source.commandLine ? `<div>命令: ${html.code(source.commandLine)}</div>` : ''}
    ${source.cwd ? `<div>工作目录: ${html.code(source.cwd)}</div>` : ''}
  </div>`);
}

export function renderAsmCaseIndex(cases: AsmCaseManifestEntry[]): string {
  const rows = cases.map(({ manifest, uri }) => {
    // v2 stores case-relative artifact paths; restore absolute ones for display.
    const caseDir = path.dirname(uri.fsPath);
    const resolveArtifact = (value: string): string =>
      path.isAbsolute(value) ? value : path.join(caseDir, value);
    // Record-shaped view keeps Object.entries on its string overload.
    const artifactGroups: Record<string, Record<string, string> | undefined> = manifestArtifactsOf(manifest);
    const artifacts = Object.entries(artifactGroups)
      .flatMap(([kind, items]) => Object.entries(items ?? EMPTY_STRING_MAP)
        .map(([name, value]) => `${kind}.${name}: ${resolveArtifact(value)}`))
      .slice(0, 6);
    const machineCode = manifestMachineCodeOf(manifest);
    return {
      cells: [
        html.code(manifest.caseId),
        escapeHtml(manifest.createdAt),
        escapeHtml(manifest.profile),
        escapeHtml(manifestSourceOf(manifest).kind),
        html.code(manifest.originalAsmPath),
        html.code(manifest.asmSnapshot.path),
        machineCode ? html.code(resolveArtifact(machineCode.path)) : '',
        html.raw(artifacts.map((item) => `<div>${html.code(item)}</div>`).join('')),
        html.code(uri.fsPath)
      ]
    };
  });
  return renderReportPage({
    title: 'CO ASM 用例记录',
    body: html.raw(`
  <div class="summary">共 ${cases.length} 个 case，按创建时间倒序排列。</div>
  ${renderTable(['Case', '时间', 'Profile', '来源', '原始 ASM', 'ASM 快照', '机器码', 'Artifacts', 'Manifest'], rows)}
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
    ['DUT Raw', dutRawOut === dutOut ? undefined : dutRawOut]
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
