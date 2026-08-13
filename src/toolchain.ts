// @index toolchain — Java/Python/MARS/ISE/Logisim/Hazard检测
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureConcreteProfile, getHazardCalculator, getIsePath, getJava, getLogisimJar, getMarsJar, getProfile, resolvePython } from './config';
import { cleanupCoTmp, coTmpDir, isFile } from './fsUtil';
import { getProfileRequiredTools } from './courseConfig';
import { MARS_P7_CHECK } from './courseTestToolchain';
import { runTool } from './process';
import { ToolDetection } from './types';
import { iterCpuTraceEvents, iterMarsDetailedTraceEvents } from './language/mips/traceParser';
export { buildIseEnvironment, findFuse, findIsimGui, isimExecutableName } from './iseCommon';
import { findFuse, findIsimGui } from './iseCommon';

const marsCapabilityGpCopyRegister = '3';
const marsCapabilitySpCopyRegister = '4';
const stableCompactGpResetValue = '00001800';
const stableCompactSpResetValue = '00002FFC';

export async function checkToolchain(
  output: vscode.OutputChannel,
  resource?: vscode.Uri,
  options: { promptForProfile?: boolean; tools?: string[] } = {}
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
    ...getProfileRequiredTools(profile).map(normalizeToolName),
    ...(options.tools ?? []).map(normalizeToolName)
  ]);
  const checkAll = requiredTools.size === 0;

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
    const python = await resolvePython(resource);
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
      suggestion: pythonResult.ok ? undefined : '请安装 Python3 或设置 co.toolchain.python（macOS/Linux 通常为 python3）'
    });
  }

  if (checkAll || requiredTools.has('mars') || requiredTools.has('marsp7')) {
    const mars = getMarsJar(resource);
    const marsFile = await fileCheck('MARS', mars, profile === 'P7' ? '请设置 co.toolchain.marsP7 为可用于 P7 CompactLargeText dump 的 Mars jar' : '请设置 co.toolchain.mars 为支持 coL1 和 large text 的修改版 Mars jar');
    checks.push(marsFile);
    if (marsFile.ok) {
      checks.push(...await marsCapabilityChecks(output, resource, cwd, mars, profile));
    }
  }

  if (checkAll || requiredTools.has('logisim')) {
    const logisim = getLogisimJar(resource);
    checks.push(await fileCheck('Logisim', logisim, '请设置 co.toolchain.logisim'));
  }

  if (checkAll || requiredTools.has('ise')) {
    const ise = getIsePath(resource);
    const fuse = ise ? findFuse(ise) : '';
    const isimGui = ise ? findIsimGui(ise) : '';
    const fuseOk = Boolean(fuse && await isFile(fuse));
    const isimGuiOk = Boolean(isimGui && await isFile(isimGui));
    checks.push({
      name: 'ISE fuse',
      ok: fuseOk,
      detail: fuse || '未配置',
      suggestion: fuseOk ? undefined : '请设置 co.toolchain.isePath 为 ISE 目录'
    });
    checks.push({
      name: 'ISim GUI',
      ok: isimGuiOk,
      detail: isimGui || '未配置',
      suggestion: isimGuiOk ? undefined : '请设置 co.toolchain.isePath 为包含 ISim 的 ISE 目录'
    });
  }

  const hazardDir = getHazardCalculator(resource);
  if (hazardDir || profile === 'P5' || profile === 'P6' || profile === 'P7') {
    checks.push(await hazardDirCheck(hazardDir));
  }

  return checks;
}

