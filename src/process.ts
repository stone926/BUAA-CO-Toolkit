// @index process — runTool(同步捕获)+launchTool(GUI分离启动)
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { getRunTimeout, shouldRevealOutput, showCommandBeforeRun } from './config';
import { RunResult } from './types';
import { runProcessCore } from './processCore';

/**
 * 仅在用户开启 `co.run.revealOutput` 时弹出「输出」面板，否则静默写入。
 * 统一所有运行入口的弹出行为，避免侧边栏操作自动抢占下方面板。
 */
export function revealOutputChannel(output: vscode.OutputChannel, resource?: vscode.Uri): void {
  if (shouldRevealOutput(resource)) {
    output.show(true);
  }
}

export interface RunToolOptions {
  cwd: string;
  output: vscode.OutputChannel;
  env?: NodeJS.ProcessEnv;
  resource?: vscode.Uri;
  timeoutMs?: number;
  stdin?: string;
  launchSuccessDelayMs?: number;
  /** Cancellation with process-tree termination (plan section 1.6). */
  signal?: AbortSignal;
}

export function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export function commandLine(command: string, args: readonly string[]): string {
  return [quoteArg(command), ...args.map(quoteArg)].join(' ');
}

export async function runTool(command: string, args: string[], options: RunToolOptions): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? getRunTimeout(options.resource);
  const display = commandLine(command, args);
  const cwd = options.cwd;
  options.output.appendLine(`$ ${display}`);
  options.output.appendLine(`cwd: ${cwd}`);

  if (showCommandBeforeRun(options.resource)) {
    const choice = await vscode.window.showInformationMessage(`运行外部工具？\n${display}`, '运行');
    if (choice !== '运行') {
      return {
        ok: false,
        exitCode: null,
        commandLine: display,
        cwd,
        stdout: '',
        stderr: '用户取消',
        timedOut: false
      };
    }
  }

  const result = await runProcessCore(command, args, {
    cwd,
    env: options.env,
    timeoutMs,
    stdin: options.stdin,
    signal: options.signal,
    commandLine: display,
    onStdout: (text) => options.output.append(text),
    onStderr: (text) => options.output.append(text),
    onError: (error) => options.output.appendLine(error.message),
    onTimeout: () => options.output.appendLine(`运行超时（${timeoutMs} 毫秒）`)
  });
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    commandLine: display,
    cwd,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut
  };
}

export async function launchTool(command: string, args: string[], options: RunToolOptions): Promise<RunResult> {
  const display = commandLine(command, args);
  const cwd = options.cwd;
  const successDelayMs = options.launchSuccessDelayMs ?? 1500;
  options.output.appendLine(`$ ${display}`);
  options.output.appendLine(`cwd: ${cwd}`);

  if (showCommandBeforeRun(options.resource)) {
    const choice = await vscode.window.showInformationMessage(`运行外部工具？\n${display}`, '运行');
    if (choice !== '运行') {
      return {
        ok: false,
        exitCode: null,
        commandLine: display,
        cwd,
        stdout: '',
        stderr: '用户取消',
        timedOut: false
      };
    }
  }

  return await new Promise<RunResult>((resolve) => {
    let settled = false;
    let childPid: number | undefined;
    const resolveOnce = (result: RunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...(options.env ?? {})
      },
      shell: false,
      windowsHide: false,
      detached: true,
      stdio: 'ignore'
    });

    let successTimer: NodeJS.Timeout | undefined;

    child.on('error', (error: Error) => {
      if (settled) {
        return;
      }
      if (successTimer) {
        clearTimeout(successTimer);
      }
      options.output.appendLine(error.message);
      resolveOnce({
        ok: false,
        exitCode: null,
        commandLine: display,
        cwd,
        stdout: '',
        stderr: error.message,
        timedOut: false
      });
    });

    child.on('spawn', () => {
      childPid = child.pid;
      successTimer = setTimeout(() => {
        successTimer = undefined;
        options.output.appendLine(`GUI 进程已启动${childPid ? ` (pid ${childPid})` : ''}`);
        child.unref();
        resolveOnce({
          ok: true,
          exitCode: null,
          commandLine: display,
          cwd,
          stdout: '',
          stderr: '',
          timedOut: false
        });
      }, successDelayMs);
    });

    child.on('close', (code: number | null) => {
      if (settled) {
        return;
      }
      if (successTimer) {
        clearTimeout(successTimer);
      }
      const message = `GUI 进程启动后立即退出${code === null ? '' : `，退出码 ${code}`}`;
      options.output.appendLine(message);
      resolveOnce({
        ok: false,
        exitCode: code,
        commandLine: display,
        cwd,
        stdout: '',
        stderr: message,
        timedOut: false
      });
    });
  });
}
