import * as vscode from 'vscode';
import { compareTraces, TraceDiffEntry, TraceDiffResult } from './language/mips/traceCompare';
import { CpuTraceEvent, parseMarsOutput } from './language/mips/traceParser';
import { parseSimOutput } from './language/verilog/traceParser';
import { fileMtimeMs, readTextFile, workspaceFolderFor } from './fsUtil';
import { revealOutputChannel } from './process';
import { AppServices } from './types';
import { pickOneFile } from './workflowInputs';
import { escapeHtml } from './language/common/util';

export interface CompareMode {
  label: string;
  description: string;
  compareCycles: boolean;
}

export interface TraceFilePair {
  mars: vscode.Uri;
  sim: vscode.Uri;
}

export const defaultTraceCompareMode: CompareMode = {
  label: '忽略周期/时间',
  description: '仅比较 PC、目标和值',
  compareCycles: false
};

export function registerTraceCompare(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('co.test.compareTraceFiles', () => compareTraceFiles(services)),
    vscode.commands.registerCommand('co.test.compareLatestOutputs', () => compareLatestOutputs(services))
  );
}

async function compareTraceFiles(services: AppServices): Promise<void> {
  const mars = await pickOneFile('选择 MARS 答案 Trace 输出', {
    Text: ['txt', 'out', 'log'],
    All: ['*']
  });
  if (!mars) {
    return;
  }
  const sim = await pickOneFile('选择仿真器 Trace 输出', {
    Text: ['txt', 'out', 'log'],
    All: ['*']
  });
  if (!sim) {
    return;
  }
  await compareTracePair({ mars, sim }, services);
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
      '在当前工作区中未找到 .co/out/*.mars.out 和 .co/out/*.sim.out',
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

  const marsText = await readTextFile(pair.mars);
  const simText = await readTextFile(pair.sim);
  const marsEvents = parseMarsOutput(marsText);
  const simEvents = parseSimOutput(simText);
  const diff = compareTraces(marsEvents, simEvents, { compareCycles: selectedMode.compareCycles });

  revealOutputChannel(services.output);
  services.output.appendLine('');
  services.output.appendLine('Trace 比较');
  services.output.appendLine(`MARS: ${pair.mars.fsPath}`);
  services.output.appendLine(`SIM:  ${pair.sim.fsPath}`);
  services.output.appendLine(`模式: ${selectedMode.label}`);
  services.output.appendLine(`事件: MARS ${diff.summary.marsEvents}, SIM ${diff.summary.simEvents}, 匹配 ${diff.summary.matchedEvents}, 差异 ${diff.summary.diffEvents}`);
  if (diff.firstDiffIndex >= 0) {
    const first = diff.entries[diff.firstDiffIndex];
    services.output.appendLine(`首个差异位于事件 #${diff.firstDiffIndex + 1}: ${first.reason ?? first.status}`);
  }

  showTraceCompareReport(pair, diff, selectedMode, marsEvents, simEvents);
  if (!marsEvents.length || !simEvents.length) {
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
  const mars = await findLatestFile(folder, '.co/out/*.mars.out');
  const sim = await findLatestFile(folder, '.co/out/*.sim.out');
  if (!mars || !sim) {
    return undefined;
  }
  return { mars, sim };
}

async function findLatestFile(folder: vscode.WorkspaceFolder, pattern: string): Promise<vscode.Uri | undefined> {
  const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), undefined, 100);
  const existing = (await Promise.all(files.map(async (uri) => {
    const mtime = await fileMtimeMs(uri.fsPath);
    return mtime === undefined ? undefined : { uri, mtime };
  })))
    .filter((item): item is { uri: vscode.Uri; mtime: number } => Boolean(item))
    .sort((left, right) => right.mtime - left.mtime);
  return existing[0]?.uri;
}

