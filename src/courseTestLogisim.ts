import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getJava,
  getLogisimJar,
  getLogisimTraceColumns,
  getLogisimTraceMainCircuit,
  getMemoryConfiguration,
  getRunTimeout,
  showCommandBeforeRun
} from './config';
import {
  analyzeP3LogisimTraceCircuit,
  createLogisimPcProgressState,
  defaultLogisimTraceCircuit,
  formatP3LogisimTraceDiagnostic,
  inspectLogisimPcProgress,
  LogisimTraceColumnMap,
  LogisimTraceSpec,
  p3LogisimMaxWords,
  parseLogisimTraceSpec
} from './courseTesting/logisimTrace';
import { readTextFile } from './fsUtil';
import { findLogisimRomTargets, LogisimRomTarget } from './language/logisim/rom';
import { commandLine, revealOutputChannel } from './process';
import { checkToolchain } from './toolchain';
import { AppServices, RunResult } from './types';
import { pickOneFile } from './workflowInputs';
import { courseTraceMemoryConfigurationError, formatToolchainFailure } from './courseTestToolchain';

export interface P3LogisimTraceSetup {
  circuit: vscode.Uri;
  circuitText: string;
  traceCircuit: string;
  traceSpec: LogisimTraceSpec;
  traceDiagnostic: string;
  traceColumns?: LogisimTraceColumnMap;
  romTarget: LogisimRomTarget;
}

export interface LogisimCliTraceRun {
  result: RunResult;
  stdout: string;
  stderr: string;
  rowsSeen: number;
  haltedByPc: boolean;
  pcError?: string;
}

export async function diagnoseP3LogisimTraceCircuit(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);
  const circuit = await resolveLogisimCircuitInput();
  if (!circuit) {
    return;
  }
  const circuitText = await readTextFile(circuit);
  const traceCircuit = getLogisimTraceMainCircuit(circuit) || defaultLogisimTraceCircuit;
  const traceColumns = getLogisimTraceColumns(circuit) as LogisimTraceColumnMap | undefined;
  const report = analyzeP3LogisimTraceCircuit(circuitText, traceCircuit, { traceColumns });
  const diagnostic = formatP3LogisimTraceDiagnostic(report);
  revealOutputChannel(services.output, circuit);
  services.output.appendLine('');
  services.output.appendLine(diagnostic);
  if (report.spec) {
    vscode.window.showInformationMessage('P3 Logisim Trace 电路诊断通过，详见输出面板');
  } else {
    vscode.window.showErrorMessage(`P3 Logisim Trace 电路诊断失败：${report.errors[0] ?? '无法解析 trace 端口'}`);
  }
}

export async function resolveLogisimCircuitInput(): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && isLogisimCircuitFile(editor.document.uri)) {
    if (editor.document.isDirty) {
      await editor.document.save();
    }
    return editor.document.uri;
  }

  const files = await vscode.workspace.findFiles('**/*.circ', '**/{node_modules,out,.git,.co}/**', 200);
  if (files.length === 1) {
    return files[0];
  }
  if (files.length > 1) {
    const picked = await vscode.window.showQuickPick(
      files.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        description: path.dirname(uri.fsPath),
        uri
      })),
      {
        title: '选择 Logisim 电路模板',
        matchOnDescription: true
      }
    );
    return picked?.uri;
  }

  return await pickOneFile('选择 Logisim 电路模板', {
    Logisim: ['circ'],
    All: ['*']
  });
}

export async function resolveLogisimRomTarget(circuitText: string): Promise<LogisimRomTarget | undefined> {
  const candidates = findLogisimRomTargets(circuitText)
    .filter((target) => target.dataWidth === undefined || target.dataWidth === 32);
  if (!candidates.length) {
    vscode.window.showErrorMessage('所选 Logisim 电路中未找到 32 位 ROM 组件');
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((target) => ({
      label: target.label ? `${target.index}: ${target.label}` : `${target.index}: ROM`,
      description: [
        target.loc ? `位置 ${target.loc}` : undefined,
        target.addrWidth ? `地址 ${target.addrWidth}` : undefined,
        target.dataWidth ? `数据 ${target.dataWidth}` : undefined,
        target.hasContents ? '有内容' : '空'
      ].filter(Boolean).join(' | '),
      target
    })),
    {
      title: '选择要注入机器码的 Logisim ROM'
    }
  );
  return picked?.target;
}

