// @index verilog-iverilog-diagnostics — Icarus stderr 的后端无关行级解析

export type IverilogDiagnosticSeverity = 'error' | 'warning' | 'information';

export interface IverilogDiagnosticRecord {
  file: string;
  line: number;
  column?: number;
  severity: IverilogDiagnosticSeverity;
  message: string;
}

/**
 * Parse the stable `[ERROR|WARNING|FATAL:] path:line[:column]: [severity:] message`
 * forms emitted by Icarus and VVP.
 */
export function parseIverilogDiagnosticRecords(output: string): IverilogDiagnosticRecord[] {
  const records: IverilogDiagnosticRecord[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parsed = parseIverilogDiagnosticRecord(line);
    if (parsed) {
      records.push(parsed);
    }
  }
  return records;
}

export function parseIverilogDiagnosticRecord(line: string): IverilogDiagnosticRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  const prefixed = /^(ERROR|WARNING|FATAL):\s*(.+)$/i.exec(trimmed);
  const diagnosticText = prefixed?.[2] ?? trimmed;
  const match = /^(.+?):(\d+)(?::(\d+))?:\s*(?:(warning|error|sorry|info(?:rmation)?):\s*)?(.+)$/i.exec(diagnosticText);
  if (!match) {
    return undefined;
  }
  const lineNumber = Number(match[2]);
  const column = match[3] === undefined ? undefined : Number(match[3]);
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1
    || (column !== undefined && (!Number.isSafeInteger(column) || column < 1))) {
    return undefined;
  }
  const label = match[4]?.toLowerCase() ?? prefixed?.[1].toLowerCase();
  return {
    file: match[1],
    line: lineNumber,
    ...(column === undefined ? {} : { column }),
    severity: label === 'warning'
      ? 'warning'
      : label === 'info' || label === 'information'
        ? 'information'
        : 'error',
    message: match[5].trim()
  };
}
