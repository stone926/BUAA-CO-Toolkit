import { CO_ISE_CHECK_DIR } from '../../constants';
import * as fs from 'fs';
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity, Range, WorkspaceFolder } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { buildIseEnvironment, findFuse, isimExecutableName } from '../../iseCommon';
import { buildIseProjectText } from '../../verilogSimulationFiles';
import { isFile } from '../../nodeFs';
import { runProcessCore } from '../../processCore';
import type { CoSettings } from '../common/settings';
import { resolveExternalSyntaxProject } from './externalSyntaxProject';
import { filterIseDiagnosticsByUri } from './iseDiagnosticFilters';
import { parseIseDiagnosticRecords } from '../../verilog/iseDiagnostics';

export interface IseSyntaxCheckOptions {
  workspaceFolders: WorkspaceFolder[] | null | undefined;
  triggerUri: string;
  isePath: string;
  topModule: string;
  fallbackTopModule?: string;
  timeoutMs: number;
  settings: CoSettings;
  signal?: AbortSignal;
}

export interface IseSyntaxCheckResult {
  ok: boolean;
  skipped?: 'missing-toolchain' | 'no-files' | 'no-top';
  diagnosticsByUri: Map<string, Diagnostic[]>;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const defaultTimeoutMs = 120000;

export async function runIseSyntaxCheck(options: IseSyntaxCheckOptions): Promise<IseSyntaxCheckResult> {
  const isePath = options.isePath.trim();
  const fuse = isePath ? findFuse(isePath) : '';
  if (!fuse || !await isFile(fuse)) {
    return emptyResult(false, 'missing-toolchain');
  }

  const project = await resolveExternalSyntaxProject(options.workspaceFolders, options.triggerUri);
  if (!project?.sources.length) {
    return emptyResult(false, 'no-files');
  }

  const topModule = (options.topModule.trim() || options.fallbackTopModule?.trim() || '').trim();
  if (!topModule) {
    return emptyResult(false, 'no-top');
  }

  const outDir = path.join(project.root, CO_ISE_CHECK_DIR);
  await fs.promises.mkdir(outDir, { recursive: true });
  const prj = path.join(outDir, 'co_syntax.prj');
  await fs.promises.writeFile(prj, buildIseProjectText(project.sources), 'utf8');

  const exeName = isimExecutableName('co_syntax', fuse);
  const run = await runProcessCore(fuse, ['--incremental', '-nodebug', '-prj', path.basename(prj), '-o', exeName, topModule], {
    cwd: outDir,
    env: buildIseEnvironment(isePath),
    timeoutMs: options.timeoutMs > 0 ? options.timeoutMs : defaultTimeoutMs,
    signal: options.signal
  });
  const rawDiagnosticsByUri = parseFuseDiagnostics(`${run.stdout}\n${run.stderr}`, project.root, options.triggerUri);
  if (!run.ok && rawDiagnosticsByUri.size === 0) {
    addDiagnostic(rawDiagnosticsByUri, options.triggerUri, {
      range: Range.create(0, 0, 0, 1),
      severity: DiagnosticSeverity.Error,
      source: 'ISE fuse',
      code: 'ise-syntax',
      message: firstNonEmptyLine(run.stderr || run.stdout) || (run.timedOut ? 'ISE syntax check timed out.' : 'ISE syntax check failed.')
    });
  }
  const diagnosticsByUri = filterIseDiagnosticsByUri(rawDiagnosticsByUri, options.settings);
  return {
    ok: run.ok,
    diagnosticsByUri,
    stdout: run.stdout,
    stderr: run.stderr,
    timedOut: run.timedOut
  };
}

export function parseFuseDiagnostics(output: string, workspaceRoot: string, fallbackUri: string): Map<string, Diagnostic[]> {
  const diagnosticsByUri = new Map<string, Diagnostic[]>();
  for (const record of parseIseDiagnosticRecords(output)) {
    const uri = record.file ? uriForFusePath(record.file, workspaceRoot) : fallbackUri;
    const lineNumber = Math.max(0, (record.line ?? 1) - 1);
    const severity = record.severity === 'error'
    ? DiagnosticSeverity.Error
    : record.severity === 'warning'
      ? DiagnosticSeverity.Warning
      : DiagnosticSeverity.Information;
    addDiagnostic(diagnosticsByUri, uri, {
      range: Range.create(lineNumber, 0, lineNumber, 1),
      severity,
      source: 'ISE fuse',
      code: 'ise-syntax',
      message: record.message
    });
  }
  return diagnosticsByUri;
}

function uriForFusePath(file: string, workspaceRoot: string): string {
  const normalized = file.replace(/\//g, path.sep);
  const resolved = path.isAbsolute(normalized)
    ? normalized
    : path.resolve(workspaceRoot, normalized);
  return URI.file(resolved).toString();
}

function addDiagnostic(map: Map<string, Diagnostic[]>, uri: string, diagnostic: Diagnostic): void {
  const list = map.get(uri) ?? [];
  list.push(diagnostic);
  map.set(uri, list);
}

function emptyResult(ok: boolean, skipped: IseSyntaxCheckResult['skipped']): IseSyntaxCheckResult {
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
