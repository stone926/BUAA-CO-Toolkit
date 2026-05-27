import * as vscode from 'vscode';

export type ProjectProfile =
  | 'auto'
  | 'P0'
  | 'P1'
  | 'P2'
  | 'P3'
  | 'P4'
  | 'P5'
  | 'P6'
  | 'P7';

export interface AppServices {
  output: vscode.OutputChannel;
  statusBar: vscode.StatusBarItem;
}

export interface RunResult {
  ok: boolean;
  exitCode: number | null;
  commandLine: string;
  cwd: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ToolDetection {
  name: string;
  ok: boolean;
  detail: string;
  suggestion?: string;
}
