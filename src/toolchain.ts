// @index toolchain — bundled Icarus 与可选 Java/Logisim 检测
import * as vscode from 'vscode';
import { ensureConcreteProfile, getJava, getLogisimJar, getMipsEngine, getProfile, type MipsEngineMode } from './config';
import { isFile } from './fsUtil';
import { runTool } from './process';
import { ToolDetection } from './types';
import { getEffectiveRequiredTools } from './toolchainPolicy';
import { IverilogRuntimeError, preflightIverilogRuntime } from './verilog/iverilogRuntime';

export async function checkToolchain(
  output: vscode.OutputChannel,
  resource?: vscode.Uri,
  options: {
    promptForProfile?: boolean;
    tools?: string[];
    nonInteractive?: boolean;
    /** Extension installation root used to resolve the bundled Icarus runtime. */
    extensionRoot?: string;
    /** Private automatic lanes pin this so a workspace rollback cannot start legacy probes. */
    engineMode?: MipsEngineMode;
  } = {}
): Promise<ToolDetection[]> {
  const checks: ToolDetection[] = [];
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  let profile = getProfile(resource);
  if (profile === 'auto' && options.promptForProfile) {
    profile = await ensureConcreteProfile(resource, '检查工具链需要先确定项目 Profile') ?? 'auto';
  }
  if (profile === 'auto') {
    return [{
      name: 'Profile',
      ok: false,
      detail: '无法自动推断',
      suggestion: '请运行 CO: 选择项目 Profile'
    }];
  }
  const requiredTools = new Set([
    ...getEffectiveRequiredTools(profile, options.engineMode ?? getMipsEngine(resource)).map(normalizeToolName),
    ...(options.tools ?? []).map(normalizeToolName)
  ]);

  if (requiredTools.has('java')) {
    const java = getJava(resource);
    const javaResult = await runTool(java, ['-version'], {
      cwd,
      output,
      resource,
      timeoutMs: 10000,
      nonInteractive: options.nonInteractive
    });
    checks.push({
      name: 'Java',
      ok: javaResult.ok,
      detail: firstLine(javaResult.stderr || javaResult.stdout) || java,
      suggestion: javaResult.ok ? undefined : '请安装 JRE/JDK 或设置 co.toolchain.java'
    });
  }

  if (requiredTools.has('logisim')) {
    const logisim = getLogisimJar(resource);
    checks.push(await fileCheck('Logisim', logisim, '请设置 co.toolchain.logisim'));
  }

  if (requiredTools.has('verilogsimulator')) {
    if (!options.extensionRoot) {
      checks.push({
        name: 'Verilog simulator',
        ok: false,
        detail: '无法定位扩展安装目录',
        suggestion: '请重新加载或重新安装扩展'
      });
    } else {
      try {
        const preflight = await preflightIverilogRuntime(options.extensionRoot, { timeoutMs: 10_000 });
        checks.push({
          name: 'Verilog simulator',
          ok: true,
          detail: `${preflight.version} (bundled)`
        });
      } catch (error) {
        const detail = error instanceof IverilogRuntimeError ? error.message : String(error);
        checks.push({
          name: 'Verilog simulator',
          ok: false,
          detail,
          suggestion: '请安装与当前平台匹配的扩展包；内置 Icarus 运行时缺失或不可执行'
        });
      }
    }
  }

  return checks;
}

async function fileCheck(name: string, file: string, suggestion: string): Promise<ToolDetection> {
  if (!file) {
    return {
      name,
      ok: false,
      detail: '未配置',
      suggestion
    };
  }
  const exists = await isFile(file);
  return {
    name,
    ok: exists,
    detail: file,
    suggestion: exists ? undefined : suggestion
  };
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}
