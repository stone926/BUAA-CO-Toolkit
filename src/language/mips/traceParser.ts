export type CpuTraceKind = 'grf' | 'dm';

export interface CpuTraceEvent {
  cycle?: number;
  pc: string;
  kind: CpuTraceKind;
  target: string;
  value: string;
  raw: string;
  lineNumber: number;
}

const tracePattern = /^(?:(\d+)@|@)(?:0x)?([0-9a-fxz]{1,8}):\s*(\$|\*)\s*(?:0x)?([0-9a-fxz]+)\s*<=\s*(?:0x)?([0-9a-fxz]{1,8})$/i;

export function parseMarsOutput(text: string): CpuTraceEvent[] {
  return parseCpuTraceOutput(text);
}

export function parseCpuTraceOutput(text: string): CpuTraceEvent[] {
  const events: CpuTraceEvent[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const event = parseCpuTraceLine(lines[i], i + 1);
    if (event) {
      events.push(event);
    }
  }
  return events;
}

export function parseCpuTraceLine(line: string, lineNumber = 1): CpuTraceEvent | undefined {
  const raw = line.trim();
  const match = tracePattern.exec(raw);
  if (!match) {
    return undefined;
  }

  const kind: CpuTraceKind = match[3] === '$' ? 'grf' : 'dm';
  return {
    cycle: match[1] === undefined ? undefined : Number(match[1]),
    pc: normalizeHexToken(match[2], 8),
    kind,
    target: normalizeTarget(match[4], kind),
    value: normalizeHexToken(match[5], 8),
    raw,
    lineNumber
  };
}

export function formatTraceEvent(event: CpuTraceEvent): string {
  const prefix = event.cycle === undefined ? '' : `${event.cycle}`;
  const targetPrefix = event.kind === 'grf' ? '$' : '*';
  return `${prefix}@${event.pc}: ${targetPrefix}${event.target} <= ${event.value}`;
}

function normalizeTarget(value: string, kind: CpuTraceKind): string {
  const token = stripHexPrefix(value).toUpperCase();
  if (kind === 'grf') {
    return /^\d+$/.test(token) ? String(Number(token)) : token;
  }
  return normalizeHexToken(token, 8);
}

function normalizeHexToken(value: string, width: number): string {
  const token = stripHexPrefix(value).toUpperCase();
  if (/^[0-9A-F]+$/.test(token)) {
    return token.padStart(width, '0').slice(-width);
  }
  return token;
}

function stripHexPrefix(value: string): string {
  return value.replace(/^0x/i, '');
}
