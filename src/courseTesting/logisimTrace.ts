import { CpuTraceEvent, formatTraceEvent } from '../language/mips/traceParser';
import { appendHaltLoop, machineCodeHasHaltLoop } from './mipsUtil';
import { findLogisimRomTargets, LogisimRomTarget, parseMachineCodeWords } from '../language/logisim/rom';
import {
  canonicalizeP3LogisimTraceLabel,
  isP3LogisimTraceSemanticLabel,
  p3LogisimTraceProfile
} from './logisimTraceProfile';
import type {
  LogisimTraceRequiredLabel,
  LogisimTraceSemanticLabel
} from './logisimTraceProfile';

export type {
  LogisimTraceRequiredLabel,
  LogisimTraceSemanticLabel
} from './logisimTraceProfile';
export {
  p3LogisimTraceProfile
} from './logisimTraceProfile';

export const defaultLogisimTraceCircuit = p3LogisimTraceProfile.defaultCircuit;
export const p3TextBase = p3LogisimTraceProfile.textBase;
export const p3LogisimMaxWords = p3LogisimTraceProfile.romMaxWords;
export const p3LogisimHaltWords = p3LogisimTraceProfile.haltLoopWords;
export const p3LogisimMaxProgramWords = p3LogisimTraceProfile.maxProgramWords;
export type LogisimTraceMappingMode = 'explicit' | 'labels' | 'appearance' | 'position';
export type LogisimTraceColumnMap = Partial<Record<LogisimTraceSemanticLabel, number>>;

export interface LogisimTraceOutputColumn {
  index: number;
  label: string;
  logisimLabel: string;
  canonicalLabel: string;
  width: number;
  x: number;
  y: number;
  appearanceX?: number;
  appearanceY?: number;
}

export interface LogisimTraceSpec {
  circuitName: string;
  columns: LogisimTraceOutputColumn[];
  required: Record<LogisimTraceRequiredLabel, LogisimTraceOutputColumn>;
  instruction?: LogisimTraceOutputColumn;
  hasHalt: boolean;
  mappingMode: LogisimTraceMappingMode;
}

export interface LogisimTraceIgnoredOutputPin {
  label: string;
  logisimLabel: string;
  canonicalLabel: string;
  width: number;
  x?: number;
  y?: number;
  appearanceX?: number;
  appearanceY?: number;
  reason: string;
}

export interface P3LogisimTraceAnalysisOptions {
  traceColumns?: LogisimTraceColumnMap;
}

export interface P3LogisimTraceAnalysisReport {
  circuitName: string;
  circuits: string[];
  circuitFound: boolean;
  columns: LogisimTraceOutputColumn[];
  ignoredOutputPins: LogisimTraceIgnoredOutputPin[];
  romTargets: LogisimRomTarget[];
  mappingMode?: LogisimTraceMappingMode;
  spec?: LogisimTraceSpec;
  warnings: string[];
  errors: string[];
}

export interface P3LogisimFetchValidationResult {
  warnings: string[];
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
  instruction?: LogisimTraceValue;
}

export interface LogisimPcProgressState {
  rowsSeen: number;
  previousPc: string;
  repeatedPcRows: number;
}

export interface LogisimPcProgressResult {
  rowSeen: boolean;
  pc?: string;
  halted: boolean;
  error?: string;
}

const requiredLabels = p3LogisimTraceProfile.requiredLabels;
const p3OrderedLabels = p3LogisimTraceProfile.orderedLabels;
const p3OrderedWidths = p3LogisimTraceProfile.widths;
const p3SemanticLabels = p3LogisimTraceProfile.semanticLabels;

const circuitPattern = /<circuit\b[^>]*\bname="([^"]+)"[^>]*>[\s\S]*?<\/circuit>/g;
const pinPattern = /<comp\b[^>]*\bname="Pin"[^>]*(?:\/>|>[\s\S]*?<\/comp>)/g;
const attrPattern = /<a\b[^>]*>/g;
const circPortPattern = /<circ-port\b[^>]*\/>/g;

