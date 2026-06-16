import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureConcreteProfile, getHazardCalculator, getMachineCode, getProfile, resolvePython } from './config';
import { ensureDirectory, readTextFile, workspaceFolderFor } from './fsUtil';
import { runMarsFile } from './mips';
import { revealOutputChannel, runTool } from './process';
import { AppServices, ProjectProfile } from './types';
import { pickOneFile } from './workflowInputs';
import { escapeHtml } from './language/common/util';

interface HazardToolPaths {
  dir: string;
  jar: string;
  analyzer: string;
}

type HazardAnalysisProject = 'P5' | 'P6';

interface PreparedHazardRun {
  rootDir: string;
  workDir: string;
  resultDir: string;
  analyzer: string;
  jar: string;
  machineCode: string;
  outerZip: string;
  caseName: string;
  profile: ProjectProfile;
  project: HazardAnalysisProject;
}

interface HazardGradeSection {
  average?: unknown;
  warning?: unknown;
  details?: unknown;
}

interface HazardStatisticReport {
  forward_valid_ratio?: unknown;
  forward_count?: unknown;
  stall_count?: unknown;
  forward_coverage?: unknown;
  stall_coverage?: unknown;
  grade?: {
    forward?: HazardGradeSection;
    stall?: HazardGradeSection;
  };
  forward?: unknown;
  stall?: unknown;
}

interface HazardCaseReport {
  forwarding?: unknown;
  stalling?: unknown;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

export function registerHazard(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('co.hazard.analyzeCurrentMachineCode', () => runHazardAnalysis(services)),
    vscode.commands.registerCommand('co.hazard.openReport', () => openHazardReport())
  );
}

function resolveHazardDir(resource?: vscode.Uri): HazardToolPaths | undefined {
  const dir = getHazardCalculator(resource);
  if (!dir) {
    vscode.window.showErrorMessage(
      '冲突分析工具目录未配置。请设置 co.toolchain.hazardCalculator'
    );
    return undefined;
  }
  const jar = path.join(dir, 'Hazard-Calculator.jar');
  const analyzer = path.join(dir, 'analyzer.py');
  if (!fs.existsSync(jar)) {
    vscode.window.showErrorMessage(`未找到 Hazard-Calculator.jar：${dir}`);
    return undefined;
  }
  if (!fs.existsSync(analyzer)) {
    vscode.window.showErrorMessage(`未找到 analyzer.py：${dir}`);
    return undefined;
  }
  return { dir, jar, analyzer };
}

function findWorkspaceFolder(resource?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return workspaceFolderFor(resource) ?? vscode.workspace.workspaceFolders?.[0];
}

async function runHazardAnalysis(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);

  const resource = vscode.window.activeTextEditor?.document.uri;
  const folder = findWorkspaceFolder(resource);
  if (!folder) {
    vscode.window.showErrorMessage('请先打开一个工作区文件夹');
    return;
  }
  if (!await ensureConcreteProfile(resource ?? folder.uri, '运行 Hazard 分析需要先确定项目 Profile')) {
    return;
  }

  const setup = resolveHazardDir(resource ?? folder.uri);
  if (!setup) {
    return;
  }

  const python = await resolvePython(resource ?? folder.uri);
  if (!python) {
    vscode.window.showErrorMessage('Python 未配置。请设置 co.toolchain.python');
    return;
  }

  const machineCode = await resolveMachineCodeForHazard(services, folder, resource);
  if (!machineCode) {
    return;
  }

  const prepared = await prepareHazardWorkspace(setup, folder, machineCode, resource ?? folder.uri);

  revealOutputChannel(services.output, resource);
  services.output.appendLine('');
  services.output.appendLine(`冲突分析工具：${setup.dir}`);
  services.output.appendLine(`工作目录：${prepared.rootDir}`);
  services.output.appendLine(`机器码：${prepared.machineCode}`);
  services.output.appendLine(`用例包：${prepared.outerZip}`);
  services.output.appendLine(`分析模型：${prepared.project}${prepared.profile === 'P7' ? ' (P7 使用 P6 hazard 模型)' : ''}`);

  const result = await runTool(python, [path.basename(prepared.analyzer)], {
    cwd: prepared.rootDir,
    output: services.output,
    resource: resource ?? folder.uri,
    stdin: 'Ya\n'
  });
  if (!result.ok) {
    vscode.window.showErrorMessage('冲突分析失败。请查看插件输出面板');
    return;
  }

  const report = findHazardReportIn(prepared.resultDir);
  if (!report) {
    vscode.window.showWarningMessage('冲突分析完成，但未找到统计报告 JSON');
    return;
  }

  await showHazardReportWebview(vscode.Uri.file(report), prepared);
  vscode.window.showInformationMessage('冲突分析完成');
}