export function resolveSingleP3LogisimRomTarget(
  services: AppServices,
  circuitText: string
): LogisimRomTarget | undefined {
  const candidates = findLogisimRomTargets(circuitText)
    .filter((target) => target.dataWidth === undefined || target.dataWidth === 32);
  if (candidates.length === 1) {
    return candidates[0];
  }

  const message = candidates.length === 0
    ? 'P3 Logisim Trace 电路中未找到唯一的 32 位 ROM 组件'
    : `P3 Logisim Trace 电路应当只有一个 32 位 ROM 组件，当前找到 ${candidates.length} 个`;
  services.output.appendLine(message);
  vscode.window.showErrorMessage(message);
  return undefined;
}

export async function resolveP3LogisimTraceSetup(
  services: AppServices,
  resource: vscode.Uri
): Promise<P3LogisimTraceSetup | undefined> {
  if (!await ensureP3LogisimTraceToolchainReady(services, resource)) {
    return undefined;
  }

  const circuit = await resolveLogisimCircuitInput();
  if (!circuit) {
    return undefined;
  }
  const circuitText = await readTextFile(circuit);
  const traceCircuit = getLogisimTraceMainCircuit(circuit) || defaultLogisimTraceCircuit;
  const traceColumns = getLogisimTraceColumns(circuit) as LogisimTraceColumnMap | undefined;
  const traceReport = analyzeP3LogisimTraceCircuit(circuitText, traceCircuit, { traceColumns });
  const traceDiagnostic = formatP3LogisimTraceDiagnostic(traceReport);
  let traceSpec: LogisimTraceSpec;
  try {
    traceSpec = traceReport.spec ?? parseLogisimTraceSpec(circuitText, traceCircuit, { traceColumns });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`P3 Logisim Trace 顶层不可用：${traceReport.errors[0] ?? message}`);
    services.output.appendLine(traceDiagnostic);
    return undefined;
  }
  if (!traceReport.spec) {
    vscode.window.showErrorMessage(`P3 Logisim Trace 顶层不可用：${traceReport.errors[0] ?? '无法解析 trace 端口'}`);
    services.output.appendLine(traceDiagnostic);
    return undefined;
  }

  const romTarget = resolveSingleP3LogisimRomTarget(services, circuitText);
  if (!romTarget) {
    return undefined;
  }

  revealOutputChannel(services.output, circuit);
  services.output.appendLine('');
  services.output.appendLine('P3 Logisim Trace 设置');
  services.output.appendLine(`电路: ${circuit.fsPath}`);
  services.output.appendLine(`Trace 顶层: ${traceCircuit}`);
  services.output.appendLine(`Trace 输出列: ${traceSpec.columns.map((column) => column.logisimLabel || `(col ${column.index})`).join(', ')}`);
  services.output.appendLine(traceDiagnostic);
  services.output.appendLine(`ROM: ${romTarget.label ?? 'ROM'}${romTarget.loc ? ` ${romTarget.loc}` : ''}`);

  return {
    circuit,
    circuitText,
    traceCircuit,
    traceSpec,
    traceDiagnostic,
    traceColumns,
    romTarget
  };
}