export function analyzeP3LogisimTraceCircuit(
  circuitText: string,
  circuitName = defaultLogisimTraceCircuit,
  options: P3LogisimTraceAnalysisOptions = {}
): P3LogisimTraceAnalysisReport {
  const circuits = listLogisimCircuitNames(circuitText);
  const romTargets = findLogisimRomTargets(circuitText);
  const report: P3LogisimTraceAnalysisReport = {
    circuitName,
    circuits,
    circuitFound: false,
    columns: [],
    ignoredOutputPins: [],
    romTargets,
    warnings: [],
    errors: []
  };

  const circuit = findCircuitBlock(circuitText, circuitName);
  if (!circuit) {
    report.errors.push(`未找到 Logisim 电路“${circuitName}”。`);
    return report;
  }
  report.circuitFound = true;

  // Logisim 2.7.1 -tty table collects appearance ports, then Analyze.getPinLabels
  // re-sorts the backing Pin instances by circuit location: top-down, then left-right.
  const discovery = findOutputPins(circuit);
  report.ignoredOutputPins.push(...discovery.ignored);
  const outputs = discovery.outputPins
    .sort((left, right) => left.y - right.y || left.x - right.x);
  const columns: LogisimTraceOutputColumn[] = [];
  let hasHalt = false;

  for (const output of outputs) {
    const { x, y, label, logisimLabel, canonicalLabel, width, appearanceX, appearanceY } = output;
    if (isLogisimCliHaltLabel(logisimLabel)) {
      hasHalt = true;
      report.ignoredOutputPins.push({
        x,
        y,
        appearanceX,
        appearanceY,
        label,
        logisimLabel,
        canonicalLabel,
        width,
        reason: 'Logisim -tty table 不会输出专用停机引脚'
      });
      continue;
    }
    columns.push({
      x,
      y,
      appearanceX,
      appearanceY,
      label,
      logisimLabel,
      width,
      canonicalLabel,
      index: columns.length
    });
  }
  report.columns = columns;

  const resolved = resolveRequiredColumns(columns, circuitName, options.traceColumns);
  report.warnings.push(...resolved.warnings);
  report.errors.push(...resolved.errors);
  report.mappingMode = resolved.mappingMode;
  if (!resolved.required || report.errors.length) {
    return report;
  }

  report.spec = {
    circuitName,
    columns,
    required: resolved.required,
    instruction: resolved.instruction,
    hasHalt,
    mappingMode: resolved.mappingMode ?? 'position'
  };
  return report;
}

export function parseLogisimTraceSpec(
  circuitText: string,
  circuitName = defaultLogisimTraceCircuit,
  options: P3LogisimTraceAnalysisOptions = {}
): LogisimTraceSpec {
  const report = analyzeP3LogisimTraceCircuit(circuitText, circuitName, options);
  if (!report.spec) {
    throw new Error(formatP3LogisimTraceDiagnostic(report));
  }
  return report.spec;
}

