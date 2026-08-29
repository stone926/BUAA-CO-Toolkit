// @index verilog-ise-project — ISE PRJ/TCL生成与项目签名
import * as path from 'path';
import * as vscode from 'vscode';
import { CO_ISIM_DIR } from '../constants';
import { ensureConcreteProfile, getSimTime, getTestbench } from '../config';
import { ensureDirectory, workspaceFolderFor, writeTextFile } from '../fsUtil';
import { AppServices } from '../types';
import {
  buildIseProjectText,
  buildIsimRunTcl,
  verilogProjectExcludeGlob
} from '../verilogSimulationFiles';
import { dedupeUris, normalizePathKey } from '../pathUtils';
import {
  orderIseProjectFiles,
  parseXiseVerilogFileOrder
} from './iseProjectOrder';

export interface IseProjectFiles {
  prj: vscode.Uri;
  tcl: vscode.Uri;
  outDir: vscode.Uri;
}

export interface IseProjectOptions {
  resource?: vscode.Uri;
  showMessages?: boolean;
  revealOutput?: boolean;
  testbenchName?: string;
  projectFileBaseName?: string;
  extraVerilogFiles?: vscode.Uri[];
  projectFiles?: vscode.Uri[];
  tclFileName?: string;
  tclText?: string;
  /** Internal automation lane: generate artifacts without exposing their private paths. */
  nonInteractive?: boolean;
}

export async function generateIseProject(
  services: AppServices,
  options: IseProjectOptions = {}
): Promise<IseProjectFiles | undefined> {
  const activeUri = options.resource ?? vscode.window.activeTextEditor?.document.uri;
  const nonInteractive = options.nonInteractive === true;
  const showMessages = !nonInteractive && options.showMessages !== false;
  if (!await ensureConcreteProfile(activeUri, '生成 ISE 工程需要先确定项目 Profile')) {
    return undefined;
  }
  const folder = workspaceFolderFor(activeUri);
  if (!folder) {
    if (!nonInteractive) {
      vscode.window.showErrorMessage('生成 ISE 文件前请先打开一个工作区文件夹');
    }
    return undefined;
  }
  const top = getTestbench(activeUri);
  const testbenchName = options.testbenchName ?? top;
  const projectFileBaseName = options.projectFileBaseName ?? testbenchName;
  const projectFiles = options.projectFiles ?? await resolveIseProjectFiles(folder, options.extraVerilogFiles);
  if (!projectFiles.length) {
    if (!nonInteractive) {
      vscode.window.showErrorMessage('工作区中未找到 Verilog 文件');
    }
    return undefined;
  }

  const outDir = vscode.Uri.file(path.join(folder.uri.fsPath, CO_ISIM_DIR));
  await ensureDirectory(outDir);
  const prj = vscode.Uri.file(path.join(outDir.fsPath, `${projectFileBaseName}.prj`));
  const tcl = vscode.Uri.file(path.join(outDir.fsPath, options.tclFileName ?? `${projectFileBaseName}.tcl`));
  const prjText = buildIseProjectText(projectFiles.map((uri) => uri.fsPath));
  const tclText = options.tclText ?? buildIsimRunTcl(getSimTime(activeUri));
  await writeTextFile(prj, prjText);
  await writeTextFile(tcl, tclText);
  if (!nonInteractive) {
    services.output.appendLine(`已生成 ${prj.fsPath}`);
    services.output.appendLine(`已生成 ${tcl.fsPath}`);
  }
  if (showMessages) {
    vscode.window.showInformationMessage('已生成 ISE PRJ/TCL 文件');
  }
  return { prj, tcl, outDir };
}

export async function resolveIseProjectFiles(
  folder: vscode.WorkspaceFolder,
  extraVerilogFiles: readonly vscode.Uri[] | undefined,
  exclusions: {
    excludedFiles?: readonly vscode.Uri[];
    excludedBasenames?: readonly string[];
    protectedFiles?: readonly vscode.Uri[];
  } = {}
): Promise<vscode.Uri[]> {
  const discovered = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.v'), verilogProjectExcludeGlob, 5000);
  const protectedKeys = new Set([
    ...(extraVerilogFiles ?? []),
    ...(exclusions.protectedFiles ?? [])
  ].map((uri) => normalizePathKey(uri.fsPath)));
  const excludedKeys = new Set((exclusions.excludedFiles ?? []).map((uri) => normalizePathKey(uri.fsPath)));
  const excludedBasenames = new Set((exclusions.excludedBasenames ?? []).map((name) => name.toLowerCase()));
  const files = discovered.filter((uri) => {
    const key = normalizePathKey(uri.fsPath);
    return protectedKeys.has(key)
      || (!excludedKeys.has(key) && !excludedBasenames.has(path.basename(uri.fsPath).toLowerCase()));
  });
  const xiseFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.xise'), verilogProjectExcludeGlob, 2);
  let xiseFileOrder: string[] = [];
  if (xiseFiles.length === 1) {
    try {
      const bytes = await vscode.workspace.fs.readFile(xiseFiles[0]);
      xiseFileOrder = parseXiseVerilogFileOrder(Buffer.from(bytes).toString('utf8'), xiseFiles[0].fsPath);
    } catch {
      // An unreadable project file must not make ISim unavailable. Stable path
      // ordering below is the deterministic fallback used without a unique XISE.
    }
  }
  return orderIseProjectFiles(files, xiseFileOrder, dedupeUris(extraVerilogFiles ?? []));
}

export async function verilogProjectSignature(files: readonly vscode.Uri[], contentSignatures = new Map<string, string>()): Promise<string> {
  const entries: string[] = [];
  for (const uri of files) {
    const key = normalizePathKey(uri.fsPath);
    const contentSignature = contentSignatures.get(key);
    if (contentSignature) {
      entries.push(`${key}:sha:${contentSignature}`);
      continue;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      entries.push(`${key}:${stat.size}:${Math.trunc(stat.mtime)}`);
    } catch {
      entries.push(`${key}:missing`);
    }
  }
  return entries.join('|');
}