async function marsCapabilityChecks(
  output: vscode.OutputChannel,
  resource: vscode.Uri | undefined,
  cwd: string,
  mars: string,
  profile: string
): Promise<ToolDetection[]> {
  const tempDir = coTmpDir(resource, 'co-mars-check-');
  try {
    const asm = path.join(tempDir, 'capability.asm');
    const sourceLines = ['.text'];
    if (profile === 'P7') {
      sourceLines.push(
        'ori $26, $0, 0x1001',
        'mtc0 $26, $12'
      );
    }
    sourceLines.push(
      'lui $1, 0x1122',
      'ori $1, $1, 0x3344',
      'sw $1, 0($0)',
      'swl $1, 1($0)',
      'swr $1, 2($0)',
      `addu $${marsCapabilityGpCopyRegister}, $gp, $0`,
      `addu $${marsCapabilitySpCopyRegister}, $sp, $0`,
      'ori $2, $0, 2'
    );
    if (profile === 'P7') {
      sourceLines.push(
        '.ktext 0x4180',
        'mfc0 $8, $13',
        'sb $0, 0x7f20($0)',
        'eret',
        'nop'
      );
    }
    sourceLines.push('');
    await fs.promises.writeFile(asm, sourceLines.join('\n'), 'utf8');
    const java = getJava(resource);
    const traceMemory = profile === 'P7' ? 'CompactLargeText' : 'CompactDataAtZero';
    const traceBaseArgs = ['-jar', mars, 'nc', 'mc', traceMemory, 'ae1', 'se1'];
    if (profile === 'P5' || profile === 'P6' || profile === 'P7') {
      traceBaseArgs.push('db');
    }
    if (profile === 'P7') {
      traceBaseArgs.push('efc', 'p7irq=0x3008');
    }
    const traceL1 = await runTool(java, [...traceBaseArgs, 'coL1', asm], {
      cwd,
      output,
      resource,
      timeoutMs: 10000
    });
    const traceL2 = await runTool(java, [...traceBaseArgs, 'coL2', asm], {
      cwd,
      output,
      resource,
      timeoutMs: 10000
    });
    const checks: ToolDetection[] = [
      marsTraceCapabilityCheck(traceL1, 1),
      marsTraceCapabilityCheck(traceL2, 2)
    ];
    if (profile === 'P7') {
      checks.push(p7InterruptCapabilityCheck(traceL1));
    }
    if (profile !== 'P7') {
      checks.push(await memoryConfigurationCapabilityCheck(output, resource, cwd, java, mars, asm, tempDir, 'FixedCompactLargeText'));
    }
    checks.push(await memoryConfigurationCapabilityCheck(output, resource, cwd, java, mars, asm, tempDir, 'CompactLargeText'));
    return checks;
  } finally {
    await cleanupCoTmp(tempDir);
  }
}

/** Exported so the stable-MARS trace contract can be covered without launching Java in unit tests. */
export function marsTraceCapabilityCheck(
  result: Awaited<ReturnType<typeof runTool>>,
  level: 1 | 2
): ToolDetection {
  const output = `${result.stdout}\n${result.stderr}`;
  const flag = `coL${level}`;
  const unsupported = new RegExp(`Invalid Command Argument:\\s*${flag}`, 'i').test(output);
  const hasBasicTrace = level === 1
    ? /@(?:0x)?[0-9a-f]{4,8}:\s*(?:\$|\*)/i.test(output)
    : /@PC(?:0x)?[0-9a-f]{4,8}\s*->/i.test(output) && /(?:\$|\*)[0-9a-f ]+\s*<=/i.test(output);
  const events = Array.from(level === 1 ? iterCpuTraceEvents(output) : iterMarsDetailedTraceEvents(output));
  const hasExpectedRegister = events.some((event) =>
    event.kind === 'grf' && event.target === '1' && event.value === '11223344');
  const hasExpectedStore = events.some((event) =>
    event.kind === 'dm' && event.target === '00000000' && event.value === '11223344');
  const hasExpectedCompactResetRegisters = [
    [marsCapabilityGpCopyRegister, stableCompactGpResetValue],
    [marsCapabilitySpCopyRegister, stableCompactSpResetValue]
  ].every(([target, value]) => events.some((event) =>
    event.kind === 'grf' && event.target === target && event.value === value));
  const completedProgram = events.some((event) =>
    event.kind === 'grf' && event.target === '2' && event.value === '00000002');
  const hasTrace = hasBasicTrace
    && hasExpectedRegister
    && hasExpectedStore
    && hasExpectedCompactResetRegisters
    && completedProgram
    && (level === 1 || hasUsablePartialWordDetailedTrace(output));
  return {
    name: `MARS ${flag}`,
    ok: result.ok && !unsupported && hasTrace,
    detail: firstLine(output) || '无 trace 输出',
    suggestion: result.ok && !unsupported && hasTrace
      ? undefined
      : `请使用支持 ${flag} 的 Mars-with-BUAA-CO-extension 稳定版 MARS`
  };
}