export function formatP3LogisimTraceDiagnostic(report: P3LogisimTraceAnalysisReport): string {
  const lines: string[] = [];
  lines.push('P3 Logisim 写回记录诊断');
  lines.push(`电路：${report.circuitName}${report.circuitFound ? '' : '（未找到）'}`);
  lines.push(`全部电路：${report.circuits.length ? report.circuits.join(', ') : '（无）'}`);
  lines.push(`映射方式：${report.mappingMode ? formatMappingMode(report.mappingMode) : '（未解析）'}`);
  lines.push(`ROM 目标：${report.romTargets.length ? report.romTargets.map(formatRomSummary).join('; ') : '（无）'}`);
  lines.push('Logisim -tty table 标准输出端口：');
  if (report.columns.length) {
    for (const column of report.columns) {
      lines.push(`  ${formatColumnSummary(column)}`);
    }
  } else {
    lines.push('  （无）');
  }
  if (report.ignoredOutputPins.length) {
    lines.push('忽略的输出引脚：');
    for (const pin of report.ignoredOutputPins) {
      const loc = pin.x === undefined || pin.y === undefined ? '（未知）' : `(${pin.x},${pin.y})`;
      const appearance = pin.appearanceX === undefined || pin.appearanceY === undefined ? '' : ` 外观位置=(${pin.appearanceX},${pin.appearanceY})`;
      lines.push(`  label="${pin.label}" logisim="${pin.logisimLabel || '（无）'}" width=${pin.width} 位置=${loc}${appearance}：${pin.reason}`);
    }
  }
  if (report.spec) {
    lines.push('语义映射结果：');
    if (report.spec.instruction) {
      lines.push(`  instr -> ${formatColumnSummary(report.spec.instruction)}`);
    } else {
      lines.push('  instr ->（未映射）');
    }
    for (const label of requiredLabels) {
      lines.push(`  ${label} -> ${formatColumnSummary(report.spec.required[label])}`);
    }
    lines.push(`停机方式：向程序注入停机循环，通过 pc 列检测停机 PC${report.spec.hasHalt ? '；检测到可选的 Logisim 停机引脚' : '；无需 Logisim 停机引脚'}`);
  }
  if (report.warnings.length) {
    lines.push('警告：');
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  if (report.errors.length) {
    lines.push('错误：');
    for (const error of report.errors) {
      lines.push(`  - ${error}`);
    }
  }
  return lines.join('\n');
}

function formatMappingMode(mode: LogisimTraceMappingMode): string {
  const label = mode === 'labels'
    ? '按标签识别'
    : mode === 'appearance'
      ? '按引脚外观顺序'
      : mode === 'position'
        ? '按标准输出顺序'
        : '显式列映射';
  return `${label}（${mode}）`;
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
    throw new Error('汇编器未生成任何机器码字。');
  }
  const alreadyTerminated = machineCodeHasHaltLoop(words);
  const programWordCount = alreadyTerminated ? words.length - p3LogisimHaltWords : words.length;
  if (programWordCount > p3LogisimMaxProgramWords) {
    throw new Error(`P3 Logisim 测试在停机循环前有 ${programWordCount} 个机器码字，最多允许 ${p3LogisimMaxProgramWords} 个。`);
  }
  const text = appendHaltLoop(words.join('\n') + '\n');
  const terminatedWordCount = parseMachineCodeWords(text).length;
  if (terminatedWordCount > p3LogisimMaxWords) {
    throw new Error(`P3 Logisim 测试加入停机循环后有 ${terminatedWordCount} 个机器码字，最多允许 ${p3LogisimMaxWords} 个。`);
  }
  const haltPc = p3TextBase + programWordCount * 4;
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
  const events: CpuTraceEvent[] = [];
  for (const { line, lineNumber } of iterTextLines(text)) {
    const row = parseLogisimTraceLine(line, spec, lineNumber, rows.length + 1);
    if (row) {
      rows.push(row);
      events.push(...logisimRowToTraceEvents(row));
    }
  }
  return {
    rows,
    events
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
    throw new Error(`Logisim 表格第 ${lineNumber} 行有 ${cells.length} 列，应为 ${spec.columns.length} 列。`);
  }

  const values = Object.fromEntries(requiredLabels.map((label) => {
    const column = spec.required[label];
    return [label, parseLogisimTraceValue(cells[column.index], column.width)];
  })) as Record<LogisimTraceRequiredLabel, LogisimTraceValue>;
  const instruction = spec.instruction
    ? parseLogisimTraceValue(cells[spec.instruction.index], spec.instruction.width)
    : undefined;

  return {
    rowNumber,
    lineNumber,
    raw,
    values,
    instruction
  };
}

function* iterTextLines(text: string): IterableIterator<{ line: string; lineNumber: number }> {
  let lineStart = 0;
  let lineNumber = 1;
  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && text[index] !== '\n') {
      continue;
    }
    const lineEnd = index > lineStart && text[index - 1] === '\r' ? index - 1 : index;
    yield {
      line: text.slice(lineStart, lineEnd),
      lineNumber
    };
    lineStart = index + 1;
    lineNumber++;
  }
}