async function resolveMachineCodeForHazard(
  services: AppServices,
  folder: vscode.WorkspaceFolder,
  resource?: vscode.Uri
): Promise<vscode.Uri | undefined> {
  const active = vscode.window.activeTextEditor?.document;
  if (active && active.uri.scheme === 'file' && active.languageId === 'mipsasm') {
    const dump = await runMarsFile(services, active.uri, 'dumpText', {
      showMessages: false,
      revealOutput: false
    });
    if (dump?.result.ok && dump.outputFile) {
      return dump.outputFile;
    }
    vscode.window.showWarningMessage('MARS 导出机器码失败，将尝试使用已有机器码文件');
  }

  const configured = getMachineCode(resource ?? folder.uri);
  const candidates: string[] = [];
  if (resource?.scheme === 'file' && path.basename(resource.fsPath).toLowerCase() === path.basename(configured).toLowerCase()) {
    candidates.push(resource.fsPath);
  }
  if (path.isAbsolute(configured)) {
    candidates.push(configured);
  }
  if (resource?.scheme === 'file') {
    candidates.push(path.resolve(path.dirname(resource.fsPath), configured));
  }
  candidates.push(path.resolve(folder.uri.fsPath, configured));

  for (const candidate of dedupePaths(candidates)) {
    if (safeIsFile(candidate)) {
      return vscode.Uri.file(candidate);
    }
  }

  const matches = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, `**/${path.basename(configured)}`),
    '**/{node_modules,out,.git,.co}/**',
    50
  );
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    const picked = await vscode.window.showQuickPick(
      matches.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        description: path.dirname(uri.fsPath),
        uri
      })),
      {
        title: '选择用于 Hazard 分析的机器码文件',
        matchOnDescription: true
      }
    );
    return picked?.uri;
  }

  return await pickOneFile('选择用于 Hazard 分析的机器码文件', {
    Text: ['txt', 'hex', 'coe'],
    All: ['*']
  });
}

async function prepareHazardWorkspace(
  setup: HazardToolPaths,
  folder: vscode.WorkspaceFolder,
  machineCode: vscode.Uri,
  resource: vscode.Uri
): Promise<PreparedHazardRun> {
  const rootDir = path.join(folder.uri.fsPath, '.co', 'hazard');
  const workDir = path.join(rootDir, 'work');
  const resultDir = path.join(rootDir, 'result');
  await ensureDirectory(vscode.Uri.file(rootDir));
  await resetDirectory(workDir);
  await resetDirectory(resultDir);

  const jar = path.join(rootDir, 'Hazard-Calculator.jar');
  const analyzer = path.join(rootDir, 'analyzer.py');
  await copyFileIfDifferent(setup.jar, jar);
  await copyFileIfDifferent(setup.analyzer, analyzer);

  const profile = getProfile(resource);
  const project = hazardProjectForProfile(profile);
  const setName = `${project}_${sanitizeFileStem(folder.name)}`;
  const caseName = `${setName}_${sanitizeFileStem(path.basename(machineCode.fsPath, path.extname(machineCode.fsPath)))}`;
  const codeBytes = Buffer.from(await vscode.workspace.fs.readFile(machineCode));
  const innerZip = createZip([{ name: 'code.txt', data: codeBytes }]);
  const outerZipBytes = createZip([{ name: `${caseName}.zip`, data: innerZip }]);
  const outerZip = path.join(workDir, `${setName}.zip`);
  await fs.promises.writeFile(outerZip, outerZipBytes);

  return {
    rootDir,
    workDir,
    resultDir,
    analyzer,
    jar,
    machineCode: machineCode.fsPath,
    outerZip,
    caseName,
    profile,
    project
  };
}

function hazardProjectForProfile(profile: ProjectProfile): HazardAnalysisProject {
  return profile === 'P5' ? 'P5' : 'P6';
}

async function resetDirectory(directory: string): Promise<void> {
  await fs.promises.rm(directory, { recursive: true, force: true });
  await fs.promises.mkdir(directory, { recursive: true });
}

