import { Commands } from './constants';
import * as vscode from 'vscode';
import { compareTraces, firstTraceDiffEntry, TraceDiffEntry, TraceDiffResult } from './language/mips/traceCompare';
import { CpuTraceEvent, parseMarsOutput } from './language/mips/traceParser';
import { parseSimOutput } from './language/verilog/traceParser';
import { fileMtimeMs, readTextFile, workspaceFolderFor } from './fsUtil';
import { revealOutputChannel } from './process';
import { AppServices } from './types';
import { findWorkspaceFileCandidates, resolveFileInput } from './workflowInputs';
import { html, renderMetricGrid, renderReportPage, renderTable, ReportTableRow, SafeHtml } from './webview/reportLayout';

const escapeHtml = html.text;

export interface CompareMode {
  label: string;
  description: string;
  compareCycles: boolean;
}

export type TraceFilePair =
  | { oracle: vscode.Uri; dut: vscode.Uri; mars?: never; sim?: never }
  /** Legacy API shape retained for callers and reports created before schema v2. */
  | { mars: vscode.Uri; sim: vscode.Uri; oracle?: never; dut?: never };

export const defaultTraceCompareMode: CompareMode = {
  label: '忽略周期/时间',
  description: '仅比较 PC、目标和值',
  compareCycles: false
};

export function registerTraceCompare(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.Test.CompareTraceFiles, () => compareTraceFiles(services)),
    vscode.commands.registerCommand(Commands.Test.CompareLatestOutputs, () => compareLatestOutputs(services))
  );
}

async function compareTraceFiles(services: AppServices): Promise<void> {
  const oracle = await resolveFileInput({
    title: '选择 Oracle Trace 输出',
    active: false,
    filters: {
      Text: ['txt', 'out', 'log'],
      All: ['*']
    }
  });
  if (!oracle) {
    return;
  }
  const dut = await resolveFileInput({
    title: '选择 DUT Trace 输出',
    active: false,
    filters: {
      Text: ['txt', 'out', 'log'],
      All: ['*']
    }
  });
  if (!dut) {
    return;
  }
  await compareTracePair({ oracle, dut }, services);
}

async function compareLatestOutputs(services: AppServices): Promise<void> {
  const folder = workspaceFolderFor(vscode.window.activeTextEditor?.document.uri);
  if (!folder) {
    vscode.window.showErrorMessage('比较 Trace 输出前请先打开一个工作区文件夹');
    return;
  }
  const pair = await findLatestTracePair(folder);
  if (!pair) {
    const choice = await vscode.window.showWarningMessage(
      '在当前工作区中未找到现有 Oracle/DUT Trace 产物（*.mars.out / *.sim.out）',
      '手动选择文件'
    );
    if (choice === '手动选择文件') {
      await compareTraceFiles(services);
    }
    return;
  }
  await compareTracePair(pair, services);
}

