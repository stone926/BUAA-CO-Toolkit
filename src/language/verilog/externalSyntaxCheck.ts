// @index verilog-external-syntax-check — bundled Icarus syntax check
import { Diagnostic, DiagnosticSeverity, Range, WorkspaceFolder } from 'vscode-languageserver/node';
import { runIverilogSyntaxCheck } from './iverilogSyntaxCheck';

export interface ExternalVerilogSyntaxCheckOptions {
  workspaceFolders: WorkspaceFolder[] | null | undefined;
  triggerUri: string;
  extensionRoot: string | undefined;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ExternalVerilogSyntaxCheckResult {
  backend: 'iverilog';
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
  try {
    const result = await runIverilogSyntaxCheck(options);
    return { backend: 'iverilog', ...result };
  } catch (error) {
    const message = `Icarus Verilog 语法检查无法启动：${error instanceof Error ? error.message : String(error)}`;
    return {
      backend: 'iverilog',
      ok: false,
      diagnosticsByUri: new Map([[options.triggerUri, [{
        range: Range.create(0, 0, 0, 1),
        severity: DiagnosticSeverity.Error,
        source: 'Icarus Verilog',
        code: 'iverilog-toolchain',
        message
      }]]]),
      stdout: '',
      stderr: message,
      timedOut: false,
      toolchainError: message
    };
  }
}