async function copyFileIfDifferent(src: string, dst: string): Promise<void> {
  if (samePath(src, dst)) {
    return;
  }
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });
  await fs.promises.copyFile(src, dst);
}

async function openHazardReport(): Promise<void> {
  const folder = findWorkspaceFolder(vscode.window.activeTextEditor?.document.uri);
  const reportDir = folder ? path.join(folder.uri.fsPath, '.co', 'hazard', 'result') : undefined;
  const report = reportDir ? findHazardReportIn(reportDir) : undefined;
  if (report) {
    await showHazardReportWebview(vscode.Uri.file(report));
    return;
  }
  const picked = await pickOneFile('选择冲突报告 JSON 文件', {
    JSON: ['json'],
    All: ['*']
  });
  if (picked) {
    await showHazardReportWebview(picked);
  }
}

function findHazardReportIn(directory: string): string | undefined {
  if (!fs.existsSync(directory)) {
    return undefined;
  }
  const statisticReports = fs.readdirSync(directory)
    .filter((file) => file.endsWith('_statistic_hazard.json'))
    .map((file) => path.join(directory, file))
    .filter((file) => fs.existsSync(file))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  const candidates = [
    ...statisticReports,
    path.join(directory, 'hazard_statistic.json'),
    path.join(directory, 'hazard.json')
  ];
  return candidates.find((file) => fs.existsSync(file));
}

async function showHazardReportWebview(report: vscode.Uri, prepared?: PreparedHazardRun): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readTextFile(report));
  } catch {
    vscode.window.showErrorMessage('所选 Hazard 报告不是有效的 JSON');
    return;
  }

  const panel = vscode.window.createWebviewPanel('coHazardReport', 'CO Hazard 分析', vscode.ViewColumn.Beside, {
    enableScripts: false
  });
  panel.webview.html = renderHazardReport(parsed, report, prepared);
}

function renderHazardReport(report: unknown, reportFile: vscode.Uri, prepared?: PreparedHazardRun): string {
  const body = isStatisticReport(report)
    ? renderStatisticReport(report)
    : isCaseReport(report)
      ? renderCaseReport(report)
      : renderUnknownReport(report);
  const preparedInfo = prepared ? `
    <div class="paths">
      <div>机器码: <code>${escapeHtml(prepared.machineCode)}</code></div>
      <div>工作目录: <code>${escapeHtml(prepared.rootDir)}</code></div>
      <div>用例: <code>${escapeHtml(prepared.caseName)}</code></div>
      <div>模型: <code>${escapeHtml(prepared.project)}${prepared.profile === 'P7' ? ' (P7 使用 P6 hazard 模型)' : ''}</code></div>
    </div>` : '';

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
    h2 {
      font-size: 16px;
      margin: 22px 0 10px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }
    .metric {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 10px;
    }
    .metric span {
      color: var(--vscode-descriptionForeground);
    }
    .metric strong {
      display: block;
      font-size: 18px;
      margin-top: 4px;
    }
    .bar {
      height: 6px;
      margin-top: 8px;
      background: var(--vscode-editorWidget-background);
      border-radius: 999px;
      overflow: hidden;
    }
    .bar > i {
      display: block;
      height: 100%;
      background: var(--vscode-testing-iconPassed);
    }
    .paths {
      margin: 0 0 16px;
      color: var(--vscode-descriptionForeground);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 12px;
    }
    .chip {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 2px 8px;
      color: var(--vscode-descriptionForeground);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 18px;
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
      word-break: break-word;
    }
    .ok {
      color: var(--vscode-testing-iconPassed);
      font-weight: 600;
    }
    .warn {
      color: var(--vscode-testing-iconFailed);
      font-weight: 600;
    }
  </style>
</head>
<body>
  <h1>CO Hazard 分析</h1>
  ${preparedInfo}
  <div class="paths">JSON 报告: <code>${escapeHtml(reportFile.fsPath)}</code></div>
  ${body}
</body>
</html>`;
}

function renderStatisticReport(report: HazardStatisticReport): string {
  const forwardGrade = gradeSection(report.grade?.forward);
  const stallGrade = gradeSection(report.grade?.stall);
  return `
  <div class="summary">
    ${renderMetric('转发有效率', formatPercent(report.forward_valid_ratio), percentValue(report.forward_valid_ratio))}
    ${renderMetric('转发覆盖率', formatPercent(report.forward_coverage), percentValue(report.forward_coverage))}
    ${renderMetric('阻塞覆盖率', formatPercent(report.stall_coverage), percentValue(report.stall_coverage))}
    ${renderMetric('转发种类', formatNumber(report.forward_count))}
    ${renderMetric('阻塞种类', formatNumber(report.stall_count))}
    ${renderMetric('转发评分', formatGrade(forwardGrade.average))}
    ${renderMetric('阻塞评分', formatGrade(stallGrade.average))}
  </div>
  ${renderWarningList('未测试到的转发', forwardGrade.warning)}
  ${renderWarningList('未测试到的阻塞', stallGrade.warning)}
  ${renderGradeDetails(forwardGrade.details, stallGrade.details)}
  ${renderForwardTable(asArray(report.forward))}
  ${renderStallTable(asArray(report.stall))}
  `;
}

function renderCaseReport(report: HazardCaseReport): string {
  const forwarding = asArray(report.forwarding);
  const stalling = asArray(report.stalling);
  const validForwarding = forwarding.filter((item) => asRecord(item).valid === true).length;
  const realStalling = stalling.filter((item) => asRecord(item).cause !== 'none').length;
  return `
  <div class="summary">
    ${renderMetric('转发事件', String(forwarding.length))}
    ${renderMetric('有效转发', String(validForwarding))}
    ${renderMetric('阻塞事件', String(stalling.length))}
    ${renderMetric('真实阻塞', String(realStalling))}
  </div>
  ${renderRawForwardingTable(forwarding)}
  ${renderRawStallingTable(stalling)}
  `;
}

function renderUnknownReport(report: unknown): string {
  return `<p class="paths">无法识别该 JSON 的 Hazard 报告结构。</p>
  <pre><code>${escapeHtml(JSON.stringify(report, null, 2).slice(0, 8000))}</code></pre>`;
}

function renderMetric(label: string, value: string, percent?: number): string {
  const bar = percent === undefined ? '' : `<div class="bar"><i style="width: ${Math.max(0, Math.min(100, percent * 100)).toFixed(1)}%"></i></div>`;
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${bar}</div>`;
}

