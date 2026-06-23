import * as path from 'path';
import * as vscode from 'vscode';
import { continuousCounts, ContinuousCounts, ContinuousRunStatus } from './courseTesting/continuous';
import { logisimPrepSummary, LogisimPrepareCaseResult } from './courseTesting/logisimPrep';
import { P7ProbeCheckResult } from './courseTesting/p7ProbeCheck';
import { LogisimRomTarget } from './language/logisim/rom';
import { TraceDiffSnapshot, TraceEventSnapshot } from './language/mips/traceCompare';
import { escapeHtml } from './language/common/util';
import { AsmCaseManifest } from './asmCaseStoreCore';

export type CourseTraceStatus = 'passed' | 'failed' | 'error';
export type CourseTraceStage = 'dump' | 'mars' | 'isim' | 'logisim' | 'compare' | 'probe';

export interface CourseTraceCaseResult {
  asm: string;
  stdin?: string;
  caseId?: string;
  caseManifest?: string;
  asmSnapshot?: string;
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
  generator: string;
  commandLine: string;
  cwd: string;
  options: {
    intervalMs: number;
    maxIterations: number;
    stopOnFailure: boolean;
  };
  iterations: ContinuousTraceIteration[];
}

export interface AsmCaseManifestEntry {
  manifest: AsmCaseManifest;
  uri: vscode.Uri;
}

export const continuousTraceMonitorMaxRows = 100;

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
  const visibleIterations = report.iterations.slice(0, continuousTraceMonitorMaxRows);
  const hiddenIterations = Math.max(0, report.iterations.length - visibleIterations.length);
  const rows = visibleIterations.map((iteration) => {
    const firstProblem = iteration.results.find((item) => item.status !== 'passed');
    return `<tr class="${iteration.status}">
      <td>${iteration.index}</td>
      <td>${iteration.status.toUpperCase()}</td>
      <td>${escapeHtml(iteration.startedAt)}</td>
      <td>${iteration.finishedAt ? escapeHtml(iteration.finishedAt) : ''}</td>
      <td>${iteration.summary.total}</td>
      <td>${iteration.summary.passed}</td>
      <td>${iteration.summary.failed}</td>
      <td>${iteration.summary.errors}</td>
      <td>${firstProblem ? escapeHtml(path.basename(firstProblem.asm)) : ''}</td>
      <td>${firstProblem ? escapeHtml(firstProblem.message) : escapeHtml(iteration.message ?? '')}</td>
    </tr>`;
  }).join('\n');
  const hiddenNote = hiddenIterations
    ? `<p class="muted">仅显示最近 ${visibleIterations.length} / ${report.iterations.length} 轮，完整历史保存在 JSON 报告中。</p>`
    : '';
  const state = report.running ? (report.stopRequested ? '正在停止' : '运行中') : '已停止';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h1 {
      font-size: 22px;
      margin: 0 0 16px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }
    .metric {
      border: 1px solid var(--vscode-panel-border);
      padding: 10px;
    }
    .metric strong {
      display: block;
      font-size: 18px;
    }
    .paths {
      margin: 0 0 16px;
      color: var(--vscode-descriptionForeground);
    }
    .muted {
      color: var(--vscode-descriptionForeground);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 7px;
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
    }
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
    code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <h1>持续测试</h1>
  <div class="summary">
    <div class="metric"><span>状态</span><strong>${escapeHtml(state)}</strong></div>
    <div class="metric"><span>轮数</span><strong>${report.iterations.length}</strong></div>
    <div class="metric"><span>最近通过</span><strong>${latestSummary.passed}</strong></div>
    <div class="metric"><span>最近失败</span><strong>${latestSummary.failed}</strong></div>
    <div class="metric"><span>最近错误</span><strong>${latestSummary.errors}</strong></div>
  </div>
  <div class="paths">
    <div>生成器: <code>${escapeHtml(report.generator)}</code></div>
    <div>命令: <code>${escapeHtml(report.commandLine)}</code></div>
    <div>工作目录: <code>${escapeHtml(report.cwd)}</code></div>
    <div>选项: 间隔 ${report.options.intervalMs} 毫秒, 最大 ${report.options.maxIterations || '无限制'}, 失败时停止 ${report.options.stopOnFailure}</div>
    <div>JSON 报告: <code>${escapeHtml(reportFile.fsPath)}</code></div>
  </div>
  ${hiddenNote}
  <table>
    <thead>
      <tr><th>#</th><th>状态</th><th>开始</th><th>结束</th><th>总数</th><th>通过</th><th>失败</th><th>错误</th><th>首个问题</th><th>消息</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

