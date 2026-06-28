import * as path from 'path';
import * as vscode from 'vscode';
import { continuousCounts, ContinuousCounts, ContinuousRunStatus } from './courseTesting/continuous';
import { logisimPrepSummary, LogisimPrepareCaseResult } from './courseTesting/logisimPrep';
import { P7ProbeCheckResult } from './courseTesting/p7ProbeCheck';
import { LogisimRomTarget } from './language/logisim/rom';
import { TraceDiffSnapshot, TraceEventSnapshot } from './language/mips/traceCompare';
import { AsmCaseManifest } from './asmCaseStoreCore';
import { html, renderMetricGrid, renderReportPage, renderTable, SafeHtml } from './webview/reportLayout';

const escapeHtml = html.text;

export type CourseTraceStatus = 'passed' | 'failed' | 'error';
export type CourseTraceStage = 'dump' | 'mars' | 'isim' | 'logisim' | 'compare' | 'probe';

export interface CourseTraceCaseResult {
  asm: string;
  stdin?: string;
  caseId?: string;
  caseManifest?: string;
  asmSnapshot?: string;
  artifactsPruned?: boolean;
  status: CourseTraceStatus;
  stage: CourseTraceStage;
  message: string;
  machineCode?: string;
  marsOut?: string;
  simOut?: string;
  logisimOut?: string;
  logisimCircuit?: string;
  logisimRows?: number;
  firstDiffIndex?: number;
  firstDiff?: TraceDiffSnapshot;
  marsEvents?: number;
  simEvents?: number;
  matchedEvents?: number;
  diffEvents?: number;
  probe?: P7ProbeCheckResult;
}

export interface CourseTraceBatchSummary {
  total: number;
  passed: number;
  failed: number;
  errors: number;
}

export interface CourseTraceBatchReport {
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
  manifest: AsmCaseManifest;
  uri: vscode.Uri;
}

export const continuousTraceMonitorMaxRows = 100;

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
      escapeHtml(item.stage),
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
    const artifacts = Object.entries(manifest.artifacts ?? {})
      .flatMap(([kind, items]) => Object.entries(items ?? {}).map(([name, value]) => `${kind}.${name}: ${value}`))
      .slice(0, 6);
    return {
      cells: [
        html.code(manifest.caseId),
        escapeHtml(manifest.createdAt),
        escapeHtml(manifest.profile),
        escapeHtml(manifest.source.kind),
        html.code(manifest.originalAsmPath),
        html.code(manifest.asmSnapshot.path),
        manifest.machineCode ? html.code(manifest.machineCode.path) : '',
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
  if (item.marsEvents === undefined || item.simEvents === undefined) {
    return '';
  }
  return `MARS ${item.marsEvents}, SIM ${item.simEvents}, matched ${item.matchedEvents ?? 0}, diff ${item.diffEvents ?? 0}`;
}

function renderCaseArtifacts(item: CourseTraceCaseResult): SafeHtml {
  const entries = [
    ['ASM Snapshot', item.asmSnapshot],
    ['Machine Code', item.machineCode],
    ['Mars', item.marsOut],
    ['ISim', item.simOut]
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
  return html.raw([
    `<div>${html.text(reason)}</div>`,
    `<div><code>MARS ${html.text(traceEventSummary(item.firstDiff.mars))}</code></div>`,
    `<div><code>SIM ${html.text(traceEventSummary(item.firstDiff.sim))}</code></div>`
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
