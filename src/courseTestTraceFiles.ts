import * as path from 'path';
import * as vscode from 'vscode';
import { workspaceFolderFor } from './fsUtil';
import { CourseTraceCaseInput } from './courseTestCases';
import { normalizePathKey, sanitizeFileStem } from './pathUtils';

export function simOutputFileNameForCase(item: CourseTraceCaseInput): string {
  return `${traceOutputStem(item)}.sim.out`;
}

export function marsOutputFileNameForCase(item: CourseTraceCaseInput): string {
  return `${traceOutputStem(item)}.mars.out`;
}

export function logisimRawOutputFileNameForCase(item: CourseTraceCaseInput): string {
  return `${traceOutputStem(item)}.logisim.out`;
}

export function courseTraceOutputDirectory(resource: vscode.Uri): vscode.Uri {
  const folder = workspaceFolderFor(resource);
  const baseDir = folder?.uri.fsPath ?? path.dirname(resource.fsPath);
  return vscode.Uri.file(path.join(baseDir, '.co', 'out'));
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
  return sanitizeFileStem(value, {
    fallback: 'stdin',
    trimOuterUnderscores: false
  });
}
