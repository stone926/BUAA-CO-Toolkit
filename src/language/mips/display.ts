import { MarkupKind, Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { p7ExceptionHandlerAddress } from '../../courseTesting/p7Hardware';
import { lineAt } from '../common/lsp';
import { MipsMacro, MipsParseResult } from './model';
import { instructionWritesRegister } from './instructionValidation';
import { macroCallArgumentsAtPosition } from './queries';
import type { MipsAstLine, MipsExecutableAst, MipsOperandAst, MipsStatementAst } from './ast';
import { collectMipsOperandReferences } from './operandReferences';
import {
  cp0RegistersByNumber, pseudoExpansions,
  directives,
  isRegister,
  MipsCp0RegisterInfo,
  MipsSyscallInfo,
  syscallsByCode
} from './resources';
import {
  parseCharLiteral,
  parseIntegerLiteral,
  signed32ImmediateValue
} from './syntax';

export function directiveHoverText(directive: string): string | undefined {
  if (!directives.has(directive)) {
    return undefined;
  }
  if (directive === '.align') {
    return '**.align n**\n\n将下一个数据项按 2^n 字节边界对齐。常用值为 `.align 0`、`.align 1` 和 `.align 2`';
  }
  if (directive === '.data' || directive === '.text') {
    return `**${directive}**\n\n切换当前汇编段。课程自动测试会按当前 Profile 选择 MARS 内存配置，通常不应传递自定义段地址`;
  }
  if (directive === '.ktext') {
    return `**.ktext**\n\n切换到内核文本段。P7 异常处理程序使用课程固定入口 \`.ktext 0x${p7ExceptionHandlerAddress.toString(16)}\``;
  }
  if (directive === '.set') {
    return '**.set**\n\nSPIM 兼容 directive。MARS 4.5 会识别它，但当前会忽略其效果并给出 warning';
  }
  return `MIPS 汇编指令 \`${directive}\`.`;
}

export function macroBody(document: TextDocument, bodyStartLine: number, bodyEndLine?: number): string {
  if (bodyEndLine === undefined || bodyEndLine < bodyStartLine) {
    return '';
  }
  const lines: string[] = [];
  for (let line = bodyStartLine; line <= bodyEndLine; line++) {
    lines.push(lineAt(document, line).text);
  }
  return lines.join('\n');
}

export function macroExpansionPreview(document: TextDocument, parsed: MipsParseResult, macro: MipsMacro, name: string, position: Position): string | undefined {
  const args = macroCallArgumentsAtPosition(parsed, name, position);
  if (!args || args.length !== macro.params.length) {
    return undefined;
  }
  const replacements = new Map(macro.params.map((param, index) => [param, args[index]] as const));
  const lines: string[] = [];
  for (let lineNumber = macro.bodyStartLine; lineNumber <= (macro.bodyEndLine ?? macro.bodyStartLine - 1); lineNumber++) {
    const line = parsed.ast.lines[lineNumber];
    lines.push(line ? expandMacroBodyLine(line, replacements) : lineAt(document, lineNumber).text);
  }
  return lines.join('\n');
}

export function pseudoExpansionPreview(mnemonic: string, operands: string[]): string[] | undefined {
  const entry = pseudoExpansions[mnemonic];
  if (!entry) {
    return undefined;
  }
  for (const form of entry.forms) {
    if (form.operands.length !== operands.length) {
      continue;
    }
    if (!matchOperandPattern(form.operands, operands)) {
      continue;
    }
    // Mnemonic-specific filters
    if ((mnemonic === 'addi' || mnemonic === 'addiu') && operands.length === 3) {
      const imm = parseImmediate(operands[2]);
      if (!imm || fitsSigned16(imm.signed)) continue;
    }
    if (['andi', 'ori', 'xori'].includes(mnemonic) && operands.length === 3) {
      const imm = parseImmediate(operands[2]);
      if (imm && fitsUnsigned16(imm.signed)) continue;
    }
    // Load/store: skip if offset(base) has simm16 offset (native instruction)
    if (form.operands[1] === 'offset(base)' && operands.length === 2) {
      const match = operands[1].match(/^([^(]+)\((.+)\)$/);
      if (match) {
        const offImm = parseImmediate(match[1]);
        if (offImm && fitsSigned16(offImm.signed)) continue;
      }
    }
    const addiOptimize = !['andi', 'ori', 'xori'].includes(mnemonic);
    return interpolateTemplates(form.template, form.operands, operands, addiOptimize);
  }
  return undefined;
}

export function syscallMarkdown(syscall: MipsSyscallInfo): string {
  return [
    `**MARS syscall ${syscall.code}** - ${syscall.name}`,
    '',
    syscall.description,
    '',
    `参数：${syscall.parameters ?? '无'}`,
    '',
    `返回值：${syscall.returns ?? '无'}`
  ].join('\n');
}

export function markdownTooltip(value: string) {
  return {
    kind: MarkupKind.Markdown,
    value
  };
}

export function cp0Markdown(register: MipsCp0RegisterInfo): string {
  const lines = [
    `**CP0 $${register.number} ${register.name}${register.alias ? ` (${register.alias})` : ''}**`,
    '',
    register.description,
    '',
    `P7 要求实现：${register.courseRequired ? '是' : '否'}`,
    '',
    `测试程序写入：${register.writableByTest ? '可以' : '不要求/保证不写'}`
  ];

  if (register.fields?.length) {
    lines.push('', '| 字段 | 位 | 含义 |', '| :--- | :--- | :--- |');
    for (const field of register.fields) {
      lines.push(`| ${field.name} | ${field.bits} | ${field.description} |`);
    }
  }

  if (register.excCodes?.length) {
    lines.push('', 'ExcCode 编码：', '', '| ExcCode | 名称 | 触发条件 |', '| :--- | :--- | :--- |');
    for (const code of register.excCodes) {
      lines.push(`| ${code.code} | ${code.name} | ${code.description} |`);
    }
  }

  if (register.notes?.length) {
    lines.push('', ...register.notes.map((note) => `- ${note}`));
  }

  return lines.join('\n');
}

export function syscallByOperand(operand: MipsOperandAst): MipsSyscallInfo | undefined {
  const value = operandIntegerValue(operand);
  return value === undefined ? undefined : syscallsByCode.get(value);
}

export function cp0ByOperand(operand: MipsOperandAst): MipsCp0RegisterInfo | undefined {
  const value = operandIntegerValue(operand, true);
  return value === undefined ? undefined : cp0RegistersByNumber.get(value);
}

export function syscallAtLiV0Operand(parsed: MipsParseResult, wordRange: Range) {
  const line = parsed.ast.lines[wordRange.start.line];
  const executable = line?.kind === 'statement' ? line.executable : undefined;
  if (!executable || executable.lowerMnemonic !== 'li') {
    return undefined;
  }
  const [target, serviceOperand] = executable.operands;
  if (!target || !serviceOperand || target.text !== '$v0' || !rangesOverlap(wordRange, serviceOperand.range)) {
    return undefined;
  }
  return syscallByOperand(serviceOperand);
}

export function syscallServiceBeforeLine(parsed: MipsParseResult, targetLine: number): MipsSyscallInfo | undefined {
  let service: MipsSyscallInfo | undefined;
  const serviceStack: Array<MipsSyscallInfo | undefined> = [];
  for (const statement of parsed.ast.statements) {
    if (statement.line >= targetLine) {
      break;
    }
    const executable = statement.executable;
    if (!executable) {
      continue;
    }
    if (executable.lowerMnemonic === '.macro') {
      serviceStack.push(service);
      service = undefined;
      continue;
    }
    if (executable.lowerMnemonic === '.end_macro') {
      service = serviceStack.pop();
      continue;
    }

    if (executable.lowerMnemonic === 'li' && executable.operands[0]?.text === '$v0' && executable.operands[1]) {
      service = syscallByOperand(executable.operands[1]);
      continue;
    }
    if (executable.lowerMnemonic === 'syscall') {
      service = undefined;
      continue;
    }
    if (instructionWritesRegister(executable.lowerMnemonic, executable.operands, '$v0')) {
      service = undefined;
    }
  }
  return service;
}

export function cp0RegisterAtPosition(parsed: MipsParseResult, word: string, position: Position) {
  const line = parsed.ast.lines[position.line];
  const executable = line?.kind === 'statement' ? line.executable : undefined;
  if (!executable || (executable.lowerMnemonic !== 'mfc0' && executable.lowerMnemonic !== 'mtc0')) {
    return undefined;
  }
  const operand = executable.operands[1];
  if (!operand || operand.text !== word || position.character < operand.range.start.character || position.character > operand.range.end.character) {
    return undefined;
  }
  const register = cp0ByOperand(operand);
  if (!register) {
    return undefined;
  }
  return register;
}

export function eqvReplacementText(parsed: MipsParseResult, lineNumber: number, name: string): string | undefined {
  const line = parsed.ast.lines[lineNumber];
  const executable = line?.kind === 'statement' ? line.executable : undefined;
  if (!line || line.kind !== 'statement' || !executable || executable.kind !== 'directive' || executable.lowerMnemonic !== '.eqv') {
    return undefined;
  }
  const eqv = executable.eqv;
  if (!eqv || eqv.name !== name) {
    return undefined;
  }
  return eqv.replacementText || undefined;
}

interface TextReplacement {
  start: number;
  end: number;
  value: string;
}

function expandMacroBodyLine(line: MipsAstLine, replacements: Map<string, string>): string {
  if (line.kind !== 'statement') {
    return line.text;
  }
  const spans = macroReplacementSpans(line, replacements).sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0;
  let output = '';
  for (const span of spans) {
    if (span.start < cursor) {
      continue;
    }
    output += line.text.slice(cursor, span.start);
    output += span.value;
    cursor = span.end;
  }
  return output + line.text.slice(cursor);
}

function macroReplacementSpans(line: MipsStatementAst, replacements: Map<string, string>): TextReplacement[] {
  const spans: TextReplacement[] = [];
  for (const label of line.labels) {
    pushReplacementSpan(spans, label.name, label.range, replacements);
  }
  const executable = line.executable;
  if (executable) {
    pushReplacementSpan(spans, executable.mnemonic, executable.mnemonicRange, replacements);
    for (const operand of executable.operands) {
      for (const reference of collectMipsOperandReferences(operand, { includeRegisters: true })) {
        pushReplacementSpan(spans, reference.text, reference.range, replacements);
      }
    }
  }
  spans.push(...rawMacroParameterSpans(line, replacements, spans));
  return spans;
}

function pushReplacementSpan(spans: TextReplacement[], text: string, range: Range, replacements: Map<string, string>): void {
  const value = replacements.get(text);
  if (value === undefined || range.start.line !== range.end.line || range.start.character >= range.end.character) {
    return;
  }
  spans.push({
    start: range.start.character,
    end: range.end.character,
    value
  });
}

function rawMacroParameterSpans(line: MipsStatementAst, replacements: Map<string, string>, existing: TextReplacement[]): TextReplacement[] {
  const keys = [...replacements.keys()].sort((a, b) => b.length - a.length);
  const spans: TextReplacement[] = [];
  const codeEnd = line.comment?.range.start.character ?? line.text.length;
  let quote: '"' | '\'' | undefined;
  let escaped = false;
  let index = 0;
  while (index < codeEnd) {
    const char = line.text[index];
    if (quote) {
      if (char === quote && !escaped) {
        quote = undefined;
        escaped = false;
      } else if (char !== '\\') {
        escaped = false;
      } else {
        escaped = !escaped;
      }
      index++;
      continue;
    }
    if (char === '"' || char === '\'') {
      quote = char;
      escaped = false;
      index++;
      continue;
    }

    const key = keys.find((candidate) => macroParameterMatches(line.text, index, candidate));
    if (!key) {
      index++;
      continue;
    }
    const span = {
      start: index,
      end: index + key.length,
      value: replacements.get(key)!
    };
    if (!existing.some((item) => textSpansOverlap(item, span)) && !spans.some((item) => textSpansOverlap(item, span))) {
      spans.push(span);
    }
    index = span.end;
  }
  return spans;
}

function macroParameterMatches(text: string, index: number, candidate: string): boolean {
  if (!candidate || (candidate[0] !== '%' && candidate[0] !== '$') || !text.startsWith(candidate, index)) {
    return false;
  }
  const before = text[index - 1] ?? '';
  const after = text[index + candidate.length] ?? '';
  return !isMacroParameterPart(before) && !isMacroParameterPart(after);
}

function textSpansOverlap(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start < right.end && right.start < left.end;
}

function rangesOverlap(left: Range, right: Range): boolean {
  return left.start.line === right.start.line
    && right.start.character <= left.end.character
    && left.start.character <= right.end.character;
}

function isMacroParameterPart(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char === '_';
}

interface ImmediateInfo {
  signed: number;
  unsigned: number;
}

function parseImmediate(operand: string): ImmediateInfo | undefined {
  const value = parseIntegerOrCharLiteral(operand);
  if (value === undefined) {
    return undefined;
  }
  const signed = signed32ImmediateValue(value);
  return {
    signed,
    unsigned: signed < 0 ? signed + 0x100000000 : signed
  };
}

function parseIntegerOrCharLiteral(operand: string): number | undefined {
  const charValue = parseCharLiteral(operand);
  return charValue === undefined ? parseIntegerLiteral(operand) : charValue;
}

function operandIntegerValue(operand: MipsOperandAst, stripRegisterPrefix = false): number | undefined {
  if (operand.kind === 'integer') {
    return operand.value;
  }
  const text = operand.text;
  return parseIntegerOrCharLiteral(stripRegisterPrefix && text.startsWith('$') ? text.slice(1) : text);
}

function formatHex16(value: number): string {
  return `0x${(value & 0xffff).toString(16).padStart(4, '0')}`;
}

function fitsSigned16(value: number): boolean {
  return value >= -32768 && value <= 32767;
}

function fitsUnsigned16(value: number): boolean {
  return value >= 0 && value <= 0xffff;
}

function formatSignedImmediate(value: number): string {
  return String(value);
}

function upper16(immediate: ImmediateInfo): string {
  return formatHex16(Math.floor(immediate.unsigned / 0x10000));
}

function lower16(immediate: ImmediateInfo): string {
  return formatHex16(immediate.unsigned);
}

function loadFullImmediateToAt(immediate: ImmediateInfo): string[] {
  return [`lui $at, ${upper16(immediate)}`, `ori $at, $at, ${lower16(immediate)}`];
}

function loadSignedImmediateToAt(operand: string): string[] | undefined {
  const immediate = parseImmediate(operand);
  if (!immediate) {
    return undefined;
  }
  if (fitsSigned16(immediate.signed)) {
    return [`addi $at, $zero, ${formatSignedImmediate(immediate.signed)}`];
  }
  return loadFullImmediateToAt(immediate);
}

function operandText(operand: { kind: string; tokenText: string; }): string {
  return operand.tokenText;
}

function matchOperandPattern(patterns: string[], operands: string[]): boolean {
  for (let i = 0; i < patterns.length; i++) {
    if (!singleOperandMatch(patterns[i], operands[i])) {
      return false;
    }
  }
  return true;
}

function singleOperandMatch(pattern: string, operand: string): boolean {
  switch (pattern) {
    case '$rd': case '$rs': case '$rt':
      return isRegister(operand);
    case 'label':
      return !isRegister(operand) && parseIntegerLiteral(operand) === undefined && !/^.+\(.+\)$/.test(operand);
    case 'imm16_signed': {
      const v = parseImmediate(operand);
      return v !== undefined && fitsSigned16(v.signed);
    }
    case 'imm16_unsigned': {
      const v = parseImmediate(operand);
      return v !== undefined && fitsUnsigned16(v.signed);
    }
    case 'imm32': {
      const v = parseImmediate(operand);
      return v !== undefined;
    }
    case 'offset(base)':
      return /^.+\(.+\)$/.test(operand);
    default:
      return operand === pattern;
  }
}

function interpolateTemplate(line: string, patterns: string[], operands: string[]): string {
  let result = line;
  // Replace operand placeholders: pattern "$rd" -> template variable "${rd}" or "${rs}" etc.
  for (let i = 0; i < operands.length; i++) {
    const p = patterns[i];
    const op = operands[i];
    const varName = p.startsWith('$') ? p.slice(1) : p;
    result = result.replace(new RegExp(`\\$\\{${escapeRegExp(varName)}\\}`, 'g'), op);
  }
  // Handle memory operand: offset(base)
  const memIdx = patterns.findIndex(p => p === 'offset(base)');
  if (memIdx >= 0) {
    const match = operands[memIdx].match(/^(.+)\((.+)\)$/);
    if (match) {
      result = result.replace(/\$\{offset\}/g, match[1]);
      result = result.replace(/\$\{base\}/g, match[2]);
    }
  }
  // Handle immediate format modifiers
  const immIdx = patterns.findIndex(p => p === 'imm16_signed' || p === 'imm16_unsigned' || p === 'imm32');
  if (immIdx >= 0) {
    const info = parseImmediate(operands[immIdx]);
    if (info) {
      result = result.replace(/\$\{imm:hex16\}/g, formatHex16(info.unsigned));
      result = result.replace(/\$\{imm:upper16\}/g, upper16(info));
      result = result.replace(/\$\{imm:lower16\}/g, lower16(info));
      result = result.replace(/\$\{imm:signed16\}/g, formatSignedImmediate(info.signed));
      result = result.replace(/\$\{imm\}/g, String(info.signed));
    }
  }
  return result;
}

function interpolateTemplates(templates: string[], patterns: string[], operands: string[], optimizeAddi = true): string[] {
  if (optimizeAddi) {
    const immIdx = patterns.findIndex(p => p === 'imm16_signed' || p === 'imm16_unsigned' || p === 'imm32');
    if (immIdx >= 0) {
      const info = parseImmediate(operands[immIdx]);
      if (info && fitsSigned16(info.signed) && templates.length >= 2 &&
          templates[0].includes('${imm:upper16}') && templates[1].includes('${imm:lower16}')) {
        const loadLine = `addi $at, $zero, ${formatSignedImmediate(info.signed)}`;
        const rest = templates.slice(2);
        return [loadLine, ...rest].map((line) => interpolateTemplate(line, patterns, operands));
      }
    }
  }
  return templates.map((line) => interpolateTemplate(line, patterns, operands));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


