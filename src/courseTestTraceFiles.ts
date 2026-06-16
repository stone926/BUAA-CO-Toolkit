import * as path from 'path';
import * as vscode from 'vscode';
import { workspaceFolderFor } from './fsUtil';
import { CourseTraceCaseInput } from './courseTestCases';

export function simOutputFileNameForCase(item: CourseTraceCaseInput): string {
  return `${traceOutputStem(item)}.sim.out`;
}

export function logisimRawOutputFileNameForCase(item: CourseTraceCaseInput): string {
  return `${traceOutputStem(item)}.logisim.out`;
}

export function courseTraceOutputDirectory(resource: vscode.Uri): vscode.Uri {
  const folder = workspaceFolderFor(resource);
  const baseDir = folder?.uri.fsPath ?? path.dirname(resource.fsPath);
  return vscode.Uri.file(path.join(baseDir, '.co', 'out'));
}

export function normalizePathKey(file: string): string {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function traceOutputStem(item: CourseTraceCaseInput): string {
  const asmName = path.basename(item.asm.fsPath, path.extname(item.asm.fsPath));
  if (!item.stdin) {
    return asmName;
  }
  const stdinName = path.basename(item.stdin.fsPath, path.extname(item.stdin.fsPath));
  return `${asmName}.${sanitizeTraceFileStem(stdinName)}`;
}

function sanitizeTraceFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_') || 'stdin';
}