export async function compareTracePair(
  pair: TraceFilePair,
  services: AppServices,
  mode?: CompareMode
): Promise<TraceDiffResult | undefined> {
  const selectedMode = mode ?? (await pickCompareMode());
  if (!selectedMode) {
    return undefined;
  }

  const { oracle, dut } = traceFileSides(pair);
  const oracleText = await readTextFile(oracle);
  const dutText = await readTextFile(dut);
  const oracleEvents = parseMarsOutput(oracleText);
  const dutEvents = parseSimOutput(dutText);
  const diff = compareTraces(oracleEvents, dutEvents, { compareCycles: selectedMode.compareCycles });

  revealOutputChannel(services.output);
  services.output.appendLine('');
  services.output.appendLine('Trace 比较');
  services.output.appendLine(`Oracle: ${oracle.fsPath}`);
  services.output.appendLine(`DUT:    ${dut.fsPath}`);
  services.output.appendLine(`模式: ${selectedMode.label}`);
  services.output.appendLine(`事件: Oracle ${diff.summary.oracleEvents}, DUT ${diff.summary.dutEvents}, 匹配 ${diff.summary.matchedEvents}, 差异 ${diff.summary.diffEvents}`);
  if (diff.firstDiffIndex >= 0) {
    const first = firstTraceDiffEntry(diff);
    services.output.appendLine(`首个差异位于事件 #${diff.firstDiffIndex + 1}: ${first?.reason ?? first?.status ?? 'unknown diff'}`);
  }

  showTraceCompareReport(pair, diff, selectedMode, oracleEvents, dutEvents);
  if (!oracleEvents.length || !dutEvents.length) {
    vscode.window.showWarningMessage('Trace 比较完成，但其中一侧没有可解析的 Trace 事件');
  } else if (diff.matched) {
    vscode.window.showInformationMessage(`Trace 比较通过：${diff.summary.matchedEvents} 个事件匹配`);
  } else {
    vscode.window.showWarningMessage(`Trace 比较在事件 #${diff.firstDiffIndex + 1} 发现首个差异`);
  }
  return diff;
}

async function pickCompareMode(): Promise<CompareMode | undefined> {
  return await vscode.window.showQuickPick(
    [
      defaultTraceCompareMode,
      {
        label: '比较周期/时间',
        description: '同时要求可选的前导周期/时间字段匹配',
        compareCycles: true
      }
    ],
    {
      title: '选择 Trace 比较模式'
    }
  );
}

async function findLatestTracePair(folder: vscode.WorkspaceFolder): Promise<TraceFilePair | undefined> {
  const oracle = await findLatestFile(folder, '.co/out/*.mars.out');
  const dut = await findLatestFile(folder, '.co/out/*.sim.out');
  if (!oracle || !dut) {
    return undefined;
  }
  return { oracle, dut };
}

function traceFileSides(pair: TraceFilePair): { oracle: vscode.Uri; dut: vscode.Uri } {
  if (pair.oracle && pair.dut) {
    return { oracle: pair.oracle, dut: pair.dut };
  }
  if (pair.mars && pair.sim) {
    return { oracle: pair.mars, dut: pair.sim };
  }
  throw new Error('Trace comparison requires both oracle and DUT files.');
}

async function findLatestFile(folder: vscode.WorkspaceFolder, pattern: string): Promise<vscode.Uri | undefined> {
  const candidates = await findWorkspaceFileCandidates({
    folder,
    include: pattern,
    maxResults: 100,
    predicate: async (uri) => await fileMtimeMs(uri.fsPath) !== undefined,
    rank: async (uri) => -(await fileMtimeMs(uri.fsPath) ?? 0)
  });
  return candidates[0]?.uri;
}

function showTraceCompareReport(
  pair: TraceFilePair,
  diff: TraceDiffResult,
  mode: CompareMode,
  oracleEvents: CpuTraceEvent[],
  dutEvents: CpuTraceEvent[]
): void {
  const panel = vscode.window.createWebviewPanel('coTraceCompare', 'CO Trace 比较', vscode.ViewColumn.Beside, {
    enableScripts: false
  });
  panel.webview.html = renderTraceCompareReport(pair, diff, mode, oracleEvents, dutEvents);
}

