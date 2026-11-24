// @index mips-host — Resolve the VS Code resource backing the shared custom ISA service
import * as path from 'path';
import * as vscode from 'vscode';
import { getJava, getMarsJar, getRunTimeout } from '../../config';
import { WorkspaceCustomInstructions } from './customInstructionService';

export function customInstructionsForResource(resource: vscode.Uri): WorkspaceCustomInstructions {
  const directory = vscode.workspace.getWorkspaceFolder?.(resource)?.uri.fsPath ?? path.dirname(resource.fsPath);
  return new WorkspaceCustomInstructions(directory, () => ({
    jar: getMarsJar(resource), java: getJava(resource), timeoutMs: getRunTimeout(resource)
  }));
}