function logisimRowToTraceEvents(row: LogisimTraceRow): CpuTraceEvent[] {
  const events: CpuTraceEvent[] = [];
  const pc = requiredKnown(row, 'pc');
  const regWrite = requiredKnown(row, 'regwrite').numeric;
  const memWrite = requiredKnown(row, 'memwrite').numeric;

  if (regWrite === undefined || memWrite === undefined) {
    throw new Error(`Logisim 第 ${row.lineNumber} 行的写使能值不是数字。`);
  }

  if (regWrite !== 0) {
    const reg = requiredKnown(row, 'regaddr');
    if (reg.numeric === undefined) {
      throw new Error(`Logisim 第 ${row.lineNumber} 行的寄存器地址不是数字。`);
    }
    if (reg.numeric !== 0) {
      const value = requiredKnown(row, 'regdata');
      events.push(makeTraceEvent(row, pc.hex, 'grf', String(reg.numeric), value.hex));
    }
  }

  if (memWrite !== 0) {
    const addr = requiredKnown(row, 'memaddr');
    const value = requiredKnown(row, 'memdata');
    events.push(makeTraceEvent(row, pc.hex, 'dm', addr.hex, value.hex));
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

export function createLogisimPcProgressState(): LogisimPcProgressState {
  return {
    rowsSeen: 0,
    previousPc: '',
    repeatedPcRows: 0
  };
}

export function inspectLogisimPcProgress(
  line: string,
  spec: LogisimTraceSpec,
  state: LogisimPcProgressState,
  haltPcHex: string,
  stuckPcRowLimit = p3LogisimTraceProfile.stuckPcRowLimit
): LogisimPcProgressResult {
  const pc = logisimRowPcHex(line, spec);
  if (!pc) {
    return {
      rowSeen: false,
      halted: false
    };
  }

  state.rowsSeen++;
  const haltPc = Number.parseInt(haltPcHex, 16);
  const pcValue = Number.parseInt(pc, 16);
  if (Number.isFinite(pcValue) && (pcValue < p3TextBase || pcValue > haltPc)) {
    return {
      rowSeen: true,
      pc,
      halted: false,
      error: `Logisim PC 跑出 P3 文本区：第 ${state.rowsSeen} 行 PC=0x${pc}，期望范围 0x${formatHex(p3TextBase, 8)}..0x${haltPcHex}。`
    };
  }

  if (pc === haltPcHex) {
    return {
      rowSeen: true,
      pc,
      halted: true
    };
  }

  if (pc === state.previousPc) {
    state.repeatedPcRows++;
  } else {
    state.previousPc = pc;
    state.repeatedPcRows = 1;
  }
  if (state.repeatedPcRows >= stuckPcRowLimit) {
    return {
      rowSeen: true,
      pc,
      halted: false,
      error: `Logisim PC 连续 ${state.repeatedPcRows} 行停在 0x${pc}，未到达停机 PC 0x${haltPcHex}。`
    };
  }

  return {
    rowSeen: true,
    pc,
    halted: false
  };
}

export function validateP3LogisimFetchTrace(
  rows: readonly LogisimTraceRow[],
  spec: LogisimTraceSpec,
  machineWords: readonly string[],
  haltPcHex: string
): P3LogisimFetchValidationResult {
  const warnings: string[] = [];
  if (!rows.length) {
    throw new Error('Logisim 命令行未生成可解析的表格行。');
  }

  const normalizedWords = machineWords.map((word) => normalizeMachineWord(word)).filter((word): word is string => Boolean(word));
  const haltPc = Number.parseInt(haltPcHex, 16);
  if (!normalizedWords.length) {
    throw new Error('P3 Logisim 取指校验没有机器码字。');
  }

  let reachedHaltPc = false;
  const initialPcHex = formatHex(p3TextBase, 8);
  for (const row of rows) {
    const pc = requiredKnown(row, 'pc');
    if (pc.numeric === undefined) {
      throw new Error(`Logisim 第 ${row.lineNumber} 行的 PC 值不是数字。`);
    }
    const pcValue = pc.numeric;
    if (row.rowNumber === 1 && pc.hex !== initialPcHex) {
      throw new Error(`Logisim CLI 初始 PC 应为 0x${initialPcHex}，实际为 0x${pc.hex}。请提供无需人工 reset 的测试顶层。`);
    }
    if (pcValue < p3TextBase || pcValue > haltPc) {
      throw new Error(`Logisim PC 跑出 P3 文本区：第 ${row.lineNumber} 行 PC=0x${pc.hex}，期望范围 0x${formatHex(p3TextBase, 8)}..0x${haltPcHex}。`);
    }
    if ((pcValue - p3TextBase) % p3LogisimTraceProfile.pcAlignmentBytes !== 0) {
      throw new Error(`Logisim 第 ${row.lineNumber} 行的 PC=0x${pc.hex} 未按 ${p3LogisimTraceProfile.pcAlignmentBytes} 字节对齐（基址 0x${formatHex(p3TextBase, 8)}）。`);
    }
    if (pc.hex === haltPcHex) {
      reachedHaltPc = true;
    }

    if (!spec.instruction) {
      continue;
    }
    const instruction = row.instruction;
    if (!instruction || instruction.unknown) {
      throw new Error(`Logisim 第 ${row.lineNumber} 行 PC=0x${pc.hex} 的 instr 值未知。`);
    }
    const wordIndex = (pcValue - p3TextBase) / 4;
    const expected = normalizedWords[wordIndex];
    if (!expected) {
      throw new Error(`Logisim 第 ${row.lineNumber} 行 PC=0x${pc.hex} 没有对应的第 ${wordIndex} 个机器码字。`);
    }
    if (instruction.hex !== expected) {
      throw new Error(`Logisim 第 ${row.lineNumber} 行 PC=0x${pc.hex} 的 instr 不匹配：应为 ${expected}，实际为 ${instruction.hex}。`);
    }
  }

  if (!spec.instruction) {
    warnings.push('写回记录输出没有 Instr 列，已跳过取指机器码自检。');
  }
  if (!reachedHaltPc) {
    throw new Error(`Logisim 写回记录未到达注入的停机 PC 0x${haltPcHex}。`);
  }
  return { warnings };
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

function listLogisimCircuitNames(circuitText: string): string[] {
  const names: string[] = [];
  circuitPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = circuitPattern.exec(circuitText))) {
    names.push(decodeXmlAttribute(match[1]));
  }
  return names;
}

type LogisimOutputPin = Omit<LogisimTraceOutputColumn, 'index'>;

interface LogisimOutputPinDiscovery {
  outputPins: LogisimOutputPin[];
  ignored: LogisimTraceIgnoredOutputPin[];
}

function findOutputPins(circuitBlock: string): LogisimOutputPinDiscovery {
  const allOutputPins: Array<Omit<LogisimOutputPin, 'logisimLabel' | 'canonicalLabel'>> = [];
  const ignored: LogisimTraceIgnoredOutputPin[] = [];
  const appearanceOrder = findAppearancePortOrder(circuitBlock);
  const hasExplicitAppearance = appearanceOrder.size > 0;
  pinPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pinPattern.exec(circuitBlock))) {
    const block = match[0];
    if (attributeValue(block, 'output') !== 'true') {
      continue;
    }
    const label = attributeValue(block, 'label') ?? '';
    const width = numericAttributeValue(block, 'width') ?? 1;
    const loc = block.match(/\bloc="\((-?\d+),(-?\d+)\)"/);
    if (!loc) {
      const logisimLabel = logisimToValidLabel(label) ?? '';
      ignored.push({
        label,
        logisimLabel,
        canonicalLabel: canonicalizeP3LogisimTraceLabel(logisimLabel),
        width,
      reason: '输出引脚缺少可解析的 loc 属性'
      });
      continue;
    }
    const x = Number(loc[1]);
    const y = Number(loc[2]);
    const order = appearanceOrder.get(`${x},${y}`);
    if (hasExplicitAppearance && !order) {
      const logisimLabel = logisimToValidLabel(label) ?? '';
      ignored.push({
        x,
        y,
        label,
        logisimLabel,
        canonicalLabel: canonicalizeP3LogisimTraceLabel(logisimLabel),
        width,
        reason: '输出引脚未出现在电路的显式外观定义中'
      });
      continue;
    }
    allOutputPins.push({
      x,
      y,
      appearanceX: order?.x,
      appearanceY: order?.y,
      label,
      width
    });
  }
  return {
    outputPins: assignLogisimPinLabels(allOutputPins),
    ignored
  };
}

