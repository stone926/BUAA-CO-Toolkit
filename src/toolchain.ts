import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getHazardCalculator, getIsePath, getJava, getLogisimJar, getMarsJar, getProfile } from './config';
import { runTool } from './process';
import { ToolDetection } from './types';

export async function checkToolchain(output: vscode.OutputChannel, resource?: vscode.Uri): Promise<ToolDetection[]> {
  const checks: ToolDetection[] = [];
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const java = getJava(resource);
  const javaResult = await runTool(java, ['-version'], {
    cwd,
    output,
    resource,
    timeoutMs: 10000
  });
  checks.push({
    name: 'Java',
    ok: javaResult.ok,
    detail: firstLine(javaResult.stderr || javaResult.stdout) || java,
    suggestion: javaResult.ok ? undefined : 'Install JRE/JDK or set co.toolchain.java.'
  });

  const mars = getMarsJar(resource);
  checks.push(fileCheck('MARS', mars, 'Set co.toolchain.mars or co.toolchain.marsP7.'));

  const logisim = getLogisimJar(resource);
  checks.push(fileCheck('Logisim', logisim, 'Set co.toolchain.logisim.'));

  const ise = getIsePath(resource);
  const fuse = ise ? findFuse(ise) : '';
  checks.push({
    name: 'ISE fuse',
    ok: Boolean(fuse && fs.existsSync(fuse)),
    detail: fuse || 'not configured',
    suggestion: fuse ? undefined : 'Set co.toolchain.isePath to the ISE directory.'
  });

  const hazard = getHazardCalculator(resource);
  const profile = getProfile(resource);
  if (hazard || profile === 'P5' || profile === 'P6') {
    checks.push(fileCheck('Hazard Calculator', hazard, 'Set co.toolchain.hazardCalculator for P5/P6 hazard analysis.'));
  }

  return checks;
}

function fileCheck(name: string, file: string, suggestion: string): ToolDetection {
  if (!file) {
    return {
      name,
      ok: false,
      detail: 'not configured',
      suggestion
    };
  }
  return {
    name,
    ok: fs.existsSync(file),
    detail: file,
    suggestion: fs.existsSync(file) ? undefined : suggestion
  };
}

export function findFuse(isePath: string): string {
  const candidates = [
    path.join(isePath, 'bin', 'nt64', 'fuse.exe'),
    path.join(isePath, 'bin', 'nt', 'fuse.exe'),
    path.join(isePath, 'bin', 'lin64', 'fuse'),
    path.join(isePath, 'bin', 'lin', 'fuse')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}
