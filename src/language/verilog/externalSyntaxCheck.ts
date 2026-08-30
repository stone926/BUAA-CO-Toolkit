// @index verilog-external-syntax-check — isePath 驱动的 Icarus/ISE 外部语法检查薄分派
import { Diagnostic, DiagnosticSeverity, Range, WorkspaceFolder } from 'vscode-languageserver/node';
import { selectVerilogBackend, VerilogBackend } from '../../verilog/verilogBackend';
import type { CoSettings } from '../common/settings';
import { runIseSyntaxCheck } from './iseSyntaxCheck';
import { runIverilogSyntaxCheck } from './iverilogSyntaxCheck';

export interface ExternalVerilogSyntaxCheckOptions {
  workspaceFolders: WorkspaceFolder[] | null | undefined;
  triggerUri: string;
  extensionRoot: string | undefined;
  isePath: string;
  topModule: string;
  fallbackTopModule?: string;
  timeoutMs: number;
  settings: CoSettings;
  signal?: AbortSignal;
}

export interface ExternalVerilogSyntaxCheckResult {
  backend: VerilogBackend;
  ok: boolean;
  skipped?: 'no-files' | 'no-top';
  diagnosticsByUri: Map<string, Diagnostic[]>;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  toolchainError?: string;
}

export async function runExternalVerilogSyntaxCheck(
  options: ExternalVerilogSyntaxCheckOptions
): Promise<ExternalVerilogSyntaxCheckResult> {
  const backend = selectVerilogBackend(options.isePath);
  if (backend === 'iverilog') {
    try {
      const result = await runIverilogSyntaxCheck({
        workspaceFolders: options.workspaceFolders,
        triggerUri: options.triggerUri,
        extensionRoot: options.extensionRoot,
        timeoutMs: options.timeoutMs,
        signal: options.signal
      });
      return { backend, ...result };
    } catch (error) {
      return unexpectedExternalCheckFailure(backend, options.triggerUri, error);
    }
  }

  let result: Awaited<ReturnType<typeof runIseSyntaxCheck>>;
  try {
    result = await runIseSyntaxCheck({
      workspaceFolders: options.workspaceFolders,
      triggerUri: options.triggerUri,
      isePath: options.isePath,
      topModule: options.topModule,
      fallbackTopModule: options.fallbackTopModule,
      timeoutMs: options.timeoutMs,
      settings: options.settings,
      signal: options.signal
    });
  } catch (error) {
    return unexpectedExternalCheckFailure(backend, options.triggerUri, error);
  }
  const skipped = result.skipped;
  if (skipped !== 'missing-toolchain') {
    return {
      backend,
      ok: result.ok,
      skipped,
      diagnosticsByUri: result.diagnosticsByUri,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut
    };
  }

  const message = `已配置 co.toolchain.isePath，但未找到可用的 ISE fuse：${options.isePath.trim()}。不会回退到内置 Icarus。`;
  const diagnosticsByUri = new Map<string, Diagnostic[]>([[options.triggerUri, [{
    range: Range.create(0, 0, 0, 1),
    severity: DiagnosticSeverity.Error,
    source: 'ISE fuse',
    code: 'ise-toolchain',
    message
  }]]]);
  return {
    backend,
    ok: false,
    diagnosticsByUri,
    stdout: result.stdout,
    stderr: message,
    timedOut: false,
    toolchainError: message
  };
}

function unexpectedExternalCheckFailure(
  backend: VerilogBackend,
  triggerUri: string,
  error: unknown
): ExternalVerilogSyntaxCheckResult {
  const compiler = backend === 'isim' ? 'ISE fuse' : 'Icarus Verilog';
  const message = `${compiler} 语法检查无法启动：${error instanceof Error ? error.message : String(error)}`;
  return {
    backend,
    ok: false,
    diagnosticsByUri: new Map([[triggerUri, [{
      range: Range.create(0, 0, 0, 1),
      severity: DiagnosticSeverity.Error,
      source: compiler,
      code: backend === 'isim' ? 'ise-toolchain' : 'iverilog-toolchain',
      message
    }]]]),
    stdout: '',
    stderr: message,
    timedOut: false,
    toolchainError: message
  };
}