function assignLogisimPinLabels(
  pins: ReadonlyArray<Omit<LogisimOutputPin, 'logisimLabel' | 'canonicalLabel'>>
): LogisimOutputPin[] {
  const sorted = [...pins].sort((left, right) => left.y - right.y || left.x - right.x);
  const labelsTaken = new Set<string>();
  const result = sorted.map((pin) => {
    let logisimLabel = logisimToValidLabel(pin.label);
    if (logisimLabel) {
      if (labelsTaken.has(logisimLabel)) {
        let suffix = 2;
        while (labelsTaken.has(`${logisimLabel}${suffix}`)) {
          suffix++;
        }
        logisimLabel = `${logisimLabel}${suffix}`;
      }
    }
    if (!logisimLabel) {
      logisimLabel = firstAvailableDefaultOutputLabel(labelsTaken);
    }
    labelsTaken.add(logisimLabel);
    return {
      ...pin,
      logisimLabel,
      canonicalLabel: canonicalizeP3LogisimTraceLabel(logisimLabel)
    };
  });
  return result;
}

function firstAvailableDefaultOutputLabel(labelsTaken: ReadonlySet<string>): string {
  const defaults = ['x', 'y', 'z', 'u', 'v', 'w', 's', 't'];
  for (const label of defaults) {
    if (!labelsTaken.has(label)) {
      return label;
    }
  }
  let index = 2;
  while (labelsTaken.has(`x${index}`)) {
    index++;
  }
  return `x${index}`;
}

