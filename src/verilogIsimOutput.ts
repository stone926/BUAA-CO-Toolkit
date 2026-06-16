import * as path from 'path';
import * as vscode from 'vscode';
import { ensureDirectory, workspaceFolderFor } from './fsUtil';

export function isimOutputFileName(top: string, configured?: string): string {
  const trimmed = configured?.trim();
  return trimmed ? path.basename(trimmed) : `${top}.sim.out`;
}

export async function simulationOutputDirectory(resource: vscode.Uri | undefined, isimDir: vscode.Uri): Promise<vscode.Uri> {
  const folder = workspaceFolderFor(resource) ?? workspaceFolderFor(isimDir) ?? vscode.workspace.workspaceFolders?.[0];
  const baseDir = folder?.uri.fsPath ?? path.dirname(path.dirname(isimDir.fsPath));
  const outDir = vscode.Uri.file(path.join(baseDir, '.co', 'out'));
  await ensureDirectory(outDir);
  return outDir;
}

export function samePath(left: string, right: string): boolean {
  return normalizePathKey(left) === normalizePathKey(right);
}

export function normalizePathKey(file: string): string {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