function showTraceCompareReport(
  pair: TraceFilePair,
  diff: TraceDiffResult,
  mode: CompareMode,
  marsEvents: CpuTraceEvent[],
  simEvents: CpuTraceEvent[]
): void {
  const panel = vscode.window.createWebviewPanel('coTraceCompare', 'CO Trace 比较', vscode.ViewColumn.Beside, {
    enableScripts: false
  });
  panel.webview.html = renderTraceCompareReport(pair, diff, mode, marsEvents, simEvents);
}

function renderTraceCompareReport(
  pair: TraceFilePair,
  diff: TraceDiffResult,
  mode: CompareMode,
  marsEvents: CpuTraceEvent[],
  simEvents: CpuTraceEvent[]
): string {
  const visible = visibleEntries(diff);
  const rows = visible.entries.map(renderDiffRow).join('\n');
  const firstDiff = diff.firstDiffIndex >= 0 ? `#${diff.firstDiffIndex + 1}` : '无';
  const hiddenNote = visible.hidden
    ? `<p class="muted">显示首个差异附近的 ${visible.entries.length} / ${diff.entries.length} 个事件。</p>`
    : '';
  const parseWarning = !marsEvents.length || !simEvents.length
    ? '<p class="warn-text">其中一侧没有可解析的 Trace 事件。请检查输出是否包含类似 <code>@00003000: $3 &lt;= 00000000</code> 或 <code>100@00003000: *00001004 &lt;= 00000000</code> 的行。</p>'
    : '';

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
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
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
    code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .ok td:first-child {
      color: var(--vscode-testing-iconPassed);
    }
    .diff td:first-child, .mars-only td:first-child, .sim-only td:first-child, .cycle-diff td:first-child {
      color: var(--vscode-testing-iconFailed);
      font-weight: 600;
    }
    .muted {
      color: var(--vscode-descriptionForeground);
    }
    .warn-text {
      color: var(--vscode-testing-iconFailed);
    }
  </style>
</head>
<body>
  <h1>CO Trace 比较</h1>
  <div class="summary">
    <div class="metric"><span>状态</span><strong>${diff.matched ? '匹配' : '不同'}</strong></div>
    <div class="metric"><span>MARS 事件</span><strong>${diff.summary.marsEvents}</strong></div>
    <div class="metric"><span>SIM 事件</span><strong>${diff.summary.simEvents}</strong></div>
    <div class="metric"><span>首个差异</span><strong>${firstDiff}</strong></div>
  </div>
  <div class="paths">
    <div>模式: ${escapeHtml(mode.label)}</div>
    <div>MARS: <code>${escapeHtml(pair.mars.fsPath)}</code></div>
    <div>SIM: <code>${escapeHtml(pair.sim.fsPath)}</code></div>
  </div>
  ${parseWarning}
  ${hiddenNote}
  <table>
    <thead>
      <tr><th>状态</th><th>#</th><th>原因</th><th>MARS</th><th>SIM</th></tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;
}

function visibleEntries(diff: TraceDiffResult): { entries: TraceDiffEntry[]; hidden: boolean } {
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

function renderDiffRow(entry: TraceDiffEntry): string {
  return `<tr class="${entry.status}">
    <td>${entry.status.toUpperCase()}</td>
    <td>${entry.index + 1}</td>
    <td>${escapeHtml(entry.reason ?? '')}</td>
    <td>${renderEvent(entry.mars)}</td>
    <td>${renderEvent(entry.sim)}</td>
  </tr>`;
}

function renderEvent(event?: CpuTraceEvent): string {
  if (!event) {
    return '<span class="muted">(missing)</span>';
  }
  const cycle = event.cycle === undefined ? '' : `cycle=${event.cycle} `;
  const target = event.kind === 'grf' ? `$${event.target}` : `*${event.target}`;
  const normalized = `${cycle}pc=${event.pc} ${target} <= ${event.value}`;
  return `<div><code>${escapeHtml(event.raw)}</code></div><div class="muted">${escapeHtml(normalized)}; line ${event.lineNumber}</div>`;
}