function logisimToValidLabel(label: string | undefined): string | undefined {
  if (label === undefined || label === null) {
    return undefined;
  }
  let end = '';
  let ret = '';
  let afterWhitespace = false;
  for (const char of label) {
    if (isJavaIdentifierStart(char)) {
      ret += afterWhitespace ? char.toLocaleUpperCase() : char;
      afterWhitespace = false;
    } else if (isJavaIdentifierPart(char)) {
      if (ret.length > 0) {
        ret += char;
      } else {
        end += char;
      }
      afterWhitespace = false;
    } else if (/\s/u.test(char)) {
      afterWhitespace = true;
    }
  }
  if (end && ret) {
    ret += end;
  }
  return ret || undefined;
}

function isJavaIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char) || char.charCodeAt(0) > 0x7f;
}

function isJavaIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char) || char.charCodeAt(0) > 0x7f;
}

function isLogisimCliHaltLabel(logisimLabel: string): boolean {
  return canonicalizeP3LogisimTraceLabel(logisimLabel) === p3LogisimTraceProfile.haltLabel;
}

interface LogisimTraceColumnResolution {
  required?: Record<LogisimTraceRequiredLabel, LogisimTraceOutputColumn>;
  instruction?: LogisimTraceOutputColumn;
  mappingMode?: LogisimTraceMappingMode;
  warnings: string[];
  errors: string[];
}

function resolveRequiredColumns(
  columns: readonly LogisimTraceOutputColumn[],
  circuitName: string,
  explicitColumns?: LogisimTraceColumnMap
): LogisimTraceColumnResolution {
  const explicit = resolveP3ExplicitColumns(columns, explicitColumns);
  if (explicit) {
    return explicit;
  }

  const labeled = resolveP3LabeledColumns(columns, circuitName);
  if (labeled.errors.length || labeled.required) {
    return labeled;
  }

  const appearanceOrdered = resolveP3AppearanceOrderedColumns(columns);
  if (appearanceOrdered.errors.length || appearanceOrdered.required) {
    return appearanceOrdered;
  }

  const tableOrdered = resolveP3ColumnsInSemanticOrder(columns, 'position');
  if (tableOrdered.errors.length || tableOrdered.required) {
    return tableOrdered;
  }

  const missing = labeled.warnings.find((warning) => warning.startsWith('缺少标准标签：'));
  return {
    warnings: [...labeled.warnings, ...appearanceOrdered.warnings, ...tableOrdered.warnings],
    errors: [
      `Logisim 写回记录电路“${circuitName}”无法识别 P3 写回记录输出引脚。`,
      missing ?? '标准标签不完整',
      `可用标准输出列：${columns.length ? columns.map(formatColumnSummary).join('; ') : '（无）'}`
    ]
  };
}

function resolveP3LabeledColumns(
  columns: readonly LogisimTraceOutputColumn[],
  circuitName: string
): LogisimTraceColumnResolution {
  const byLabel = new Map<string, LogisimTraceOutputColumn>();
  const warnings: string[] = [];
  const errors: string[] = [];
  let instruction: LogisimTraceOutputColumn | undefined;
  for (const column of columns) {
    if (!isP3LogisimTraceSemanticLabel(column.canonicalLabel)) {
      continue;
    }
    const semantic = column.canonicalLabel;
    if (semantic === 'instr') {
      if (instruction) {
        errors.push(`Logisim 写回记录电路“${circuitName}”有重复的输出标签“${column.logisimLabel}”。`);
      }
      instruction = column;
      continue;
    }
    if (byLabel.has(semantic)) {
      errors.push(`Logisim 写回记录电路“${circuitName}”有重复的输出标签“${column.logisimLabel}”。`);
      continue;
    }
    byLabel.set(semantic, column);
  }

  if (errors.length) {
    return { warnings, errors };
  }

  const missing = requiredLabels.filter((label) => !byLabel.has(label));
  if (missing.length) {
    warnings.push(`缺少标准标签：${missing.join(', ')}`);
    return { warnings, errors };
  }

  const required = Object.fromEntries(requiredLabels.map((label) => {
    const column = byLabel.get(label)!;
    if (column.width !== p3OrderedWidths[label]) {
      errors.push(`Logisim 写回记录输出“${column.logisimLabel}”位宽为 ${column.width}，应为 ${p3OrderedWidths[label]}。`);
    }
    return [label, column];
  })) as Record<LogisimTraceRequiredLabel, LogisimTraceOutputColumn>;
  if (instruction && instruction.width !== p3OrderedWidths.instr) {
    errors.push(`Logisim 写回记录输出“${instruction.logisimLabel}”位宽为 ${instruction.width}，应为 ${p3OrderedWidths.instr}。`);
  }
  return errors.length
    ? { warnings, errors }
    : { required, instruction, mappingMode: 'labels', warnings, errors };
}