function renderWarningList(title: string, warnings: unknown[]): string {
  if (!warnings.length) {
    return `<h2>${escapeHtml(title)}</h2><div class="chips"><span class="chip ok">无缺失项</span></div>`;
  }
  return `<h2>${escapeHtml(title)}</h2><div class="chips">${warnings.map((item) => `<span class="chip warn">${escapeHtml(String(item))}</span>`).join('')}</div>`;
}

function renderGradeDetails(forwardDetails: Record<string, unknown>, stallDetails: Record<string, unknown>): string {
  const keys = [...new Set([...Object.keys(forwardDetails), ...Object.keys(stallDetails)])].sort();
  if (!keys.length) {
    return '';
  }
  const rows = keys.map((key) => `<tr>
    <td><code>${escapeHtml(key)}</code></td>
    <td>${formatGrade(forwardDetails[key])}</td>
    <td>${formatGrade(stallDetails[key])}</td>
  </tr>`).join('\n');
  return `<h2>分类覆盖评分</h2>
  <table>
    <thead><tr><th>指令类别依赖</th><th>转发</th><th>阻塞</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderForwardTable(items: unknown[]): string {
  if (!items.length) {
    return '';
  }
  const rows = items.map((item) => {
    const row = asRecord(item);
    return `<tr>
      <td><code>${escapeHtml(row.src_instr)}</code></td>
      <td><code>${escapeHtml(row.dst_instr)}</code></td>
      <td>${escapeHtml(row.src_stage)}</td>
      <td>${escapeHtml(row.dst_stage)}</td>
    </tr>`;
  }).join('\n');
  return `<h2>转发覆盖</h2>
  <table>
    <thead><tr><th>供给指令</th><th>需求指令</th><th>供给级</th><th>需求级</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderStallTable(items: unknown[]): string {
  if (!items.length) {
    return '';
  }
  const rows = items.map((item) => {
    const row = asRecord(item);
    return `<tr>
      <td><code>${escapeHtml(row.d_instr)}</code></td>
      <td><code>${escapeHtml(row.cause)}</code></td>
      <td>${escapeHtml(row.interval ?? '')}</td>
    </tr>`;
  }).join('\n');
  return `<h2>阻塞覆盖</h2>
  <table>
    <thead><tr><th>D 级指令</th><th>冲突来源</th><th>间隔</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderRawForwardingTable(items: unknown[]): string {
  const visible = items.slice(0, 200);
  const rows = visible.map((item) => {
    const row = asRecord(item);
    const forward = asRecord(row.forward);
    const oldValue = asRecord(forward.old);
    const newValue = asRecord(forward.new);
    const view = asRecord(row.view);
    return `<tr>
      <td class="${row.valid ? 'ok' : 'warn'}">${row.valid ? 'VALID' : 'INVALID'}</td>
      <td>${escapeHtml(forward.reg ?? '')}</td>
      <td>${escapeHtml(oldValue.stage ?? '')} -> ${escapeHtml(newValue.stage ?? '')}</td>
      <td><code>${escapeHtml(stageInstr(view, 'd'))}</code></td>
      <td><code>${escapeHtml(stageInstr(view, 'e'))}</code></td>
      <td><code>${escapeHtml(stageInstr(view, 'm'))}</code></td>
      <td><code>${escapeHtml(stageInstr(view, 'w'))}</code></td>
    </tr>`;
  }).join('\n');
  const hidden = items.length > visible.length ? `<div class="paths">仅显示前 ${visible.length} 条，共 ${items.length} 条。</div>` : '';
  return `<h2>逐周期转发事件</h2>${hidden}
  <table>
    <thead><tr><th>状态</th><th>寄存器</th><th>级间</th><th>D</th><th>E</th><th>M</th><th>W</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderRawStallingTable(items: unknown[]): string {
  const visible = items.slice(0, 200);
  const rows = visible.map((item) => {
    const row = asRecord(item);
    const view = asRecord(row.view);
    return `<tr>
      <td class="${row.cause === 'none' ? 'ok' : 'warn'}">${escapeHtml(row.cause ?? '')}</td>
      <td><code>${escapeHtml(stageInstr(view, 'd'))}</code></td>
      <td><code>${escapeHtml(stageInstr(view, 'e'))}</code></td>
      <td><code>${escapeHtml(stageInstr(view, 'm'))}</code></td>
      <td><code>${escapeHtml(stageInstr(view, 'w'))}</code></td>
    </tr>`;
  }).join('\n');
  const hidden = items.length > visible.length ? `<div class="paths">仅显示前 ${visible.length} 条，共 ${items.length} 条。</div>` : '';
  return `<h2>逐周期阻塞事件</h2>${hidden}
  <table>
    <thead><tr><th>来源</th><th>D</th><th>E</th><th>M</th><th>W</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function stageInstr(view: Record<string, unknown>, stage: string): string {
  return String(asRecord(view[stage]).instr ?? '');
}

function isStatisticReport(value: unknown): value is HazardStatisticReport {
  const record = asRecord(value);
  return 'forward_coverage' in record || 'stall_coverage' in record || 'forward_count' in record;
}

function isCaseReport(value: unknown): value is HazardCaseReport {
  const record = asRecord(value);
  return Array.isArray(record.forwarding) || Array.isArray(record.stalling);
}

function gradeSection(section: HazardGradeSection | undefined): {
  average?: unknown;
  warning: unknown[];
  details: Record<string, unknown>;
} {
  return {
    average: section?.average,
    warning: asArray(section?.warning),
    details: asStringRecord(section?.details)
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asStringRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  return Object.fromEntries(Object.entries(record).filter(([key]) => typeof key === 'string'));
}

function formatPercent(value: unknown): string {
  const numeric = numericValue(value);
  return numeric === undefined ? 'N/A' : `${(numeric * 100).toFixed(1)}%`;
}

function percentValue(value: unknown): number | undefined {
  return numericValue(value);
}

function formatGrade(value: unknown): string {
  const numeric = numericValue(value);
  return numeric === undefined ? '-' : numeric.toFixed(1);
}

function formatNumber(value: unknown): string {
  const numeric = numericValue(value);
  if (numeric === undefined) {
    return '-';
  }
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2);
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.toLowerCase() !== 'nan') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function createZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralDirectory.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }

  const centralOffset = offset;
  const centralSize = centralDirectory.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...centralDirectory, end]);
}

const crcTable = makeCrcTable();

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[i] = value >>> 0;
  }
  return table;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dedupePaths(files: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const file of files) {
    const key = normalizePathKey(file);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(file);
  }
  return result;
}

function safeIsFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  return normalizePathKey(left) === normalizePathKey(right);
}

function normalizePathKey(file: string): string {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sanitizeFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'case';
}
