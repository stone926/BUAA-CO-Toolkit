// @index toolchain — bundled Icarus 与可选 Java/MARS/Logisim 检测
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureConcreteProfile, getJava, getLogisimJar, getMarsJar, getMemoryConfiguration, getMipsEngine, getProfile, type MipsEngineMode } from './config';
import { cleanupCoTmp, coTmpDir, isFile } from './fsUtil';
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

  if (requiredTools.has('java') || requiredTools.has('mars')) {
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

  if (requiredTools.has('mars')) {
    const mars = getMarsJar(resource);
    const marsFile = await fileCheck('MARS', mars, '请设置 co.toolchain.mars 为官方 MARS 4.5 jar 路径');
    checks.push(marsFile);
    if (marsFile.ok) {
      checks.push(...await marsCapabilityChecks(output, resource, cwd, mars, options.nonInteractive));
    }
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

async function marsCapabilityChecks(
  output: vscode.OutputChannel,
  resource: vscode.Uri | undefined,
  cwd: string,
  mars: string,
  nonInteractive = false
): Promise<ToolDetection[]> {
  const tempDir = coTmpDir(resource, 'co-mars-check-');
  try {
    const asm = path.join(tempDir, 'capability.asm');
    const outFile = path.join(tempDir, 'capability.txt');
    // Only official instructions/options are needed. The syscall output proves execution.
    await fs.promises.writeFile(asm, [
      '.text', 'ori $4, $0, 12345', 'ori $2, $0, 1', 'syscall',
      'ori $2, $0, 10', 'syscall', ''
    ].join('\n'), 'utf8');
    const java = getJava(resource);
    const baseArgs = ['-jar', mars, 'nc', 'mc', getMemoryConfiguration(resource), 'ae1', 'se1'];
    const runOptions = { cwd, output, resource, timeoutMs: 10000, nonInteractive };
    const assembled = await runTool(java, [
      ...baseArgs, 'a', 'dump', '.text', 'HexText', outFile, asm
    ], runOptions);
    let hexText = '';
    try {
      hexText = await fs.promises.readFile(outFile, 'utf8');
    } catch {
      // Missing or unreadable output is a failed capability check.
    }
    const assembly = marsAssemblyCapabilityCheck(assembled, hexText);
    if (!assembly.ok) {
      return [assembly];
    }
    const executed = await runTool(java, [...baseArgs, '1000', asm], runOptions);
    return [assembly, marsExecutionCapabilityCheck(executed)];
  } finally {
    await cleanupCoTmp(tempDir);
  }
}

/** MARS may otherwise exit successfully after a diagnostic; also verify actual words. */
export function marsAssemblyCapabilityCheck(
  result: Awaited<ReturnType<typeof runTool>>,
  hexText: string
): ToolDetection {
  const output = `${result.stdout}\n${result.stderr}`;
  const words = hexText.trim().split(/\s+/).map((word) => word.toLowerCase());
  const expectedWords = ['34043039', '34020001', '0000000c', '3402000a', '0000000c'];
  const validDump = words.length === expectedWords.length
    && words.every((word, index) => word === expectedWords[index]);
  const ok = result.ok && !hasMarsDiagnostic(output) && validDump;
  return {
    name: 'MARS assemble/HexText',
    ok,
    detail: ok ? '标准汇编与 HexText 导出通过' : firstLine(output) || '未生成正确的 HexText',
    suggestion: ok ? undefined : '请使用官方 MARS 4.5，并检查 Java 与 MARS 路径'
  };
}

export function marsExecutionCapabilityCheck(
  result: Awaited<ReturnType<typeof runTool>>
): ToolDetection {
  const output = `${result.stdout}\n${result.stderr}`;
  const ok = result.ok && !hasMarsDiagnostic(output) && result.stdout.trim() === '12345';
  return {
    name: 'MARS run',
    ok,
    detail: ok ? '标准运行与 syscall 输出通过' : firstLine(output) || '未生成预期 syscall 输出',
    suggestion: ok ? undefined : '请使用官方 MARS 4.5，并检查 Java 与 MARS 路径'
  };
}

function hasMarsDiagnostic(output: string): boolean {
  return /Error(?:\s+in|:)|Invalid (?:Command Argument|memory configuration)|Exception occurred|processing terminated due to errors|program terminated when maximum step limit/i.test(output);
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