function resolveP3AppearanceOrderedColumns(
  columns: readonly LogisimTraceOutputColumn[]
): LogisimTraceColumnResolution {
  if (!columns.some((column) => column.appearanceX !== undefined && column.appearanceY !== undefined)) {
    return { warnings: ['没有可用于 P3 写回记录顺序映射的显式外观端口'], errors: [] };
  }
  const ordered = [...columns]
    .filter((column) => column.appearanceX !== undefined && column.appearanceY !== undefined)
    .sort((left, right) =>
      left.appearanceY! - right.appearanceY!
      || left.appearanceX! - right.appearanceX!
      || left.y - right.y
      || left.x - right.x
    );
  return resolveP3ColumnsInSemanticOrder(ordered, 'appearance');
}

function resolveP3ColumnsInSemanticOrder(
  columns: readonly LogisimTraceOutputColumn[],
  mappingMode: Exclude<LogisimTraceMappingMode, 'explicit' | 'labels'>
): LogisimTraceColumnResolution {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (columns.length < p3OrderedLabels.length) {
    warnings.push(`${formatMappingMode(mappingMode)}有 ${columns.length} 列，至少需要 ${p3OrderedLabels.length} 列`);
    return { warnings, errors };
  }

  const ordered = columns.slice(0, p3OrderedLabels.length);
  for (let i = 0; i < ordered.length; i++) {
    const expected = p3OrderedLabels[i];
    if (ordered[i].width !== p3OrderedWidths[expected]) {
      warnings.push(`${formatMappingMode(mappingMode)}的第 ${i} 列（${formatColumnSummary(ordered[i])}）位宽为 ${ordered[i].width}，${expected} 应为 ${p3OrderedWidths[expected]}`);
      return { warnings, errors };
    }
  }

  const semanticColumns = new Map<LogisimTraceSemanticLabel, LogisimTraceOutputColumn>(
    p3OrderedLabels.map((label, index) => [label, ordered[index]])
  );
  for (const [semantic, column] of semanticColumns) {
    if (isP3LogisimTraceSemanticLabel(column.canonicalLabel) && column.canonicalLabel !== semantic) {
      errors.push(`Logisim 写回记录输出标签“${column.logisimLabel}”位于${formatMappingMode(mappingMode)}中的“${semantic}”位置，但该标签表示“${column.canonicalLabel}”。`);
    }
  }

  const required = requiredColumnsFromSemanticMap(semanticColumns);
  return errors.length
    ? { warnings, errors }
    : { required, instruction: semanticColumns.get('instr'), mappingMode, warnings, errors };
}

