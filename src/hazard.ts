import { Commands, CO_HAZARD_DIR } from './constants';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureConcreteProfile, getHazardCalculator, getMachineCode, getProfile, resolvePython } from './config';
import { ensureDirectory, fileMtimeMs, isDirectory, isFile, readTextFile, workspaceFolderForOrFirst } from './fsUtil';
import { assembleWithPreflight } from './mips/providers/providerResolver';
import { revealOutputChannel, runTool } from './process';
import { AppServices, ProjectProfile } from './types';
import { resolveFileInput } from './workflowInputs';
import { dedupePaths, samePath, sanitizeFileStem } from './pathUtils';
import { html, renderReportPage, renderTable, SafeHtml } from './webview/reportLayout';

const escapeHtml = html.text;

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
    vscode.commands.registerCommand(Commands.Hazard.AnalyzeCurrentMachineCode, () => runHazardAnalysis(services)),
    vscode.commands.registerCommand(Commands.Hazard.OpenReport, () => openHazardReport())
  );
}

async function resolveHazardDir(resource?: vscode.Uri): Promise<HazardToolPaths | undefined> {
  const dir = getHazardCalculator(resource);
  if (!dir) {
    vscode.window.showErrorMessage(
      '冲突分析工具目录未配置。请设置 co.toolchain.hazardCalculator'
    );
    return undefined;
  }
  const jar = path.join(dir, 'Hazard-Calculator.jar');
  const analyzer = path.join(dir, 'analyzer.py');
  if (!await isFile(jar)) {
    vscode.window.showErrorMessage(`未找到 Hazard-Calculator.jar：${dir}`);
    return undefined;
  }
  if (!await isFile(analyzer)) {
    vscode.window.showErrorMessage(`未找到 analyzer.py：${dir}`);
    return undefined;
  }
  return { dir, jar, analyzer };
}

function findWorkspaceFolder(resource?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return workspaceFolderForOrFirst(resource);
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

  const setup = await resolveHazardDir(resource ?? folder.uri);
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

  const report = await findHazardReportIn(prepared.resultDir);
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
    const invocation = await assembleWithPreflight(services, {
      sourceUri: active.uri,
      target: { kind: 'userText' },
      revealOutput: false
    });
    if (invocation.result?.ok && invocation.result.outputFile) {
      return invocation.result.outputFile;
    }
    vscode.window.showWarningMessage('课程汇编器导出机器码失败，将尝试使用已有机器码文件');
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

  return await resolveFileInput({
    title: '选择用于 Hazard 分析的机器码文件',
    active: {
      predicate: (uri) => path.basename(uri.fsPath).toLowerCase() === path.basename(configured).toLowerCase()
    },
    folder,
    include: `**/${path.basename(configured)}`,
    exclude: '**/{node_modules,out,.git,.co}/**',
    maxResults: 50,
    candidatePaths: dedupePaths(candidates),
    predicate: async (uri) => await isFile(uri.fsPath),
    filters: {
      Text: ['txt', 'hex', 'coe'],
      All: ['*']
    }
  });
}

async function prepareHazardWorkspace(
  setup: HazardToolPaths,
  folder: vscode.WorkspaceFolder,
  machineCode: vscode.Uri,
  resource: vscode.Uri
): Promise<PreparedHazardRun> {
  const rootDir = path.join(folder.uri.fsPath, CO_HAZARD_DIR);
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
  const report = reportDir ? await findHazardReportIn(reportDir) : undefined;
  if (report) {
    await showHazardReportWebview(vscode.Uri.file(report));
    return;
  }
  const picked = await resolveFileInput({
    title: '选择冲突报告 JSON 文件',
    active: false,
    filters: {
      JSON: ['json'],
      All: ['*']
    }
  });
  if (picked) {
    await showHazardReportWebview(picked);
  }
}

