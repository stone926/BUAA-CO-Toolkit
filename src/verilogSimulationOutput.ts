// @index verilog-simulation-output — simulation trace destination and naming
import { CO_OUT_DIR } from './constants';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureDirectory } from './fsUtil';
export { normalizePathKey, samePath } from './pathUtils';

export function simulationOutputFileName(top: string, configured?: string): string {
  const trimmed = configured?.trim();
  return trimmed ? path.basename(trimmed) : `${top}.sim.out`;
}

export async function simulationOutputDirectory(workspaceRoot: vscode.Uri): Promise<vscode.Uri> {
  const outDir = vscode.Uri.file(path.join(workspaceRoot.fsPath, CO_OUT_DIR));
  await ensureDirectory(outDir);
  return outDir;
}
