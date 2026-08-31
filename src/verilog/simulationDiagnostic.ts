// @index verilog-simulation-diagnostic — 外部仿真失败的结构化归因、脱敏与限长摘要
import * as path from 'path';
import type { RunResult } from '../types';
import { parseIverilogDiagnosticRecords } from './iverilogDiagnostics';
import { parseIseDiagnosticRecords } from './iseDiagnostics';

export type VerilogSimulationFailurePhase = 'prepare' | 'compile' | 'simulate' | 'output';
export type VerilogSimulationFailureReason =
  | 'unavailable'
  | 'exit'
  | 'timeout'
  | 'cancelled'
  | 'output-limit'
  | 'process-error'
  | 'missing-output';

export interface VerilogSimulationDiagnostic {
  file?: string;
  line?: number;
  column?: number;
  message: string;
}

/** Safe to persist in public automatic reports after normalization. */
export interface VerilogSimulationFailure {
  phase: VerilogSimulationFailurePhase;
  reason: VerilogSimulationFailureReason;
  exitCode?: number;
  diagnostic?: VerilogSimulationDiagnostic;
}

const maximumDiagnosticFileLength = 160;
const maximumDiagnosticMessageLength = 320;

export function createVerilogSimulationFailure(
  backend: 'iverilog' | 'isim',
  phase: VerilogSimulationFailurePhase,
  result: RunResult | undefined,
  workspaceRoot?: string
): VerilogSimulationFailure {
  if (!result) {
    return { phase, reason: 'unavailable' };
  }
  const reason = failureReason(result);
  const diagnostic = reason === 'timeout' || reason === 'cancelled' || reason === 'output-limit'
    ? undefined
    : processDiagnostic(backend, result, workspaceRoot);
  return normalizeVerilogSimulationFailure({
    phase,
    reason,
    ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
    ...(diagnostic ? { diagnostic } : {})
  }, workspaceRoot);
}

export function missingVerilogSimulationOutputFailure(): VerilogSimulationFailure {
  return { phase: 'output', reason: 'missing-output' };
}

/** Revalidate report data at the public serialization/rendering boundary. */
export function normalizeVerilogSimulationFailure(
  failure: VerilogSimulationFailure,
  workspaceRoot?: string
): VerilogSimulationFailure {
  const phase = validPhase(failure.phase) ? failure.phase : 'prepare';
  const reason = validReason(failure.reason) ? failure.reason : 'process-error';
  const diagnostic = failure.diagnostic
    ? normalizeDiagnostic(failure.diagnostic, workspaceRoot)
    : undefined;
  return {
    phase,
    reason,
    ...(Number.isSafeInteger(failure.exitCode) ? { exitCode: failure.exitCode } : {}),
    ...(diagnostic ? { diagnostic } : {})
  };
}

export function verilogSimulationFailureMessage(
  failure: VerilogSimulationFailure,
  backend: 'iverilog' | 'isim' | 'logisim' | undefined
): string {
  const normalized = normalizeVerilogSimulationFailure(failure);
  const tool = backend === 'iverilog' ? 'Icarus' : backend === 'isim' ? 'ISim' : 'Verilog';
  const operation = normalized.phase === 'compile'
    ? '编译'
    : normalized.phase === 'simulate'
      ? '仿真'
      : normalized.phase === 'output'
        ? '输出处理'
        : '仿真准备';
  let summary: string;
  switch (normalized.reason) {
    case 'timeout':
      summary = `${tool} ${operation}超时`;
      break;
    case 'cancelled':
      summary = `${tool} ${operation}已取消`;
      break;
    case 'output-limit':
      summary = `${tool} ${operation}输出过多，进程已终止`;
      break;
    case 'missing-output':
      summary = `${tool} ${operation}未生成可读取的结果`;
      break;
    case 'unavailable':
      summary = `${tool} ${operation}未启动；请检查后端配置和顶层模块`;
      break;
    case 'process-error':
      summary = `${tool} ${operation}进程无法正常启动`;
      break;
    case 'exit':
      summary = `${tool} ${operation}失败${normalized.exitCode === undefined ? '' : `（退出码 ${normalized.exitCode}）`}`;
      break;
  }
  return normalized.diagnostic
    ? `${summary}：${diagnosticMessage(normalized.diagnostic)}`
    : summary;
}

function failureReason(result: RunResult): VerilogSimulationFailureReason {
  if (result.timedOut || result.stopReason === 'timeout') return 'timeout';
  if (result.stopReason === 'aborted') return 'cancelled';
  if (result.stopReason === 'stdout-limit' || result.stopReason === 'stderr-limit') return 'output-limit';
  if (result.exitCode === null) return 'process-error';
  return 'exit';
}