function resolveP3ExplicitColumns(
  columns: readonly LogisimTraceOutputColumn[],
  explicitColumns?: LogisimTraceColumnMap
): LogisimTraceColumnResolution | undefined {
  if (!explicitColumns || !Object.keys(explicitColumns).length) {
    return undefined;
  }
  const warnings: string[] = [];
  const errors: string[] = [];
  const selected = new Map<LogisimTraceSemanticLabel, LogisimTraceOutputColumn>();
  const usedIndexes = new Map<number, LogisimTraceSemanticLabel>();

  for (const label of p3SemanticLabels) {
    const index = explicitColumns[label];
    if (index === undefined) {
      if (label !== 'instr') {
        errors.push(`旧版显式列映射缺少必需输出“${label}”。请为对应引脚设置教程标准 label 以便自动识别。`);
      }
      continue;
    }
    if (!Number.isInteger(index) || index < 0 || index >= columns.length) {
      errors.push(`旧版显式列映射中的“${label}”=${index} 超出标准输出列范围 0..${Math.max(0, columns.length - 1)}。`);
      continue;
    }
    const duplicate = usedIndexes.get(index);
    if (duplicate) {
      errors.push(`旧版显式列映射把“${duplicate}”和“${label}”同时指向标准输出第 ${index} 列。`);
      continue;
    }
    usedIndexes.set(index, label);
    const column = columns[index];
    if (column.width !== p3OrderedWidths[label]) {
      errors.push(`旧版显式列映射中的 "${label}" 指向 ${formatColumnSummary(column)}（位宽 ${column.width}），期望位宽 ${p3OrderedWidths[label]}。`);
    }
    if (isP3LogisimTraceSemanticLabel(column.canonicalLabel) && column.canonicalLabel !== label) {
      warnings.push(`旧版显式列映射中的“${label}”指向 label“${column.logisimLabel}”，其外观更像“${column.canonicalLabel}”。`);
    }
    selected.set(label, column);
  }

  const required = Object.fromEntries(requiredLabels
    .filter((label) => selected.has(label))
    .map((label) => [label, selected.get(label)!])) as Record<LogisimTraceRequiredLabel, LogisimTraceOutputColumn>;

  return errors.length
    ? { warnings, errors }
    : { required, instruction: selected.get('instr'), mappingMode: 'explicit', warnings, errors };
}

function requiredColumnsFromSemanticMap(
  columns: ReadonlyMap<LogisimTraceSemanticLabel, LogisimTraceOutputColumn>
): Record<LogisimTraceRequiredLabel, LogisimTraceOutputColumn> {
  return Object.fromEntries(requiredLabels.map((label) => {
    const column = columns.get(label);
    if (!column) {
      throw new Error(`Logisim 写回记录配置缺少顺序列“${label}”。`);
    }
    return [label, column];
  })) as Record<LogisimTraceRequiredLabel, LogisimTraceOutputColumn>;
}

function findAppearancePortOrder(circuitBlock: string): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const appear = circuitBlock.match(/<appear\b[^>]*>[\s\S]*?<\/appear>/)?.[0];
  if (!appear) {
    return result;
  }

  circPortPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = circPortPattern.exec(appear))) {
    const tag = match[0];
    const pin = tagAttributeValue(tag, 'pin');
    const x = numericTagAttributeValue(tag, 'x');
    const y = numericTagAttributeValue(tag, 'y');
    if (!pin || x === undefined || y === undefined) {
      continue;
    }
    result.set(pin, { x, y });
  }
  return result;
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
    throw new Error(`Logisim 第 ${row.lineNumber} 行的 ${label} 值未知。`);
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

function tagAttributeValue(tag: string, name: string): string | undefined {
  const escapedName = escapeRegExp(name);
  const match = tag.match(new RegExp(`\\b${escapedName}="([^"]*)"`));
  return match ? decodeXmlAttribute(match[1]) : undefined;
}

function numericTagAttributeValue(tag: string, name: string): number | undefined {
  const value = tagAttributeValue(tag, name);
  if (!value || !/^-?\d+$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

function numericAttributeValue(block: string, name: string): number | undefined {
  const value = attributeValue(block, name);
  if (!value || !/^-?\d+$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

function formatColumnSummary(column: LogisimTraceOutputColumn): string {
  const appearance = column.appearanceX === undefined || column.appearanceY === undefined
    ? ''
    : ` appearance=(${column.appearanceX},${column.appearanceY})`;
  return `#${column.index} label="${column.label}" logisim="${column.logisimLabel}" canonical="${column.canonicalLabel}" width=${column.width} loc=(${column.x},${column.y})${appearance}`;
}

function formatRomSummary(target: LogisimRomTarget): string {
  const parts = [`#${target.index}`];
  if (target.label) {
    parts.push(`label="${target.label}"`);
  }
  if (target.loc) {
    parts.push(`loc=${target.loc}`);
  }
  parts.push(`addrWidth=${target.addrWidth ?? '?'}`);
  parts.push(`dataWidth=${target.dataWidth ?? '?'}`);
  parts.push(target.hasContents ? 'contents=yes' : 'contents=no');
  return parts.join(' ');
}

function normalizeMachineWord(word: string): string | undefined {
  const clean = word.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,8}$/.test(clean)) {
    return undefined;
  }
  return clean.toUpperCase().padStart(8, '0').slice(-8);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
