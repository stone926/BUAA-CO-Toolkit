import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { getRunTimeout, shouldRevealOutput, showCommandBeforeRun } from './config';
import { RunResult } from './types';

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

  return await new Promise<RunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...(options.env ?? {})
      },
      shell: false,
      windowsHide: true
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      options.output.append(text);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.output.append(text);
    });

    child.on('error', (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stderr += error.message;
      options.output.appendLine(error.message);
      resolve({
        ok: false,
        exitCode: null,
        commandLine: display,
        cwd,
        stdout,
        stderr,
        timedOut
      });
    });

    child.on('close', (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        options.output.appendLine(`运行超时（${timeoutMs} 毫秒）`);
      }
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        commandLine: display,
        cwd,
        stdout,
        stderr,
        timedOut
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

export async function launchTool(command: string, args: string[], options: RunToolOptions): Promise<RunResult> {
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

  return await new Promise<RunResult>((resolve) => {
    let settled = false;
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
      windowsHide: true,
      detached: true,
      stdio: 'ignore'
    });

    child.on('error', (error: Error) => {
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
    });
  });
}
