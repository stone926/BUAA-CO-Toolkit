import * as vscode from 'vscode';
import type { MipsRuntimeManager } from './mips/host/runtimeManager';
export type { ProjectProfile } from './projectProfile';

export interface AppServices {
  output: vscode.OutputChannel;
  statusBar: vscode.StatusBarItem;
  /** Optional lazy worker host. When present, builtin execute jobs run off the extension-host thread. */
  mipsRuntime?: MipsRuntimeManager;
}

export interface RunResult {
  ok: boolean;
  exitCode: number | null;
  commandLine: string;
  cwd: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stopped?: boolean;
  stopReason?: string;
}

export interface ToolDetection {
  name: string;
  ok: boolean;
  detail: string;
  suggestion?: string;
}
