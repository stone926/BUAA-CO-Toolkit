import { CpuTraceEvent, formatTraceEvent } from '../language/mips/traceParser';
import { appendHaltLoop } from './mipsUtil';
import { parseMachineCodeWords } from '../language/logisim/rom';

export const defaultLogisimTraceCircuit = 'main';
export const p3TextBase = 0x3000;
export const p3LogisimMaxWords = 4096;
export const p3LogisimHaltWords = 2;
export const p3LogisimMaxProgramWords = p3LogisimMaxWords - p3LogisimHaltWords;

export type LogisimTraceRequiredLabel =
  | 'pc'
  | 'regwrite'
  | 'regaddr'
  | 'regdata'
  | 'memwrite'
  | 'memaddr'
  | 'memdata';

export interface LogisimTraceOutputColumn {
  index: number;
  label: string;
  canonicalLabel: string;
  width: number;
  x: number;
  y: number;
}

export interface LogisimTraceSpec {
  circuitName: string;
  columns: LogisimTraceOutputColumn[];
  required: Record<LogisimTraceRequiredLabel, LogisimTraceOutputColumn>;
  hasHalt: boolean;
}

export interface P3LogisimMachineCode {
  originalWordCount: number;
  terminatedWordCount: number;
  haltPc: number;
  haltPcHex: string;
  text: string;
}

export interface LogisimTraceValue {
  raw: string;
  width: number;
  unknown: boolean;
  hex: string;
  numeric?: number;
}

export interface LogisimTraceRow {
  rowNumber: number;
  lineNumber: number;
  raw: string;
  values: Record<LogisimTraceRequiredLabel, LogisimTraceValue>;
}

const requiredLabels: LogisimTraceRequiredLabel[] = [
  'pc',
  'regwrite',
  'regaddr',
  'regdata',
  'memwrite',
  'memaddr',
  'memdata'
];

const circuitPattern = /<circuit\b[^>]*\bname="([^"]+)"[^>]*>[\s\S]*?<\/circuit>/g;
const pinPattern = /<comp\b[^>]*\bname="Pin"[^>]*(?:\/>|>[\s\S]*?<\/comp>)/g;
const attrPattern = /<a\b[^>]*>/g;

export function parseLogisimTraceSpec(circuitText: string, circuitName = defaultLogisimTraceCircuit): LogisimTraceSpec {
  const circuit = findCircuitBlock(circuitText, circuitName);
  if (!circuit) {
    throw new Error(`Logisim circuit "${circuitName}" was not found.`);
  }

  const outputs = findOutputPins(circuit)
    .sort((left, right) => left.y - right.y || left.x - right.x);
  const columns: LogisimTraceOutputColumn[] = [];
  let hasHalt = false;

  for (const output of outputs) {
    const canonicalLabel = canonicalLogisimTraceLabel(output.label);
    if (canonicalLabel === 'halt') {
      hasHalt = true;
      continue;
    }
    columns.push({
      ...output,
      canonicalLabel,
      index: columns.length
    });
  }

  const byLabel = new Map<string, LogisimTraceOutputColumn>();
  for (const column of columns) {
    if (!column.canonicalLabel) {
      continue;
    }
    if (byLabel.has(column.canonicalLabel)) {
      throw new Error(`Logisim trace circuit "${circuitName}" has duplicate output label "${column.label}".`);
    }
    byLabel.set(column.canonicalLabel, column);
  }

  const missing = requiredLabels.filter((label) => !byLabel.has(label));
  if (missing.length) {
    throw new Error(`Logisim trace circuit "${circuitName}" is missing output pin(s): ${missing.join(', ')}.`);
  }

  return {
    circuitName,
    columns,
    required: Object.fromEntries(requiredLabels.map((label) => [label, byLabel.get(label)])) as Record<LogisimTraceRequiredLabel, LogisimTraceOutputColumn>,
    hasHalt
  };
}

export function setLogisimMainCircuit(circuitText: string, circuitName: string): string {
  const main = `<main name="${escapeXmlAttribute(circuitName)}"/>`;
  if (/<main\b[^>]*\/>/.test(circuitText)) {
    return circuitText.replace(/<main\b[^>]*\/>/, main);
  }
  if (/<options\b/.test(circuitText)) {
    return circuitText.replace(/<options\b/, `${main}\n  <options`);
  }
  return circuitText.replace(/(<project\b[^>]*>)/, `$1\n  ${main}`);
}

