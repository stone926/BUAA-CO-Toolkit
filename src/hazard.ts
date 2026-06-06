import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getHazardCalculator, getPython } from './config';
import { ensureDirectory } from './fsUtil';
import { runTool } from './process';
import { AppServices } from './types';
import { pickOneFile } from './workflowInputs';

interface HazardToolPaths {
  dir: string;
  jar: string;
  analyzer: string;
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

function findWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    return vscode.workspace.getWorkspaceFolder(editor.document.uri);
  }
  return vscode.workspace.workspaceFolders?.[0];
}

async function runHazardAnalysis(services: AppServices): Promise<void> {
  const setup = resolveHazardDir();
  if (!setup) {
    return;
  }

  const python = getPython();
  if (!python) {
    vscode.window.showErrorMessage('Python 未配置。请设置 co.toolchain.python');
    return;
  }

  const folder = findWorkspaceFolder();
  if (!folder) {
    vscode.window.showErrorMessage('请先打开一个工作区文件夹');
    return;
  }

  const outDir = vscode.Uri.file(path.join(folder.uri.fsPath, '.co', 'hazard'));
  await ensureDirectory(outDir);

  services.output.show(true);
  services.output.appendLine('');
  services.output.appendLine(`冲突分析工具：${setup.dir}`);
  services.output.appendLine(`输出目录：${outDir.fsPath}`);

  const result = await runTool(python, [setup.analyzer], {
    cwd: setup.dir,
    output: services.output,
    stdin: 'Ya\n'
  });
  if (!result.ok) {
    vscode.window.showErrorMessage('冲突分析失败。请查看北航 CO 输出面板');
    return;
  }

  await copyHazardResults(setup.dir, outDir.fsPath);

  const report = findHazardReportIn(path.join(outDir.fsPath, 'result'));
  const choice = await vscode.window.showInformationMessage('冲突分析完成', '打开报告');
  if (choice === '打开报告' && report) {
    await vscode.window.showTextDocument(vscode.Uri.file(report));
  }
}

async function copyHazardResults(toolDir: string, outDir: string): Promise<void> {
  const resultSrc = path.join(toolDir, 'result');
  const workSrc = path.join(toolDir, 'work');

  const resultDst = path.join(outDir, 'result');
  const workDst = path.join(outDir, 'work');

  if (fs.existsSync(resultSrc)) {
    await copyDirectory(resultSrc, resultDst);
  }
  if (fs.existsSync(workSrc)) {
    await copyDirectory(workSrc, workDst);
  }
}

async function copyDirectory(src: string, dst: string): Promise<void> {
  await fs.promises.mkdir(dst, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, dstPath);
    } else {
      await fs.promises.copyFile(srcPath, dstPath);
    }
  }
}

async function openHazardReport(): Promise<void> {
  const folder = findWorkspaceFolder();
  const reportDir = folder ? path.join(folder.uri.fsPath, '.co', 'hazard', 'result') : undefined;
  const report = reportDir ? findHazardReportIn(reportDir) : undefined;
  if (report) {
    await vscode.window.showTextDocument(vscode.Uri.file(report));
    return;
  }
  const picked = await pickOneFile('选择冲突报告 JSON 文件', {
    JSON: ['json'],
    All: ['*']
  });
  if (picked) {
    await vscode.window.showTextDocument(picked);
  }
}

function findHazardReportIn(directory: string): string | undefined {
  if (!fs.existsSync(directory)) {
    return undefined;
  }
  const candidates = [
    ...fs.readdirSync(directory)
      .filter((f) => f.endsWith('_statistic_hazard.json'))
      .map((f) => path.join(directory, f)),
    path.join(directory, 'hazard_statistic.json'),
    path.join(directory, 'hazard.json')
  ];
  return candidates.find((file) => fs.existsSync(file));
}