function processDiagnostic(
  backend: 'iverilog' | 'isim',
  result: RunResult,
  workspaceRoot?: string
): VerilogSimulationDiagnostic | undefined {
  const combined = [result.stderr, result.stdout].filter(Boolean).join('\n');
  if (backend === 'iverilog') {
    const records = parseIverilogDiagnosticRecords(combined);
    const errorIndex = records.findIndex((item) => item.severity === 'error');
    const recordIndex = errorIndex >= 0 ? errorIndex : 0;
    const record = records[recordIndex];
    if (record) {
      const declarationAfterUse = records
        .slice(recordIndex + 1, recordIndex + 3)
        .find((item) => item.file === record.file
          && /symbol.*declared here.*declaration after use/i.test(item.message));
      const primaryMessage = record.message
        .replace(/\s+in\s+`[^']+'$/i, '')
        .replace(/`([^']+)'/g, '“$1”');
      const message = declarationAfterUse
        ? `${primaryMessage}；同一符号在第 ${declarationAfterUse.line} 行才声明（请将声明移到首次使用之前）`
        : primaryMessage;
      return normalizeDiagnostic({
        file: record.file,
        line: record.line,
        ...(record.column === undefined ? {} : { column: record.column }),
        message
      }, workspaceRoot);
    }
  } else {
    const records = parseIseDiagnosticRecords(combined);
    const record = records.find((item) => item.severity === 'error') ?? records[0];
    if (record) {
      return normalizeDiagnostic({
        ...(record.file ? { file: record.file } : {}),
        ...(record.line === undefined ? {} : { line: record.line }),
        message: record.message
      }, workspaceRoot);
    }
  }
  const line = combined.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return line ? normalizeDiagnostic({ message: line }, workspaceRoot) : undefined;
}

function normalizeDiagnostic(
  diagnostic: VerilogSimulationDiagnostic,
  workspaceRoot?: string
): VerilogSimulationDiagnostic | undefined {
  const message = safeDiagnosticMessage(diagnostic.message, workspaceRoot);
  if (!message) {
    return undefined;
  }
  const file = diagnostic.file ? safeDiagnosticFile(diagnostic.file, workspaceRoot) : undefined;
  const line = positiveSafeInteger(diagnostic.line);
  const column = positiveSafeInteger(diagnostic.column);
  return {
    ...(file ? { file } : {}),
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    message
  };
}

function safeDiagnosticFile(file: string, workspaceRoot?: string): string | undefined {
  const cleaned = file.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (!cleaned) return undefined;
  const style = pathStyle(cleaned);
  let display = cleaned;
  if (style && workspaceRoot && pathStyle(workspaceRoot) === style) {
    const api = style === 'win32' ? path.win32 : path.posix;
    const relative = api.relative(workspaceRoot, cleaned);
    if (isContainedRelativePath(relative, api)) {
      display = relative;
    } else {
      display = api.basename(cleaned);
    }
  } else if (style) {
    display = (style === 'win32' ? path.win32 : path.posix).basename(cleaned);
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(cleaned)) {
    display = path.posix.basename(cleaned.replace(/\\/g, '/'));
  } else {
    const normalized = cleaned.replace(/\\/g, '/');
    display = isContainedRelativePath(normalized, path.posix)
      ? normalized
      : path.posix.basename(normalized);
  }
  display = display.replace(/\\/g, '/').replace(/^\.\//, '');
  return bounded(display, maximumDiagnosticFileLength);
}

function safeDiagnosticMessage(message: string, workspaceRoot?: string): string {
  let safe = message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (workspaceRoot) {
    safe = safe.replace(new RegExp(`${escapeRegExp(workspaceRoot.replace(/\\/g, '/'))}.*$`, 'ig'), '<path>');
    safe = safe.replace(new RegExp(`${escapeRegExp(workspaceRoot.replace(/\//g, '\\'))}.*$`, 'ig'), '<path>');
  }
  // Once a raw absolute path begins, redact the remainder of that compiler line. This is
  // deliberately conservative: public reports favor privacy over retaining trailing prose.
  safe = safe
    .replace(/\bfile:\/\/\/.*$/gi, '<path>')
    .replace(/\b[A-Za-z]:[\\/].*$/g, '<path>')
    .replace(/\\\\[^\s].*$/g, '<path>')
    .replace(/(^|[\s"'(])\/[^/].*$/g, '$1<path>');
  return bounded(safe, maximumDiagnosticMessageLength);
}

function diagnosticMessage(diagnostic: VerilogSimulationDiagnostic): string {
  const location = diagnostic.file
    ? `${diagnostic.file}${diagnostic.line === undefined ? '' : `:${diagnostic.line}`}${diagnostic.column === undefined ? '' : `:${diagnostic.column}`}`
    : undefined;
  return location ? `${location}: ${diagnostic.message}` : diagnostic.message;
}

function pathStyle(value: string): 'win32' | 'posix' | undefined {
  if (path.win32.isAbsolute(value)) return 'win32';
  if (path.posix.isAbsolute(value)) return 'posix';
  return undefined;
}

function isContainedRelativePath(relative: string, api: typeof path.win32 | typeof path.posix): boolean {
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${api.sep}`)
    && !api.isAbsolute(relative);
}

function positiveSafeInteger(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value : undefined;
}

function bounded(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  return `${value.slice(0, Math.max(0, maximumLength - 1)).trimEnd()}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validPhase(value: string): value is VerilogSimulationFailurePhase {
  return value === 'prepare' || value === 'compile' || value === 'simulate' || value === 'output';
}

function validReason(value: string): value is VerilogSimulationFailureReason {
  return value === 'unavailable'
    || value === 'exit'
    || value === 'timeout'
    || value === 'cancelled'
    || value === 'output-limit'
    || value === 'process-error'
    || value === 'missing-output';
}