export function prepareP3LogisimMachineCode(machineCodeText: string): P3LogisimMachineCode {
  const words = parseMachineCodeWords(machineCodeText);
  if (!words.length) {
    throw new Error('MARS dump produced no machine-code words.');
  }
  if (words.length > p3LogisimMaxProgramWords) {
    throw new Error(`P3 Logisim test has ${words.length} words before halt loop; maximum is ${p3LogisimMaxProgramWords}.`);
  }
  const text = appendHaltLoop(words.join('\n') + '\n');
  const terminatedWordCount = parseMachineCodeWords(text).length;
  if (terminatedWordCount > p3LogisimMaxWords) {
    throw new Error(`P3 Logisim machine code has ${terminatedWordCount} words after halt loop; maximum is ${p3LogisimMaxWords}.`);
  }
  const haltPc = p3TextBase + words.length * 4;
  return {
    originalWordCount: words.length,
    terminatedWordCount,
    haltPc,
    haltPcHex: formatHex(haltPc, 8),
    text
  };
}

export function parseLogisimTraceOutput(text: string, spec: LogisimTraceSpec): { rows: LogisimTraceRow[]; events: CpuTraceEvent[] } {
  const rows: LogisimTraceRow[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const row = parseLogisimTraceLine(lines[i], spec, i + 1, rows.length + 1);
    if (row) {
      rows.push(row);
    }
  }
  return {
    rows,
    events: logisimRowsToTraceEvents(rows)
  };
}

export function parseLogisimTraceLine(
  line: string,
  spec: LogisimTraceSpec,
  lineNumber = 1,
  rowNumber = 1
): LogisimTraceRow | undefined {
  const raw = line.trim();
  if (!raw || isNonTableLine(raw)) {
    return undefined;
  }
  const cells = line.split('\t');
  if (cells.length !== spec.columns.length) {
    if (cells.length === 1 && !looksLikeTableLine(raw)) {
      return undefined;
    }
    throw new Error(`Logisim table row ${lineNumber} has ${cells.length} column(s); expected ${spec.columns.length}.`);
  }

  const values = Object.fromEntries(requiredLabels.map((label) => {
    const column = spec.required[label];
    return [label, parseLogisimTraceValue(cells[column.index], column.width)];
  })) as Record<LogisimTraceRequiredLabel, LogisimTraceValue>;

  return {
    rowNumber,
    lineNumber,
    raw,
    values
  };
}

export function logisimRowsToTraceEvents(rows: readonly LogisimTraceRow[]): CpuTraceEvent[] {
  const events: CpuTraceEvent[] = [];
  for (const row of rows) {
    const pc = requiredKnown(row, 'pc');
    const regWrite = requiredKnown(row, 'regwrite').numeric;
    const memWrite = requiredKnown(row, 'memwrite').numeric;

    if (regWrite === undefined || memWrite === undefined) {
      throw new Error(`Logisim row ${row.lineNumber} has non-numeric write-enable value.`);
    }

    if (regWrite !== 0) {
      const reg = requiredKnown(row, 'regaddr');
      const value = requiredKnown(row, 'regdata');
      if (reg.numeric === undefined) {
        throw new Error(`Logisim row ${row.lineNumber} has non-numeric register address.`);
      }
      if (reg.numeric !== 0) {
        events.push(makeTraceEvent(row, pc.hex, 'grf', String(reg.numeric), value.hex));
      }
    }

    if (memWrite !== 0) {
      const addr = requiredKnown(row, 'memaddr');
      const value = requiredKnown(row, 'memdata');
      events.push(makeTraceEvent(row, pc.hex, 'dm', addr.hex, value.hex));
    }
  }
  return events;
}

export function formatLogisimTraceEvents(events: readonly CpuTraceEvent[]): string {
  return events.map(formatTraceEvent).join('\n') + (events.length ? '\n' : '');
}

export function logisimRowPcHex(line: string, spec: LogisimTraceSpec): string | undefined {
  const row = parseLogisimTraceLine(line, spec);
  if (!row) {
    return undefined;
  }
  const pc = row.values.pc;
  return pc.unknown ? undefined : pc.hex;
}

