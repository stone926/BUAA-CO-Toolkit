// @index verilog-simulation-inputs — ISim 运行输入文件定位与复制
import * as path from 'path';
import * as vscode from 'vscode';
import { getMachineCode } from '../config';
import { ensureDirectory, isFile, workspaceFolderForOrFirst } from '../fsUtil';
import { dedupePaths, samePath } from '../pathUtils';

export async function resolveMachineCodeSource(resource: vscode.Uri | undefined, outDir: vscode.Uri): Promise<vscode.Uri | undefined> {
  const machineCode = getMachineCode(resource);
  const target = path.resolve(outDir.fsPath, machineCode);
  const candidates: string[] = [];
  if (path.isAbsolute(machineCode)) {
    candidates.push(machineCode);
  }
  if (resource?.scheme === 'file') {
    candidates.push(path.resolve(path.dirname(resource.fsPath), machineCode));
  }
  const folder = workspaceFolderForOrFirst(resource);
  if (folder) {
    candidates.push(path.resolve(folder.uri.fsPath, machineCode));
  }

  for (const candidate of dedupePaths(candidates)) {
    if (await isFile(candidate) && !samePath(candidate, target)) {
      return vscode.Uri.file(candidate);
    }
  }

  if (!folder) {
    return undefined;
  }
  const matches = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, `**/${path.basename(machineCode)}`),
    '**/{node_modules,out,.git,.co}/**',
    50
  );
  const existing: vscode.Uri[] = [];
  for (const uri of matches) {
    if (await isFile(uri.fsPath) && !samePath(uri.fsPath, target)) {
      existing.push(uri);
    }
  }
  return existing.sort((left, right) => machineCodeCandidateRank(left.fsPath, resource, folder) - machineCodeCandidateRank(right.fsPath, resource, folder))[0];
}

export async function copyMachineCodeToSimDirectory(
  source: vscode.Uri,
  outDir: vscode.Uri,
  resource?: vscode.Uri
): Promise<void> {
  const targets = dedupePaths([
    path.join(outDir.fsPath, getMachineCode(resource)),
    path.join(outDir.fsPath, 'code.txt')
  ]).filter((target) => !samePath(source.fsPath, target));
  if (!targets.length) {
    return;
  }
  const content = await vscode.workspace.fs.readFile(source);
  for (const target of targets) {
    await ensureDirectory(vscode.Uri.file(path.dirname(target)));
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), content);
  }
}

function machineCodeCandidateRank(file: string, resource: vscode.Uri | undefined, folder: vscode.WorkspaceFolder): number {
  if (resource?.scheme === 'file' && samePath(path.dirname(file), path.dirname(resource.fsPath))) {
    return 0;
  }
  if (samePath(path.dirname(file), folder.uri.fsPath)) {
    return 10;
  }
  const relative = path.relative(folder.uri.fsPath, file).split(path.sep).map((part) => part.toLowerCase());
  if (relative.includes('test') || relative.includes('tests')) {
    return 20;
  }
  if (relative.includes('data')) {
    return 30;
  }
  return 100 + relative.length;
}
