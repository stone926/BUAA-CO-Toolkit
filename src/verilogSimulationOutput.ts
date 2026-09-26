// @index verilog-simulation-output — simulation trace destination and naming
import { CO_OUT_DIR } from './constants';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureDirectory, workspaceFolderFor, workspaceFolderForOrFirst } from './fsUtil';
export { normalizePathKey, samePath } from './pathUtils';

export function simulationOutputFileName(top: string, configured?: string): string {
  const trimmed = configured?.trim();
  return trimmed ? path.basename(trimmed) : `${top}.sim.out`;
}

export async function simulationOutputDirectory(resource: vscode.Uri | undefined, runtimeDir: vscode.Uri): Promise<vscode.Uri> {
  const folder = workspaceFolderFor(resource) ?? workspaceFolderForOrFirst(runtimeDir);
  const baseDir = folder?.uri.fsPath ?? path.dirname(path.dirname(runtimeDir.fsPath));
  const outDir = vscode.Uri.file(path.join(baseDir, CO_OUT_DIR));
  await ensureDirectory(outDir);
  return outDir;
}