export function renderBatchTraceReport(
  results: CourseTraceCaseResult[],
  report: vscode.Uri,
  generatedAt?: string,
  source?: CourseTraceBatchSource
): string {
  const summary = batchSummary(results);
  const rows = results.map((item, index) => `<tr class="${item.status}">
    <td>${index + 1}</td>
    <td>${item.status.toUpperCase()}</td>
    <td>${item.caseId ? `<code>${escapeHtml(item.caseId)}</code>` : ''}</td>
    <td>${escapeHtml(path.basename(item.asm))}</td>
    <td>${item.stdin ? escapeHtml(path.basename(item.stdin)) : ''}</td>
    <td>${escapeHtml(item.stage)}</td>
    <td>${item.firstDiffIndex === undefined ? '' : item.firstDiffIndex + 1}</td>
    <td>${renderFirstDiffSummary(item)}</td>
    <td>${escapeHtml(summaryText(item))}</td>
    <td>${escapeHtml(item.message)}</td>
  </tr>`).join('\n');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h1 {
      font-size: 22px;
      margin: 0 0 16px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }
    .metric {
      border: 1px solid var(--vscode-panel-border);
      padding: 10px;
    }
    .metric strong {
      display: block;
      font-size: 18px;
    }
    .paths {
      margin: 0 0 16px;
      color: var(--vscode-descriptionForeground);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 7px;
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
    }
    .passed td:nth-child(2) {
      color: var(--vscode-testing-iconPassed);
      font-weight: 600;
    }
    .failed td:nth-child(2), .error td:nth-child(2) {
      color: var(--vscode-testing-iconFailed);
      font-weight: 600;
    }
    code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <h1>CO 批量 Trace 测试</h1>
  <div class="summary">
    <div class="metric"><span>总数</span><strong>${summary.total}</strong></div>
    <div class="metric"><span>通过</span><strong>${summary.passed}</strong></div>
    <div class="metric"><span>失败</span><strong>${summary.failed}</strong></div>
    <div class="metric"><span>错误</span><strong>${summary.errors}</strong></div>
  </div>
  ${generatedAt ? `<div class="paths">生成时间: <code>${escapeHtml(generatedAt)}</code></div>` : ''}
  ${renderBatchSource(source)}
  <div class="paths">JSON 报告: <code>${escapeHtml(report.fsPath)}</code></div>
  <table>
    <thead>
      <tr><th>#</th><th>状态</th><th>Case</th><th>ASM</th><th>输入</th><th>阶段</th><th>首个差异</th><th>首个差异详情</th><th>事件</th><th>消息</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

export function renderLogisimPrepareReport(
  report: vscode.Uri,
  results: LogisimPrepareCaseResult[],
  source: CourseTraceBatchSource,
  circuit: vscode.Uri,
  target: LogisimRomTarget
): string {
  const summary = logisimPrepSummary(results);
  const rows = results.map((item, index) => `<tr class="${item.status}">
    <td>${index + 1}</td>
    <td>${item.status.toUpperCase()}</td>
    <td>${item.caseId ? `<code>${escapeHtml(item.caseId)}</code>` : ''}</td>
    <td>${escapeHtml(path.basename(item.asm))}</td>
    <td>${item.wordCount ?? ''}</td>
    <td>${item.circuit ? `<code>${escapeHtml(item.circuit)}</code>` : ''}</td>
    <td>${escapeHtml(item.message)}</td>
  </tr>`).join('\n');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h1 {
      font-size: 22px;
      margin: 0 0 16px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }
    .metric {
      border: 1px solid var(--vscode-panel-border);
      padding: 10px;
    }
    .metric strong {
      display: block;
      font-size: 18px;
    }
    .paths {
      margin: 0 0 16px;
      color: var(--vscode-descriptionForeground);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 7px;
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
    }
    .prepared td:nth-child(2) {
      color: var(--vscode-testing-iconPassed);
      font-weight: 600;
    }
    .error td:nth-child(2) {
      color: var(--vscode-testing-iconFailed);
      font-weight: 600;
    }
    code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <h1>CO Logisim 用例准备</h1>
  <div class="summary">
    <div class="metric"><span>总数</span><strong>${summary.total}</strong></div>
    <div class="metric"><span>已准备</span><strong>${summary.prepared}</strong></div>
    <div class="metric"><span>错误</span><strong>${summary.errors}</strong></div>
  </div>
  ${renderBatchSource(source)}
  <div class="paths">
    <div>电路模板: <code>${escapeHtml(circuit.fsPath)}</code></div>
    <div>ROM 目标: <code>${escapeHtml(target.label ?? 'ROM')} #${target.index}${target.loc ? ` ${target.loc}` : ''}</code></div>
    <div>JSON 报告: <code>${escapeHtml(report.fsPath)}</code></div>
  </div>
  <table>
    <thead>
      <tr><th>#</th><th>状态</th><th>Case</th><th>ASM</th><th>字数</th><th>已准备电路</th><th>消息</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

export function renderBatchSource(source: CourseTraceBatchSource | undefined): string {
  if (!source) {
    return '';
  }
  if (source.kind !== 'generator') {
    return '<div class="paths">来源: 手动选择的 ASM 文件</div>';
  }
  const asmCount = source.asmFiles?.length ?? 0;
  return `<div class="paths">
    <div>来源: 生成的 ASM 文件${asmCount ? ` (${asmCount})` : ''}</div>
    ${source.generator ? `<div>生成器: <code>${escapeHtml(source.generator)}</code></div>` : ''}
    ${source.commandLine ? `<div>命令: <code>${escapeHtml(source.commandLine)}</code></div>` : ''}
    ${source.cwd ? `<div>工作目录: <code>${escapeHtml(source.cwd)}</code></div>` : ''}
  </div>`;
}

export function renderAsmCaseIndex(cases: AsmCaseManifestEntry[]): string {
  const rows = cases.map(({ manifest, uri }) => {
    const artifacts = Object.entries(manifest.artifacts ?? {})
      .flatMap(([kind, items]) => Object.entries(items ?? {}).map(([name, value]) => `${kind}.${name}: ${value}`))
      .slice(0, 6);
    return `<tr>
      <td><code>${escapeHtml(manifest.caseId)}</code></td>
      <td>${escapeHtml(manifest.createdAt)}</td>
      <td>${escapeHtml(manifest.profile)}</td>
      <td>${escapeHtml(manifest.source.kind)}</td>
      <td><code>${escapeHtml(manifest.originalAsmPath)}</code></td>
      <td><code>${escapeHtml(manifest.asmSnapshot.path)}</code></td>
      <td>${manifest.machineCode ? `<code>${escapeHtml(manifest.machineCode.path)}</code>` : ''}</td>
      <td>${artifacts.map((item) => `<div><code>${escapeHtml(item)}</code></div>`).join('')}</td>
      <td><code>${escapeHtml(uri.fsPath)}</code></td>
    </tr>`;
  }).join('\n');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    h1 { font-size: 22px; margin: 0 0 16px; }
    .summary { margin: 0 0 16px; color: var(--vscode-descriptionForeground); }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 7px; text-align: left; vertical-align: top; }
    th { position: sticky; top: 0; background: var(--vscode-editor-background); }
    code { background: var(--vscode-textCodeBlock-background); padding: 2px 4px; word-break: break-word; }
  </style>
</head>
<body>
  <h1>CO ASM 用例记录</h1>
  <div class="summary">共 ${cases.length} 个 case，按创建时间倒序排列。</div>
  <table>
    <thead>
      <tr><th>Case</th><th>时间</th><th>Profile</th><th>来源</th><th>原始 ASM</th><th>ASM 快照</th><th>机器码</th><th>Artifacts</th><th>Manifest</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
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

function renderFirstDiffSummary(item: CourseTraceCaseResult): string {
  if (item.probe) {
    return renderProbeDetails(item.probe);
  }
  if (!item.firstDiff) {
    return '';
  }
  const reason = item.firstDiff.reason ?? item.firstDiff.status;
  return [
    `<div>${escapeHtml(reason)}</div>`,
    `<div><code>MARS ${escapeHtml(traceEventSummary(item.firstDiff.mars))}</code></div>`,
    `<div><code>SIM ${escapeHtml(traceEventSummary(item.firstDiff.sim))}</code></div>`
  ].join('');
}

function renderProbeDetails(probe: P7ProbeCheckResult): string {
  const failures = probe.failures.slice(0, 5).map((failure) =>
    `<div><code>#${failure.scenarioId} ${escapeHtml(failure.kind)}: ${escapeHtml(failure.message)}</code></div>`
  );
  const records = probe.records.slice(0, 5).map((record) =>
    `<div><code>#${record.scenarioId}: Cause=0x${(record.cause >>> 0).toString(16)} EPC=0x${(record.epc >>> 0).toString(16)} aux0=0x${(record.aux0 >>> 0).toString(16)}</code></div>`
  );
  return [...failures, ...records].join('');
}

function traceEventSummary(event: TraceEventSnapshot | undefined): string {
  if (!event) {
    return '(missing)';
  }
  const cycle = event.cycle === undefined ? '' : `${event.cycle}@`;
  const target = event.kind === 'grf' ? `$${event.target}` : `*${event.target}`;
  return `${cycle}${event.pc}: ${target} <= ${event.value} (line ${event.lineNumber})`;
}
