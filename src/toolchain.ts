import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getHazardCalculator, getIsePath, getJava, getLogisimJar, getMarsJar, getProfile, getPython } from './config';
import { getProfileRequiredTools } from './courseConfig';
import { runTool } from './process';
import { ToolDetection } from './types';

export async function checkToolchain(output: vscode.OutputChannel, resource?: vscode.Uri): Promise<ToolDetection[]> {
  const checks: ToolDetection[] = [];
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const profile = getProfile(resource);
  const requiredTools = new Set(getProfileRequiredTools(profile).map(normalizeToolName));
  const checkAll = profile === 'auto' || requiredTools.size === 0;

  if (checkAll || requiredTools.has('java')) {
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
      suggestion: javaResult.ok ? undefined : '请安装 JRE/JDK 或设置 co.toolchain.java'
    });
  }

  if (checkAll) {
    const python = getPython(resource);
    const pythonResult = await runTool(python, ['--version'], {
      cwd,
      output,
      resource,
      timeoutMs: 10000
    });
    checks.push({
      name: 'Python',
      ok: pythonResult.ok,
      detail: firstLine(pythonResult.stdout || pythonResult.stderr) || python,
      suggestion: pythonResult.ok ? undefined : '请安装 Python 或设置 co.toolchain.python'
    });
  }

  if (checkAll || requiredTools.has('mars') || requiredTools.has('marsp7')) {
    const mars = getMarsJar(resource);
    checks.push(fileCheck('MARS', mars, profile === 'P7' ? '请设置 co.toolchain.marsP7 为课程专用 P7 MARS jar' : '请设置 co.toolchain.mars'));
  }

  if (checkAll || requiredTools.has('logisim')) {
    const logisim = getLogisimJar(resource);
    checks.push(fileCheck('Logisim', logisim, '请设置 co.toolchain.logisim'));
  }

  if (checkAll || requiredTools.has('ise')) {
    const ise = getIsePath(resource);
    const fuse = ise ? findFuse(ise) : '';
    checks.push({
      name: 'ISE fuse',
      ok: Boolean(fuse && fs.existsSync(fuse)),
      detail: fuse || '未配置',
      suggestion: fuse ? undefined : '请设置 co.toolchain.isePath 为 ISE 目录'
    });
  }

  const hazardDir = getHazardCalculator(resource);
  if (hazardDir || profile === 'P5' || profile === 'P6') {
    checks.push(hazardDirCheck(hazardDir));
  }

  return checks;
}

function fileCheck(name: string, file: string, suggestion: string): ToolDetection {
  if (!file) {
    return {
      name,
      ok: false,
      detail: '未配置',
      suggestion
    };
  }
  const exists = fs.existsSync(file);
  return {
    name,
    ok: exists,
    detail: file,
    suggestion: exists ? undefined : suggestion
  };
}

function hazardDirCheck(dir: string): ToolDetection {
  if (!dir) {
    return {
      name: '冲突分析',
      ok: false,
      detail: '未配置',
      suggestion: '请设置 co.toolchain.hazardCalculator 为 hazard_analysis 目录'
    };
  }
  const jarExists = fs.existsSync(path.join(dir, 'Hazard-Calculator.jar'));
  const analyzerExists = fs.existsSync(path.join(dir, 'analyzer.py'));
  const ok = jarExists && analyzerExists;
  const missing = [
    !jarExists && 'Hazard-Calculator.jar',
    !analyzerExists && 'analyzer.py'
  ].filter(Boolean).join(', ');
  return {
    name: '冲突分析',
    ok,
    detail: dir,
    suggestion: ok ? undefined : `${dir} 中缺少 ${missing}`
  };
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
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
