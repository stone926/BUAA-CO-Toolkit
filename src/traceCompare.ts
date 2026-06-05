import * as fs from 'fs';
import * as vscode from 'vscode';
import { compareTraces, TraceDiffEntry, TraceDiffResult } from './language/mips/traceCompare';
import { CpuTraceEvent, parseMarsOutput } from './language/mips/traceParser';
import { parseSimOutput } from './language/verilog/traceParser';
import { readTextFile, workspaceFolderFor } from './fsUtil';
import { AppServices } from './types';
import { pickOneFile } from './workflowInputs';

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
  label: 'Ignore cycle/time',
  description: 'Compare PC, target, and value only.',
  compareCycles: false
};

export function registerTraceCompare(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('co.test.compareTraceFiles', () => compareTraceFiles(services)),
    vscode.commands.registerCommand('co.test.compareLatestOutputs', () => compareLatestOutputs(services))
  );
}

async function compareTraceFiles(services: AppServices): Promise<void> {
  const mars = await pickOneFile('Select MARS answer trace output', {
    Text: ['txt', 'out', 'log'],
    All: ['*']
  });
  if (!mars) {
    return;
  }
  const sim = await pickOneFile('Select simulator trace output', {
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
    vscode.window.showErrorMessage('Open a workspace folder before comparing trace outputs.');
    return;
  }
  const pair = await findLatestTracePair(folder);
  if (!pair) {
    const choice = await vscode.window.showWarningMessage(
      'Could not find both .co/out/*.mars.out and .co/out/*.sim.out in this workspace.',
      'Pick Files'
    );
    if (choice === 'Pick Files') {
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

  services.output.show(true);
  services.output.appendLine('');
  services.output.appendLine('Trace compare');
  services.output.appendLine(`MARS: ${pair.mars.fsPath}`);
  services.output.appendLine(`SIM:  ${pair.sim.fsPath}`);
  services.output.appendLine(`Mode: ${selectedMode.label}`);
  services.output.appendLine(`Events: MARS ${diff.summary.marsEvents}, SIM ${diff.summary.simEvents}, matched ${diff.summary.matchedEvents}, differences ${diff.summary.diffEvents}`);
  if (diff.firstDiffIndex >= 0) {
    const first = diff.entries[diff.firstDiffIndex];
    services.output.appendLine(`First difference at event #${diff.firstDiffIndex + 1}: ${first.reason ?? first.status}`);
  }

  showTraceCompareReport(pair, diff, selectedMode, marsEvents, simEvents);
  if (!marsEvents.length || !simEvents.length) {
    vscode.window.showWarningMessage('Trace compare completed, but one side had no parseable trace events.');
  } else if (diff.matched) {
    vscode.window.showInformationMessage(`Trace compare passed: ${diff.summary.matchedEvents} events matched.`);
  } else {
    vscode.window.showWarningMessage(`Trace compare found first difference at event #${diff.firstDiffIndex + 1}.`);
  }
  return diff;
}

async function pickCompareMode(): Promise<CompareMode | undefined> {
  return await vscode.window.showQuickPick(
    [
      defaultTraceCompareMode,
      {
        label: 'Compare cycle/time',
        description: 'Also require the optional leading cycle/time field to match.',
        compareCycles: true
      }
    ],
    {
      title: 'Select trace compare mode'
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
  const existing = files
    .filter((uri) => fs.existsSync(uri.fsPath))
    .map((uri) => ({
      uri,
      mtime: fs.statSync(uri.fsPath).mtimeMs
    }))
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
  const panel = vscode.window.createWebviewPanel('coTraceCompare', 'CO Trace Compare', vscode.ViewColumn.Beside, {
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
  const firstDiff = diff.firstDiffIndex >= 0 ? `#${diff.firstDiffIndex + 1}` : 'None';
  const hiddenNote = visible.hidden
    ? `<p class="muted">Showing ${visible.entries.length} of ${diff.entries.length} events around the first difference.</p>`
    : '';
  const parseWarning = !marsEvents.length || !simEvents.length
    ? '<p class="warn-text">One side has no parseable trace events. Check that the output contains lines like <code>@00003000: $3 &lt;= 00000000</code> or <code>100@00003000: *00001004 &lt;= 00000000</code>.</p>'
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
  <h1>CO Trace Compare</h1>
  <div class="summary">
    <div class="metric"><span>Status</span><strong>${diff.matched ? 'Matched' : 'Different'}</strong></div>
    <div class="metric"><span>MARS events</span><strong>${diff.summary.marsEvents}</strong></div>
    <div class="metric"><span>SIM events</span><strong>${diff.summary.simEvents}</strong></div>
    <div class="metric"><span>First difference</span><strong>${firstDiff}</strong></div>
  </div>
  <div class="paths">
    <div>Mode: ${escapeHtml(mode.label)}</div>
    <div>MARS: <code>${escapeHtml(pair.mars.fsPath)}</code></div>
    <div>SIM: <code>${escapeHtml(pair.sim.fsPath)}</code></div>
  </div>
  ${parseWarning}
  ${hiddenNote}
  <table>
    <thead>
      <tr><th>Status</th><th>#</th><th>Reason</th><th>MARS</th><th>SIM</th></tr>
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
