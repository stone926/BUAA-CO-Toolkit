// @index verilog-ise-diagnostics — ISE fuse 输出的纯解析记录，供 LSP 与仿真报告复用

export type IseDiagnosticSeverity = 'error' | 'warning' | 'information';

export interface IseDiagnosticRecord {
  file?: string;
  line?: number;
  severity: IseDiagnosticSeverity;
  message: string;
}

/** Parse one ISE fuse diagnostic without resolving or exposing filesystem paths. */
export function parseIseDiagnosticRecord(line: string): IseDiagnosticRecord | undefined {
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
  const parsedLine = Number(match[3]);
  return {
    ...(match[2] ? { file: match[2] } : {}),
    ...(Number.isSafeInteger(parsedLine) && parsedLine > 0 ? { line: parsedLine } : {}),
    severity: severityLabel === 'ERROR'
      ? 'error'
      : severityLabel === 'WARNING'
        ? 'warning'
        : 'information',
    message: match[4]?.trim() || trimmed
  };
}

export function parseIseDiagnosticRecords(output: string): IseDiagnosticRecord[] {
  return output
    .split(/\r?\n/)
    .map(parseIseDiagnosticRecord)
    .filter((record): record is IseDiagnosticRecord => record !== undefined);
}