function p7InterruptCapabilityCheck(result: Awaited<ReturnType<typeof runTool>>): ToolDetection {
  const output = `${result.stdout}\n${result.stderr}`;
  const unsupported = /Invalid Command Argument:\s*(?:efc|p7irq(?:=|\b))/i.test(output);
  const events = Array.from(iterCpuTraceEvents(output));
  const enteredHandler = events.some((event) =>
    event.pc === '00004180'
    && event.kind === 'grf'
    && event.target === '8'
    && (Number.parseInt(event.value, 16) & 0x1000) !== 0);
  const resumedUserProgram = events.some((event) =>
    event.kind === 'grf' && event.target === '2' && event.value === '00000002');
  const ok = result.ok && !unsupported && enteredHandler && resumedUserProgram;
  return {
    name: MARS_P7_CHECK,
    ok,
    detail: ok ? 'efc + p7irq 外部中断探针通过' : firstLine(output) || '无 P7 中断 trace 输出',
    suggestion: ok
      ? undefined
      : '请使用支持 efc 与 p7irq 的 Mars-with-BUAA-CO-extension 稳定版 MARS'
  };
}

function hasUsablePartialWordDetailedTrace(output: string): boolean {
  const partialStorePcs = Array.from(output.matchAll(/^@PC(?:0x)?([0-9a-f]{1,8})\s*->\s*sw[lr]\b/gim))
    .map((match) => match[1].padStart(8, '0').toUpperCase());
  if (partialStorePcs.length < 2) {
    return false;
  }
  const events = Array.from(iterMarsDetailedTraceEvents(output));
  return partialStorePcs.every((pc) =>
    events.filter((event) => event.pc === pc && event.kind === 'dm').length === 1);
}

async function memoryConfigurationCapabilityCheck(
  output: vscode.OutputChannel,
  resource: vscode.Uri | undefined,
  cwd: string,
  java: string,
  mars: string,
  asm: string,
  tempDir: string,
  memoryConfiguration: 'CompactDataAtZero' | 'FixedCompactLargeText' | 'CompactLargeText'
): Promise<ToolDetection> {
  const outFile = path.join(tempDir, `${memoryConfiguration}.txt`);
  const result = await runTool(java, ['-jar', mars, 'nc', 'mc', memoryConfiguration, 'db', 'a', 'dump', '.text', 'HexText', outFile, asm], {
    cwd,
    output,
    resource,
    timeoutMs: 10000
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  const unsupported = /Invalid memory configuration/i.test(combined);
  const dumped = await fileHasText(outFile);
  return {
    name: `MARS ${memoryConfiguration}`,
    ok: result.ok && !unsupported && dumped,
    detail: firstLine(combined) || (dumped ? 'dump ok' : '未生成 HexText'),
    suggestion: result.ok && !unsupported && dumped ? undefined : `请使用支持 mc ${memoryConfiguration} 的修改版 Mars`
  };
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

async function fileHasText(file: string): Promise<boolean> {
  try {
    return (await fs.promises.readFile(file, 'utf8')).trim().length > 0;
  } catch {
    return false;
  }
}

async function hazardDirCheck(dir: string): Promise<ToolDetection> {
  if (!dir) {
    return {
      name: '冲突分析',
      ok: false,
      detail: '未配置',
      suggestion: '请设置 co.toolchain.hazardCalculator 为 hazard_analysis 目录'
    };
  }
  const jarExists = await isFile(path.join(dir, 'Hazard-Calculator.jar'));
  const analyzerExists = await isFile(path.join(dir, 'analyzer.py'));
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

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}