export async function runLogisimTraceCli(
  services: AppServices,
  setup: P3LogisimTraceSetup,
  circuit: vscode.Uri,
  haltPcHex: string,
  resource: vscode.Uri,
  streamOutput = true
): Promise<LogisimCliTraceRun> {
  const java = getJava(resource);
  const logisim = getLogisimJar(resource);
  const args = ['-jar', logisim, circuit.fsPath, '-tty', 'table,halt,speed'];
  const cwd = path.dirname(circuit.fsPath);
  const display = commandLine(java, args);
  const timeoutMs = getRunTimeout(resource);
  services.output.appendLine(`$ ${display}`);
  services.output.appendLine(`cwd: ${cwd}`);

  if (showCommandBeforeRun(resource)) {
    const choice = await vscode.window.showInformationMessage(`运行外部工具？\n${display}`, '运行');
    if (choice !== '运行') {
      return {
        result: {
          ok: false,
          exitCode: null,
          commandLine: display,
          cwd,
          stdout: '',
          stderr: '用户取消',
          timedOut: false
        },
        stdout: '',
        stderr: '用户取消',
        rowsSeen: 0,
        haltedByPc: false
      };
    }
  }

  return await new Promise<LogisimCliTraceRun>((resolve) => {
    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    let rowsSeen = 0;
    let settled = false;
    let timedOut = false;
    let haltedByPc = false;
    let pcError: string | undefined;
    const pcProgress = createLogisimPcProgressState();

    const child = spawn(java, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true
    });

    const timer = setTimeout(() => {
      if (lineBuffer) {
        inspectLine(lineBuffer);
        lineBuffer = '';
      }
      if (!haltedByPc && !pcError) {
        timedOut = true;
        child.kill();
      }
    }, timeoutMs);

    const inspectLine = (line: string): void => {
      try {
        const progress = inspectLogisimPcProgress(line, setup.traceSpec, pcProgress, haltPcHex);
        rowsSeen = pcProgress.rowsSeen;
        if (!progress.rowSeen) {
          return;
        }
        if (progress.error) {
          pcError = progress.error;
          child.kill();
          return;
        }
        if (!haltedByPc && progress.halted) {
          haltedByPc = true;
          child.kill();
        }
      } catch {
        // Full parser will report malformed table rows after the process exits.
      }
    };

    const appendStdout = (text: string): void => {
      stdout += text;
      if (streamOutput) {
        services.output.append(text);
      }
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        inspectLine(line);
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      appendStdout(chunk.toString());
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      services.output.append(text);
    });

    child.on('error', (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stderr += error.message;
      services.output.appendLine(error.message);
      resolve({
        result: {
          ok: false,
          exitCode: null,
          commandLine: display,
          cwd,
          stdout,
          stderr,
          timedOut
        },
        stdout,
        stderr,
        rowsSeen,
        haltedByPc
      });
    });

    child.on('close', (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (lineBuffer) {
        inspectLine(lineBuffer);
        lineBuffer = '';
      }
      if (timedOut) {
        services.output.appendLine(`运行超时（${timeoutMs} 毫秒）`);
      }
      if (haltedByPc) {
        services.output.appendLine(`Logisim 已到达停机 PC 0x${haltPcHex}，结束命令行仿真`);
      }
      if (pcError) {
        services.output.appendLine(pcError);
      }
      const finalStderr = pcError
        ? [stderr.trimEnd(), pcError].filter(Boolean).join('\n')
        : stderr;
      resolve({
        result: {
          ok: haltedByPc || (!timedOut && !pcError && code === 0),
          exitCode: code,
          commandLine: display,
          cwd,
          stdout,
          stderr: finalStderr,
          timedOut: timedOut && !haltedByPc
        },
        stdout,
        stderr: finalStderr,
        rowsSeen,
        haltedByPc,
        pcError
      });
    });
  });
}

export function p3LogisimRomCapacityError(target: LogisimRomTarget, wordCount: number): string | undefined {
  if (wordCount > p3LogisimMaxWords) {
    return `P3 Logisim 机器码共有 ${wordCount} words，超过教程 IFU ${p3LogisimMaxWords} words 容量`;
  }
  if (target.addrWidth === undefined) {
    return undefined;
  }
  const capacity = target.addrWidth >= 31 ? Number.MAX_SAFE_INTEGER : 2 ** target.addrWidth;
  if (wordCount > capacity) {
    return `所选 Logisim ROM 地址宽度为 ${target.addrWidth}，容量 ${capacity} words，小于本用例 ${wordCount} words`;
  }
  return undefined;
}

function isLogisimCircuitFile(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && path.extname(uri.fsPath).toLowerCase() === '.circ';
}

async function ensureP3LogisimTraceToolchainReady(services: AppServices, resource: vscode.Uri): Promise<boolean> {
  revealOutputChannel(services.output, resource);
  services.output.appendLine('');
  services.output.appendLine('正在检查 P3 Logisim Trace 对拍工具链');

  const memoryConfiguration = getMemoryConfiguration(resource);
  const configurationError = courseTraceMemoryConfigurationError('P3', memoryConfiguration);
  if (configurationError) {
    services.output.appendLine(configurationError);
    vscode.window.showErrorMessage(configurationError);
    return false;
  }

  const checks = await checkToolchain(services.output, resource, { tools: ['java', 'mars', 'logisim'] });
  const required = new Set(['Java', 'MARS', 'MARS coL1', 'Logisim', `MARS ${memoryConfiguration}`]);
  const failed = checks.filter((check) => required.has(check.name) && !check.ok);
  if (!failed.length) {
    return true;
  }

  const message = `P3 Logisim Trace 工具链检查失败：${failed.map(formatToolchainFailure).join('；')}`;
  services.output.appendLine(message);
  vscode.window.showErrorMessage(message);
  return false;
}