function findCircuitBlock(circuitText: string, circuitName: string): string | undefined {
  circuitPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = circuitPattern.exec(circuitText))) {
    if (decodeXmlAttribute(match[1]) === circuitName) {
      return match[0];
    }
  }
  return undefined;
}

function findOutputPins(circuitBlock: string): Array<Omit<LogisimTraceOutputColumn, 'index' | 'canonicalLabel'>> {
  const pins: Array<Omit<LogisimTraceOutputColumn, 'index' | 'canonicalLabel'>> = [];
  pinPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pinPattern.exec(circuitBlock))) {
    const block = match[0];
    if (attributeValue(block, 'output') !== 'true') {
      continue;
    }
    const loc = block.match(/\bloc="\((\d+),(\d+)\)"/);
    if (!loc) {
      continue;
    }
    pins.push({
      x: Number(loc[1]),
      y: Number(loc[2]),
      label: attributeValue(block, 'label') ?? '',
      width: numericAttributeValue(block, 'width') ?? 1
    });
  }
  return pins;
}

function parseLogisimTraceValue(rawValue: string, width: number): LogisimTraceValue {
  const raw = rawValue.trim();
  const compact = raw.replace(/[\s_]/g, '').toLowerCase();
  if (!compact || /[xz]/.test(compact)) {
    return {
      raw,
      width,
      unknown: true,
      hex: 'x'.repeat(Math.max(1, Math.ceil(width / 4)))
    };
  }

  let value: bigint;
  if (/^0x[0-9a-f]+$/i.test(compact)) {
    value = BigInt(compact);
  } else if (/^[01]+$/.test(compact)) {
    value = BigInt(`0b${compact}`);
  } else if (/^[0-9a-f]+$/i.test(compact)) {
    value = BigInt(`0x${compact}`);
  } else {
    return {
      raw,
      width,
      unknown: true,
      hex: 'x'.repeat(Math.max(1, Math.ceil(width / 4)))
    };
  }

  const hex = formatHexBigInt(value, Math.max(1, Math.ceil(width / 4)));
  return {
    raw,
    width,
    unknown: false,
    hex,
    numeric: value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined
  };
}

function makeTraceEvent(
  row: LogisimTraceRow,
  pc: string,
  kind: CpuTraceEvent['kind'],
  target: string,
  value: string
): CpuTraceEvent {
  const raw = `@${pc}: ${kind === 'grf' ? '$' : '*'}${target} <= ${value}`;
  return {
    pc,
    kind,
    target,
    value,
    raw,
    lineNumber: row.lineNumber
  };
}

function requiredKnown(row: LogisimTraceRow, label: LogisimTraceRequiredLabel): LogisimTraceValue {
  const value = row.values[label];
  if (value.unknown) {
    throw new Error(`Logisim row ${row.lineNumber} has unknown ${label} value.`);
  }
  return value;
}

function attributeValue(block: string, name: string): string | undefined {
  attrPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(block))) {
    const tag = match[0];
    if (tag.match(/\bname="([^"]+)"/)?.[1] === name) {
      return decodeXmlAttribute(tag.match(/\bval="([^"]*)"/)?.[1] ?? '');
    }
  }
  return undefined;
}

function numericAttributeValue(block: string, name: string): number | undefined {
  const value = attributeValue(block, name);
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

function canonicalLogisimTraceLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[_\-\s]+/g, '');
}

function isNonTableLine(line: string): boolean {
  return /^halted\b/i.test(line)
    || /\bHz\b/i.test(line)
    || /^Exception\b/i.test(line)
    || /^Error\b/i.test(line);
}

function looksLikeTableLine(line: string): boolean {
  return /^[0-9a-fxXzZ\s\t]+$/.test(line);
}

function formatHex(value: number, width: number): string {
  return (value >>> 0).toString(16).toUpperCase().padStart(width, '0').slice(-width);
}

function formatHexBigInt(value: bigint, width: number): string {
  const maskBits = BigInt(width * 4);
  const mask = (BigInt(1) << maskBits) - BigInt(1);
  return (value & mask).toString(16).toUpperCase().padStart(width, '0').slice(-width);
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
