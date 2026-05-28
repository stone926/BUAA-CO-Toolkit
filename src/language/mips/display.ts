import { MarkupKind, Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { MipsMacro } from './model';
import { macroCallArgumentsAtPosition } from './queries';
import {
  cp0RegistersByNumber,
  directives,
  MipsCp0RegisterInfo,
  MipsSyscallInfo,
  syscallsByCode
} from './resources';
import {
  escapeRegExp,
  parseIntegerLiteral
} from './syntax';
import { stripLineComment } from './text';

export function directiveHoverText(directive: string): string | undefined {
  if (!directives.has(directive)) {
    return undefined;
  }
  if (directive === '.align') {
    return '**.align n**\n\nAligns the next data item to a 2^n byte boundary. Common BUAA CO values are `.align 0`, `.align 1`, and `.align 2`.';
  }
  if (directive === '.data' || directive === '.text') {
    return `**${directive}**\n\nSwitches the current assembly section. BUAA CO uses CompactDataAtZero, so course code should not pass a custom section address.`;
  }
  return `MIPS assembler directive \`${directive}\`.`;
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

export function macroExpansionPreview(document: TextDocument, macro: MipsMacro, name: string, position: Position): string | undefined {
  const args = macroCallArgumentsAtPosition(document, name, position);
  if (!args || args.length !== macro.params.length) {
    return undefined;
  }
  const replacements = new Map(macro.params.map((param, index) => [param, args[index]] as const));
  return macroBody(document, macro.bodyStartLine, macro.bodyEndLine)
    .split(/\r?\n/)
    .map((line) => {
      let expanded = line;
      for (const [param, arg] of replacements) {
        expanded = expanded.replace(new RegExp(`${escapeRegExp(param)}\\b`, 'g'), arg);
      }
      return expanded;
    })
    .join('\n');
}

export function pseudoExpansionPreview(mnemonic: string, operands: string[]): string[] | undefined {
  if (mnemonic === 'li' && operands.length === 2) {
    return expandLoadImmediate(operands[0], operands[1]);
  }
  if (['add', 'addu', 'sub', 'subu'].includes(mnemonic) && operands.length === 3 && parseIntegerLiteral(operands[2]) !== undefined) {
    return [...(expandLoadImmediate('$at', operands[2]) ?? []), `${mnemonic} ${operands[0]}, ${operands[1]}, $at`];
  }
  if ((mnemonic === 'addi' || mnemonic === 'addiu') && operands.length === 3) {
    const immediate = parseIntegerLiteral(operands[2]);
    if (immediate !== undefined && !fitsSigned16(immediate)) {
      return [...(expandLoadImmediate('$at', operands[2]) ?? []), `${mnemonic === 'addi' ? 'add' : 'addu'} ${operands[0]}, ${operands[1]}, $at`];
    }
  }
  if (mnemonic === 'la' && operands.length === 2) {
    return [`lui $at, upper(${operands[1]})`, `ori ${operands[0]}, $at, lower(${operands[1]})`];
  }
  if (mnemonic === 'move' && operands.length === 2) {
    return [`addu ${operands[0]}, ${operands[1]}, $zero`];
  }
  if (mnemonic === 'nop' && operands.length === 0) {
    return ['sll $zero, $zero, 0'];
  }
  if (mnemonic === 'b' && operands.length === 1) {
    return [`beq $zero, $zero, ${operands[0]}`];
  }
  if (mnemonic === 'beqz' && operands.length === 2) {
    return [`beq ${operands[0]}, $zero, ${operands[1]}`];
  }
  if (mnemonic === 'bnez' && operands.length === 2) {
    return [`bne ${operands[0]}, $zero, ${operands[1]}`];
  }
  if (mnemonic === 'not' && operands.length === 2) {
    return [`nor ${operands[0]}, ${operands[1]}, $zero`];
  }
  if (mnemonic === 'neg' && operands.length === 2) {
    return [`sub ${operands[0]}, $zero, ${operands[1]}`];
  }
  if (mnemonic === 'negu' && operands.length === 2) {
    return [`subu ${operands[0]}, $zero, ${operands[1]}`];
  }
  if (mnemonic === 'mul' && operands.length === 3) {
    return [`mult ${operands[1]}, ${operands[2]}`, `mflo ${operands[0]}`];
  }
  if ((mnemonic === 'div' || mnemonic === 'divu') && operands.length === 3) {
    return [`${mnemonic} ${operands[1]}, ${operands[2]}`, `mflo ${operands[0]}`];
  }
  if ((mnemonic === 'rem' || mnemonic === 'remu') && operands.length === 3) {
    const real = mnemonic === 'remu' ? 'divu' : 'div';
    return [`${real} ${operands[1]}, ${operands[2]}`, `mfhi ${operands[0]}`];
  }
  if (['blt', 'bltu', 'bgt', 'bgtu', 'ble', 'bleu', 'bge', 'bgeu'].includes(mnemonic) && operands.length === 3) {
    return expandCompareBranch(mnemonic, operands);
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

export function syscallByOperand(operand: string): MipsSyscallInfo | undefined {
  const value = parseIntegerLiteral(operand);
  return value === undefined ? undefined : syscallsByCode.get(value);
}

export function cp0ByOperand(operand: string): MipsCp0RegisterInfo | undefined {
  const value = parseIntegerLiteral(operand.replace(/^\$/, ''));
  return value === undefined ? undefined : cp0RegistersByNumber.get(value);
}

export function syscallAtLiV0Operand(document: TextDocument, wordRange: Range) {
  const text = lineAt(document, wordRange.start.line).text;
  const code = stripLineComment(text);
  const word = document.getText(wordRange);
  const syscall = syscallByOperand(word);
  if (!syscall) {
    return undefined;
  }

  const prefix = code.slice(0, wordRange.start.character);
  if (!/\bli\s+\$v0\s*,\s*$/.test(prefix)) {
    return undefined;
  }
  return syscall;
}

export function syscallServiceBeforeLine(document: TextDocument, targetLine: number): MipsSyscallInfo | undefined {
  let activeMacro = false;
  let service: MipsSyscallInfo | undefined;
  for (let line = 0; line < targetLine; line++) {
    const code = stripLineComment(lineAt(document, line).text).trim();
    if (/^\.macro\b/.test(code)) {
      activeMacro = true;
      continue;
    }
    if (/^\.end_macro\b/.test(code)) {
      activeMacro = false;
      continue;
    }
    if (activeMacro || !code) {
      continue;
    }

    const li = code.match(/^li\s+\$v0\s*,\s*(\S+)\s*$/);
    if (li) {
      service = syscallByOperand(li[1]);
      continue;
    }
    if (/^syscall\b/.test(code)) {
      service = undefined;
      continue;
    }
    if (instructionWritesV0(code)) {
      service = undefined;
    }
  }
  return service;
}

export function instructionWritesV0(code: string): boolean {
  const match = code.match(/^[A-Za-z_.$][\w.$]*\s+([^,\s]+)/);
  return Boolean(match && (match[1] === '$v0' || match[1] === '$2'));
}

export function cp0RegisterAtPosition(document: TextDocument, word: string, position: Position) {
  const register = cp0ByOperand(word);
  if (!register) {
    return undefined;
  }
  const code = stripLineComment(lineAt(document, position.line).text);
  const match = code.match(/\b(?:mfc0|mtc0)\s+\$[A-Za-z0-9_]+\s*,\s*(\$?\d+)\b/);
  if (!match || match[1] !== word) {
    return undefined;
  }
  const start = code.indexOf(match[1]);
  if (position.character < start || position.character > start + match[1].length) {
    return undefined;
  }
  return register;
}

export function eqvReplacementText(document: TextDocument, lineNumber: number, name: string): string | undefined {
  const code = stripLineComment(lineAt(document, lineNumber).text);
  const pattern = new RegExp(`^\\s*\\.eqv\\s+${escapeRegExp(name)}(?:\\s*,?\\s+|\\s*,)(.+)$`);
  return code.match(pattern)?.[1]?.trim();
}

function expandLoadImmediate(register: string, operand: string): string[] | undefined {
  const value = parseIntegerLiteral(operand);
  if (value === undefined) {
    return undefined;
  }
  const unsigned = value < 0 ? value + 0x100000000 : value;
  const upper = Math.floor(unsigned / 0x10000) & 0xffff;
  const lower = unsigned & 0xffff;
  if (upper === 0) {
    return [`ori ${register}, $zero, ${formatHex16(lower)}`];
  }
  if (lower === 0) {
    return [`lui ${register}, ${formatHex16(upper)}`];
  }
  return [`lui $at, ${formatHex16(upper)}`, `ori ${register}, $at, ${formatHex16(lower)}`];
}

function formatHex16(value: number): string {
  return `0x${value.toString(16).padStart(4, '0')}`;
}

function fitsSigned16(value: number): boolean {
  const signed = value > 0x7fffffff ? value - 0x100000000 : value;
  return signed >= -32768 && signed <= 32767;
}

function expandCompareBranch(mnemonic: string, operands: string[]): string[] {
  const [left, right, label] = operands;
  switch (mnemonic) {
    case 'blt':
      return [`slt $at, ${left}, ${right}`, `bne $at, $zero, ${label}`];
    case 'bltu':
      return [`sltu $at, ${left}, ${right}`, `bne $at, $zero, ${label}`];
    case 'bgt':
      return [`slt $at, ${right}, ${left}`, `bne $at, $zero, ${label}`];
    case 'bgtu':
      return [`sltu $at, ${right}, ${left}`, `bne $at, $zero, ${label}`];
    case 'ble':
      return [`slt $at, ${right}, ${left}`, `beq $at, $zero, ${label}`];
    case 'bleu':
      return [`sltu $at, ${right}, ${left}`, `beq $at, $zero, ${label}`];
    case 'bge':
      return [`slt $at, ${left}, ${right}`, `beq $at, $zero, ${label}`];
    case 'bgeu':
      return [`sltu $at, ${left}, ${right}`, `beq $at, $zero, ${label}`];
    default:
      return [];
  }
}