async function findHazardReportIn(directory: string): Promise<string | undefined> {
  if (!await isDirectory(directory)) {
    return undefined;
  }
  const statisticReports = await hazardStatisticReports(directory);
  const candidates = [
    ...statisticReports,
    path.join(directory, 'hazard_statistic.json'),
    path.join(directory, 'hazard.json')
  ];
  for (const file of candidates) {
    if (await isFile(file)) {
      return file;
    }
  }
  return undefined;
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

export function renderHazardReport(report: unknown, reportFile: vscode.Uri, prepared?: PreparedHazardRun): string {
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

  return renderReportPage({
    title: 'CO Hazard 分析',
    extraCss: hazardReportCss,
    body: html.raw(`
  ${preparedInfo}
  <div class="paths">JSON 报告: <code>${escapeHtml(reportFile.fsPath)}</code></div>
  ${body}
`)
  });
}

const hazardReportCss = `
    h2 {
      margin: 22px 0 10px;
    }
    .metric {
      border-radius: 6px;
    }
    .metric span {
      color: var(--vscode-descriptionForeground);
    }
    .metric strong {
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
      margin-bottom: 18px;
    }
    .ok {
      color: var(--vscode-testing-iconPassed);
      font-weight: 600;
    }
    .warn {
      color: var(--vscode-testing-iconFailed);
      font-weight: 600;
    }
`;

function renderStatisticReport(report: HazardStatisticReport): SafeHtml {
  const forwardGrade = gradeSection(report.grade?.forward);
  const stallGrade = gradeSection(report.grade?.stall);
  return html.raw(`
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
  `);
}

function renderCaseReport(report: HazardCaseReport): SafeHtml {
  const forwarding = asArray(report.forwarding);
  const stalling = asArray(report.stalling);
  const validForwarding = forwarding.filter((item) => asRecord(item).valid === true).length;
  const realStalling = stalling.filter((item) => asRecord(item).cause !== 'none').length;
  return html.raw(`
  <div class="summary">
    ${renderMetric('转发事件', String(forwarding.length))}
    ${renderMetric('有效转发', String(validForwarding))}
    ${renderMetric('阻塞事件', String(stalling.length))}
    ${renderMetric('真实阻塞', String(realStalling))}
  </div>
  ${renderRawForwardingTable(forwarding)}
  ${renderRawStallingTable(stalling)}
  `);
}

function renderUnknownReport(report: unknown): SafeHtml {
  return html.raw(`<p class="paths">无法识别该 JSON 的 Hazard 报告结构。</p>
  <pre><code>${html.text(JSON.stringify(report, null, 2).slice(0, 8000))}</code></pre>`);
}

function renderMetric(label: string, value: string, percent?: number): SafeHtml {
  const bar = percent === undefined ? '' : `<div class="bar"><i style="width: ${Math.max(0, Math.min(100, percent * 100)).toFixed(1)}%"></i></div>`;
  return html.raw(`<div class="metric"><span>${html.text(label)}</span><strong>${html.text(value)}</strong>${bar}</div>`);
}

function renderWarningList(title: string, warnings: unknown[]): SafeHtml {
  if (!warnings.length) {
    return html.raw(`<h2>${html.text(title)}</h2><div class="chips"><span class="chip ok">无缺失项</span></div>`);
  }
  return html.raw(`<h2>${html.text(title)}</h2><div class="chips">${warnings.map((item) => `<span class="chip warn">${html.text(String(item))}</span>`).join('')}</div>`);
}

function renderGradeDetails(forwardDetails: Record<string, unknown>, stallDetails: Record<string, unknown>): SafeHtml {
  const keys = [...new Set([...Object.keys(forwardDetails), ...Object.keys(stallDetails)])].sort();
  if (!keys.length) {
    return html.raw('');
  }
  const rows = keys.map((key) => ({
    cells: [
      html.code(key),
      formatGrade(forwardDetails[key]),
      formatGrade(stallDetails[key])
    ]
  }));
  return html.raw(`<h2>分类覆盖评分</h2>
  ${renderTable(['指令类别依赖', '转发', '阻塞'], rows)}`);
}

function renderForwardTable(items: unknown[]): SafeHtml {
  if (!items.length) {
    return html.raw('');
  }
  const rows = items.map((item) => {
    const row = asRecord(item);
    return {
      cells: [
        html.code(row.src_instr),
        html.code(row.dst_instr),
        String(row.src_stage ?? ''),
        String(row.dst_stage ?? '')
      ]
    };
  });
  return html.raw(`<h2>转发覆盖</h2>
  ${renderTable(['供给指令', '需求指令', '供给级', '需求级'], rows)}`);
}

function renderStallTable(items: unknown[]): SafeHtml {
  if (!items.length) {
    return html.raw('');
  }
  const rows = items.map((item) => {
    const row = asRecord(item);
    return {
      cells: [
        html.code(row.d_instr),
        html.code(row.cause),
        String(row.interval ?? '')
      ]
    };
  });
  return html.raw(`<h2>阻塞覆盖</h2>
  ${renderTable(['D 级指令', '冲突来源', '间隔'], rows)}`);
}

function renderRawForwardingTable(items: unknown[]): SafeHtml {
  const visible = items.slice(0, 200);
  const rows = visible.map((item) => {
    const row = asRecord(item);
    const forward = asRecord(row.forward);
    const oldValue = asRecord(forward.old);
    const newValue = asRecord(forward.new);
    const view = asRecord(row.view);
    return {
      cells: [
        html.raw(`<span class="${row.valid ? 'ok' : 'warn'}">${row.valid ? 'VALID' : 'INVALID'}</span>`),
        String(forward.reg ?? ''),
        `${String(oldValue.stage ?? '')} -> ${String(newValue.stage ?? '')}`,
        html.code(stageInstr(view, 'd')),
        html.code(stageInstr(view, 'e')),
        html.code(stageInstr(view, 'm')),
        html.code(stageInstr(view, 'w'))
      ]
    };
  });
  const hidden = items.length > visible.length ? `<div class="paths">仅显示前 ${visible.length} 条，共 ${items.length} 条。</div>` : '';
  return html.raw(`<h2>逐周期转发事件</h2>${hidden}
  ${renderTable(['状态', '寄存器', '级间', 'D', 'E', 'M', 'W'], rows)}`);
}

function renderRawStallingTable(items: unknown[]): SafeHtml {
  const visible = items.slice(0, 200);
  const rows = visible.map((item) => {
    const row = asRecord(item);
    const view = asRecord(row.view);
    return {
      cells: [
        html.raw(`<span class="${row.cause === 'none' ? 'ok' : 'warn'}">${html.text(row.cause ?? '')}</span>`),
        html.code(stageInstr(view, 'd')),
        html.code(stageInstr(view, 'e')),
        html.code(stageInstr(view, 'm')),
        html.code(stageInstr(view, 'w'))
      ]
    };
  });
  const hidden = items.length > visible.length ? `<div class="paths">仅显示前 ${visible.length} 条，共 ${items.length} 条。</div>` : '';
  return html.raw(`<h2>逐周期阻塞事件</h2>${hidden}
  ${renderTable(['来源', 'D', 'E', 'M', 'W'], rows)}`);
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

async function hazardStatisticReports(directory: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(directory);
  } catch {
    // 报告目录不可读时交给调用方回退到手动选择
    return [];
  }
  const reports = await Promise.all(
    entries
      .filter((file) => file.endsWith('_statistic_hazard.json'))
      .map(async (file) => {
        const fullPath = path.join(directory, file);
        const mtimeMs = await fileMtimeMs(fullPath);
        return mtimeMs === undefined ? undefined : { file: fullPath, mtimeMs };
      })
  );
  return reports
    .filter((item): item is { file: string; mtimeMs: number } => Boolean(item))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((item) => item.file);
}
