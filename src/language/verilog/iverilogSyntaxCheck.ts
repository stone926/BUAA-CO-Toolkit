// @index iverilog-syntax-check — bundled Icarus -tnull 检查与最小诊断解析
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity, Range, WorkspaceFolder } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import {
  buildIverilogIncludeArgs,
  buildIverilogEnvironment,
  buildIverilogRuntimeArgs,
  preflightIverilogRuntime
} from '../../verilog/iverilogRuntime';
import { parseIverilogDiagnosticRecords } from '../../verilog/iverilogDiagnostics';
import { runProcessCore } from '../../processCore';
import { resolveExternalSyntaxProject } from './externalSyntaxProject';

export interface IverilogSyntaxCheckOptions {
  workspaceFolders: WorkspaceFolder[] | null | undefined;
  triggerUri: string;
  extensionRoot: string | undefined;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface IverilogSyntaxCheckResult {
  ok: boolean;
  skipped?: 'no-files';
  diagnosticsByUri: Map<string, Diagnostic[]>;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  toolchainError?: string;
}

const defaultTimeoutMs = 120000;
const maxOutputBytes = 4 * 1024 * 1024;

export async function runIverilogSyntaxCheck(
  options: IverilogSyntaxCheckOptions
): Promise<IverilogSyntaxCheckResult> {
  const project = await resolveExternalSyntaxProject(options.workspaceFolders, options.triggerUri);
  if (!project?.sources.length) {
    return emptyResult(false, 'no-files');
  }
  const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : defaultTimeoutMs;
  const extensionRoot = options.extensionRoot?.trim();
  if (!extensionRoot) {
    return toolchainFailure(
      options.triggerUri,
      '无法定位内置 Icarus Verilog：语言服务器未收到扩展安装目录。'
    );
  }

  let preflight;
  try {
    preflight = await preflightIverilogRuntime(extensionRoot, {
      signal: options.signal,
      timeoutMs: Math.min(timeoutMs, 10000)
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return toolchainFailure(options.triggerUri, `内置 Icarus Verilog 不可用：${detail}`);
  }

  const args = [
    ...buildIverilogRuntimeArgs(preflight.runtime),
    '-g2005',
    ...buildIverilogIncludeArgs(project.root, project.sources),
    '-tnull',
    '-i',
    ...project.sources
  ];
  const run = await runProcessCore(preflight.runtime.iverilogPath, args, {
    cwd: project.root,
    env: buildIverilogEnvironment(preflight.runtime),
    timeoutMs,
    signal: options.signal,
    maxStdoutBytes: maxOutputBytes,
    maxStderrBytes: maxOutputBytes
  });
  const diagnosticsByUri = parseIverilogDiagnostics(
    `${run.stdout}\n${run.stderr}`,
    project.root
  );
  if (!run.ok && diagnosticsByUri.size === 0) {
    addDiagnostic(diagnosticsByUri, options.triggerUri, {
      range: Range.create(0, 0, 0, 1),
      severity: DiagnosticSeverity.Error,
      source: 'Icarus Verilog',
      code: 'iverilog-syntax',
      message: run.timedOut
        ? 'Icarus Verilog syntax check timed out.'
        : firstNonEmptyLine(run.stderr || run.stdout) || 'Icarus Verilog syntax check failed.'
    });
  }
  return {
    ok: run.ok,
    diagnosticsByUri,
    stdout: run.stdout,
    stderr: run.stderr,
    timedOut: run.timedOut
  };
}

export function parseIverilogDiagnostics(
  output: string,
  workspaceRoot: string
): Map<string, Diagnostic[]> {
  const diagnosticsByUri = new Map<string, Diagnostic[]>();
  for (const parsed of parseIverilogDiagnosticRecords(output)) {
    const lineNumber = parsed.line - 1;
    const character = (parsed.column ?? 1) - 1;
    addDiagnostic(diagnosticsByUri, uriForIverilogPath(parsed.file, workspaceRoot), {
      range: Range.create(lineNumber, character, lineNumber, character + 1),
      severity: parsed.severity === 'warning'
        ? DiagnosticSeverity.Warning
        : parsed.severity === 'information'
          ? DiagnosticSeverity.Information
          : DiagnosticSeverity.Error,
      source: 'Icarus Verilog',
      code: 'iverilog-syntax',
      message: parsed.message
    });
  }
  return diagnosticsByUri;
}

function uriForIverilogPath(file: string, workspaceRoot: string): string {
  const normalized = file.replace(/\//g, path.sep);
  const resolved = path.isAbsolute(normalized)
    ? normalized
    : path.resolve(workspaceRoot, normalized);
  return URI.file(resolved).toString();
}

function toolchainFailure(triggerUri: string, message: string): IverilogSyntaxCheckResult {
  const diagnosticsByUri = new Map<string, Diagnostic[]>();
  addDiagnostic(diagnosticsByUri, triggerUri, {
    range: Range.create(0, 0, 0, 1),
    severity: DiagnosticSeverity.Error,
    source: 'Icarus Verilog',
    code: 'iverilog-toolchain',
    message
  });
  return {
    ok: false,
    diagnosticsByUri,
    stdout: '',
    stderr: message,
    timedOut: false,
    toolchainError: message
  };
}

function addDiagnostic(map: Map<string, Diagnostic[]>, uri: string, diagnostic: Diagnostic): void {
  const list = map.get(uri) ?? [];
  list.push(diagnostic);
  map.set(uri, list);
}

function emptyResult(ok: boolean, skipped: IverilogSyntaxCheckResult['skipped']): IverilogSyntaxCheckResult {
  return {
    ok,
    skipped,
    diagnosticsByUri: new Map(),
    stdout: '',
    stderr: '',
    timedOut: false
  };
}

function firstNonEmptyLine(text: string): string | undefined {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}