function renderTraceCompareReport(
  pair: TraceFilePair,
  diff: TraceDiffResult,
  mode: CompareMode,
  oracleEvents: CpuTraceEvent[],
  dutEvents: CpuTraceEvent[]
): string {
  const sides = traceFileSides(pair);
  const visible = visibleEntries(diff);
  const rows = visible.entries.map(renderDiffRow);
  const firstDiff = diff.firstDiffIndex >= 0 ? `#${diff.firstDiffIndex + 1}` : '无';
  const hiddenNote = visible.hidden
    ? `<p class="muted">显示首个差异附近的 ${visible.entries.length} / ${totalEntryCount(diff)} 个事件。</p>`
    : '';
  const parseWarning = !oracleEvents.length || !dutEvents.length
    ? '<p class="warn-text">其中一侧没有可解析的 Trace 事件。请检查输出是否包含类似 <code>@00003000: $3 &lt;= 00000000</code> 或 <code>100@00003000: *00001004 &lt;= 00000000</code> 的行。</p>'
    : '';

  return renderReportPage({
    title: 'CO Trace 比较',
    extraCss: traceCompareCss,
    body: html.raw(`
  ${renderMetricGrid([
    { label: '状态', value: diff.matched ? '匹配' : '不同' },
    { label: 'Oracle 事件', value: diff.summary.oracleEvents ?? diff.summary.marsEvents },
    { label: 'DUT 事件', value: diff.summary.dutEvents ?? diff.summary.simEvents },
    { label: '首个差异', value: firstDiff }
  ])}
  <div class="paths">
    <div>模式: ${escapeHtml(mode.label)}</div>
    <div>Oracle: <code>${escapeHtml(sides.oracle.fsPath)}</code></div>
    <div>DUT: <code>${escapeHtml(sides.dut.fsPath)}</code></div>
  </div>
  ${parseWarning}
  ${hiddenNote}
  ${renderTable(['状态', '#', '原因', 'Oracle', 'DUT'], rows)}
`)
  });
}

function visibleEntries(diff: TraceDiffResult): { entries: TraceDiffEntry[]; hidden: boolean } {
  if (diff.entriesTruncated) {
    const first = firstTraceDiffEntry(diff);
    if (first && !diff.entries.some((entry) => entry.index === first.index)) {
      return { entries: [...diff.entries.slice(0, 249), first], hidden: true };
    }
    return { entries: diff.entries, hidden: true };
  }
  if (diff.entries.length <= 250) {
    return { entries: diff.entries, hidden: false };
  }
  if (diff.firstDiffIndex < 0) {
    return { entries: diff.entries.slice(0, 250), hidden: true };
  }
  const start = Math.max(0, diff.firstDiffIndex - 80);
  const end = Math.min(diff.entries.length, diff.firstDiffIndex + 81);
  return { entries: diff.entries.slice(start, end), hidden: true };
}

function totalEntryCount(diff: TraceDiffResult): number {
  return Math.max(
    diff.summary.oracleEvents ?? diff.summary.marsEvents,
    diff.summary.dutEvents ?? diff.summary.simEvents
  );
}

function renderDiffRow(entry: TraceDiffEntry): ReportTableRow {
  return {
    className: entry.status,
    cells: [
      escapeHtml(entry.status.toUpperCase()),
      String(entry.index + 1),
      escapeHtml(entry.reason ?? ''),
      renderEvent(entry.oracle ?? entry.mars),
      renderEvent(entry.dut ?? entry.sim)
    ]
  };
}

function renderEvent(event?: CpuTraceEvent): SafeHtml {
  if (!event) {
    return html.raw('<span class="muted">(missing)</span>');
  }
  const cycle = event.cycle === undefined ? '' : `cycle=${event.cycle} `;
  const target = event.kind === 'grf' ? `$${event.target}` : `*${event.target}`;
  const normalized = `${cycle}pc=${event.pc} ${target} <= ${event.value}`;
  return html.raw(`<div>${html.code(event.raw)}</div><div class="muted">${html.text(normalized)}; line ${html.text(event.lineNumber)}</div>`);
}

const traceCompareCss = `
    code {
      white-space: pre-wrap;
    }
    .ok td:first-child {
      color: var(--vscode-testing-iconPassed);
    }
    .diff td:first-child, .oracle-only td:first-child, .dut-only td:first-child,
    .mars-only td:first-child, .sim-only td:first-child, .cycle-diff td:first-child {
      color: var(--vscode-testing-iconFailed);
      font-weight: 600;
    }
    .warn-text {
      color: var(--vscode-testing-iconFailed);
    }
`;
