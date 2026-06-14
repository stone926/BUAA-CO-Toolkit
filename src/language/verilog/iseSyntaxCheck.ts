import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity, Range, WorkspaceFolder } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { buildIseEnvironment, findFuse } from '../../iseCommon';
import { buildIseProjectText } from '../../verilogSimulationFiles';

export interface IseSyntaxCheckOptions {
  workspaceFolders: WorkspaceFolder[] | null | undefined;
  triggerUri: string;
  isePath: string;
  topModule: string;
  fallbackTopModule?: string;
  timeoutMs: number;
}

export interface IseSyntaxCheckResult {
  ok: boolean;
  skipped?: 'missing-toolchain' | 'no-files' | 'no-top';
  diagnosticsByUri: Map<string, Diagnostic[]>;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface RunProcessResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const defaultTimeoutMs = 120000;

export async function runIseSyntaxCheck(options: IseSyntaxCheckOptions): Promise<IseSyntaxCheckResult> {
  const isePath = options.isePath.trim();
  const fuse = isePath ? findFuse(isePath) : '';
  if (!fuse || !safeIsFile(fuse)) {
    return emptyResult(false, 'missing-toolchain');
  }

  const root = workspaceRootFor(options.workspaceFolders, options.triggerUri);
  if (!root) {
    return emptyResult(false, 'no-files');
  }
  const files = scanVerilogFiles(root, 5000);
  if (!files.length) {
    return emptyResult(false, 'no-files');
  }

  const topModule = (options.topModule.trim() || options.fallbackTopModule?.trim() || '').trim();
  if (!topModule) {
    return emptyResult(false, 'no-top');
  }

  const outDir = path.join(root, '.co', 'ise-check');
  await fs.promises.mkdir(outDir, { recursive: true });
  const prj = path.join(outDir, 'co_syntax.prj');
  await fs.promises.writeFile(prj, buildIseProjectText(files), 'utf8');

  const exeName = process.platform === 'win32' ? 'co_syntax.exe' : 'co_syntax';
  const run = await runProcess(fuse, ['--incremental', '-nodebug', '-prj', path.basename(prj), '-o', exeName, topModule], {
    cwd: outDir,
    env: buildIseEnvironment(isePath),
    timeoutMs: options.timeoutMs > 0 ? options.timeoutMs : defaultTimeoutMs
  });
  const diagnosticsByUri = parseFuseDiagnostics(`${run.stdout}\n${run.stderr}`, root, options.triggerUri);
  if (!run.ok && diagnosticsByUri.size === 0) {
    addDiagnostic(diagnosticsByUri, options.triggerUri, {
      range: Range.create(0, 0, 0, 1),
      severity: DiagnosticSeverity.Error,
      source: 'ISE fuse',
      code: 'ise-syntax',
      message: firstNonEmptyLine(run.stderr || run.stdout) || (run.timedOut ? 'ISE syntax check timed out.' : 'ISE syntax check failed.')
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

export function parseFuseDiagnostics(output: string, workspaceRoot: string, fallbackUri: string): Map<string, Diagnostic[]> {
  const diagnosticsByUri = new Map<string, Diagnostic[]>();
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseFuseDiagnosticLine(line, workspaceRoot, fallbackUri);
    if (!parsed) {
      continue;
    }
    addDiagnostic(diagnosticsByUri, parsed.uri, parsed.diagnostic);
  }
  return diagnosticsByUri;
}

function parseFuseDiagnosticLine(
  line: string,
  workspaceRoot: string,
  fallbackUri: string
): { uri: string; diagnostic: Diagnostic } | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(ERROR|WARNING|INFO):[^-]*-\s+(?:"([^"]+)"\s+)?(?:Line\s+(\d+):\s*)?(.+)$/i.exec(trimmed)
    ?? /^(ERROR|WARNING|INFO):.*?(?:"([^"]+)")\s+Line\s+(\d+):\s*(.+)$/i.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const severityLabel = match[1].toUpperCase();
  const file = match[2];
  const lineText = match[3];
  const message = match[4]?.trim() || trimmed;
  const uri = file ? uriForFusePath(file, workspaceRoot) : fallbackUri;
  const lineNumber = Math.max(0, Number(lineText ?? 1) - 1);
  const severity = severityLabel === 'ERROR'
    ? DiagnosticSeverity.Error
    : severityLabel === 'WARNING'
      ? DiagnosticSeverity.Warning
      : DiagnosticSeverity.Information;
  return {
    uri,
    diagnostic: {
      range: Range.create(lineNumber, 0, lineNumber, 1),
      severity,
      source: 'ISE fuse',
      code: 'ise-syntax',
      message
    }
  };
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<RunProcessResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env
      },
      shell: false,
      windowsHide: true
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stderr += error.message;
      resolve({ ok: false, exitCode: null, stdout, stderr, timedOut });
    });
    child.on('close', (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, exitCode: code, stdout, stderr, timedOut });
    });
  });
}

function scanVerilogFiles(root: string, limit: number): string[] {
  const result: string[] = [];
  const stack = [root];
  while (stack.length && result.length < limit) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.v')) {
        result.push(fullPath);
        if (result.length >= limit) {
          break;
        }
      }
    }
  }
  return result.sort();
}

function workspaceRootFor(workspaceFolders: WorkspaceFolder[] | null | undefined, triggerUri: string): string | undefined {
  const triggerPath = fsPathFromUri(triggerUri);
  const matching = workspaceFolders
    ?.map((folder) => fsPathFromUri(folder.uri))
    .filter((folder): folder is string => Boolean(folder))
    .sort((left, right) => right.length - left.length)
    .find((folder) => triggerPath ? isInsideDirectory(triggerPath, folder) : true);
  return matching ?? (triggerPath ? path.dirname(triggerPath) : undefined);
}

function shouldSkipDirectory(name: string): boolean {
  return name === '.git' ||
    name === '.co' ||
    name === '.vscode' ||
    name === '.vscode-test' ||
    name === 'node_modules' ||
    name === 'out' ||
    name === 'dist' ||
    name === 'build' ||
    name === 'coverage';
}

function uriForFusePath(file: string, workspaceRoot: string): string {
  const normalized = file.replace(/\//g, path.sep);
  const resolved = path.isAbsolute(normalized)
    ? normalized
    : path.resolve(workspaceRoot, normalized);
  return URI.file(resolved).toString();
}

function fsPathFromUri(uri: string): string | undefined {
  try {
    return URI.parse(uri).fsPath;
  } catch {
    return undefined;
  }
}

function isInsideDirectory(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeIsFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
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
