import { Hover, MarkupKind, Position } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { rangesEqual } from '../common/lsp';
import { CoSettings } from '../common/settings';
import {
  cp0Markdown,
  cp0RegisterAtPosition,
  directiveHoverText,
  eqvReplacementText,
  macroBody,
  macroExpansionPreview,
  pseudoExpansionPreview,
  syscallAtLiV0Operand,
  syscallMarkdown,
  syscallServiceBeforeLine
} from './display';
import {
  resolveMipsSemanticMacroParamAtPosition,
  resolveMipsSemanticSymbolAtPosition
} from './semantic';
import { getCachedMipsParse } from './parseCache';
import { findMacroOverloadAtPosition } from './queries';
import { MipsSymbol } from './model';
import {
  canonicalRegister,
  MipsInstruction,
  instructions,
  instructionTypeLabel,
  isFloatingPointRegister,
  isRegister,
  registerDescriptions
} from './resources';
import { MipsServerState } from './state';
import { getMipsWordRange } from './text';

export function getMipsHover(document: TextDocument, position: Position, settings: CoSettings, state: MipsServerState): Hover | undefined {
  const wordRange = getMipsWordRange(document, position);
  if (!wordRange) {
    return undefined;
  }
  const word = document.getText(wordRange);
  const parsed = getCachedMipsParse(document, settings, state);
  const directiveHover = directiveHoverText(word.toLowerCase());
  if (directiveHover) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: directiveHover
      },
      range: wordRange
    };
  }

  const semanticSymbol = semanticSymbolAtWordRange(parsed, word, position, wordRange);
  if (semanticSymbol) {
    return {
      contents: semanticSymbolHoverContents(parsed, semanticSymbol),
      range: wordRange
    };
  }

  const instruction = instructions[word.toLowerCase()];
  if (instruction) {
    const parsedInstruction = parsed.instructions.find((line) => rangesEqual(line.range, wordRange));
    const details = instructionHoverMarkdown(instruction, parsedInstruction);
    const expansion = parsedInstruction && (instruction.pseudo || parsedInstruction.usesPseudoForm)
      ? pseudoExpansionPreview(instruction.mnemonic, parsedInstruction.operands)
      : undefined;
    if (expansion?.length) {
      details.push('', '展开预览：', '', '```mipsasm', expansion.join('\n'), '```');
      if (expansion.some((line) => usesAtRegister(line))) {
        details.push('', '提示：展开会使用 `$at` (`$1`) 作为临时寄存器');
      }
    }
    if (instruction.mnemonic === 'syscall') {
      const syscall = syscallServiceBeforeLine(parsed, position.line);
      if (syscall) {
        details.push('', `当前 $v0 服务：**${syscall.code} ${syscall.name}** - ${syscall.description}`, '', `参数：${syscall.parameters ?? '无'}`, '', `返回值：${syscall.returns ?? '无'}`);
      }
    }
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: details.join('\n')
      },
      range: wordRange
    };
  }

  const syscall = syscallAtLiV0Operand(parsed, wordRange);
  if (syscall) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: syscallMarkdown(syscall)
      },
      range: wordRange
    };
  }

  const cp0 = cp0RegisterAtPosition(parsed, word, position);
  if (cp0) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: cp0Markdown(cp0)
      },
      range: wordRange
    };
  }

  if (isRegister(word) || isFloatingPointRegister(word)) {
    const canonical = canonicalRegister(word);
    return {
      contents: registerDescriptions.get(canonical) ?? (isFloatingPointRegister(word) ? `MARS 浮点寄存器 ${word}` : `MIPS 寄存器 ${word}`),
      range: wordRange
    };
  }

  const param = resolveMipsSemanticMacroParamAtPosition(parsed.semantic, word, position);
  if (param) {
    return {
      contents: `宏参数，定义于第 ${param.range.start.line + 1} 行`,
      range: wordRange
    };
  }

  const symbol = resolveMipsSemanticSymbolAtPosition(parsed.semantic, word, position);
  if (symbol) {
    return {
      contents: semanticSymbolHoverContents(parsed, symbol),
      range: wordRange
    };
  }

  const macro = findMacroOverloadAtPosition(parsed, word, position);
  if (macro) {
    const expansion = macroExpansionPreview(document, parsed, macro, word, position);
    const value = [
      `**宏** \`${macro.name}(${macro.params.join(', ')})\``,
      '',
      '```mipsasm',
      macroBody(document, macro.bodyStartLine, macro.bodyEndLine),
      '```'
    ];
    if (expansion) {
      value.push('', '展开预览：', '', '```mipsasm', expansion, '```');
    }
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: value.join('\n')
      },
      range: wordRange
    };
  }

  return undefined;
}

function semanticSymbolAtWordRange(parsed: ReturnType<typeof getCachedMipsParse>, word: string, position: Position, wordRange: { start: Position; end: Position }): MipsSymbol | undefined {
  const declaration = parsed.semantic.declarations.find((item) =>
    item.name === word &&
    item.symbol &&
    rangesEqual(item.selectionRange, wordRange)
  );
  if (declaration?.symbol) {
    return declaration.symbol;
  }

  const reference = parsed.semantic.references.find((item) =>
    item.name === word &&
    item.symbol &&
    rangesEqual(item.range, wordRange) &&
    position.character >= item.range.start.character &&
    position.character <= item.range.end.character
  );
  return reference?.symbol;
}

function semanticSymbolHoverContents(parsed: ReturnType<typeof getCachedMipsParse>, symbol: MipsSymbol): string {
  const kind = symbol.kind === 'data' ? '数据符号' : symbol.kind === 'eqv' ? '.eqv 符号' : '标签';
  if (symbol.kind === 'eqv') {
    const replacement = eqvReplacementText(parsed, symbol.selectionRange.start.line, symbol.name);
    return replacement ? `${kind}，定义于第 ${symbol.range.start.line + 1} 行\n\n替换为：\`${replacement}\`` : `${kind}，定义于第 ${symbol.range.start.line + 1} 行`;
  }
  return `${kind}，定义于第 ${symbol.range.start.line + 1} 行`;
}

function instructionHoverMarkdown(instruction: MipsInstruction, parsedInstruction?: { usesPseudoForm: boolean }): string[] {
  const details = [
    `**${instruction.mnemonic}** - ${instruction.summary}`,
    '',
    instructionStatusLine(instruction, parsedInstruction),
    '',
    '格式：',
    '',
    '```mipsasm',
    ...instruction.formats,
    '```',
    '',
    `说明：${instruction.description}`
  ];

  if (instruction.pseudo || parsedInstruction?.usesPseudoForm) {
    details.push('', '请确认展开后的真指令');
  }
  return details;
}

function instructionStatusLine(instruction: MipsInstruction, parsedInstruction?: { usesPseudoForm: boolean }): string {
  const parts = [`类型：**${instructionTypeLabel(instruction.type)}**`];
  if (!instruction.pseudo && parsedInstruction?.usesPseudoForm) {
    parts.push('当前写法：**伪指令形式**');
  } else if (!instruction.pseudo && hasPseudoFormats(instruction)) {
    parts.push('含伪指令形式');
  }
  if (instruction.delaySlot) {
    parts.push('控制转移，延迟槽取决于项目配置');
  }
  return parts.join('；');
}

function hasPseudoFormats(instruction: MipsInstruction): boolean {
  return !instruction.pseudo && instruction.formats.some((format) => formatUsesPseudoForm(instruction.mnemonic, format));
}

function formatUsesPseudoForm(mnemonic: string, format: string): boolean {
  if (['add', 'addu', 'sub', 'subu', 'mul'].includes(mnemonic)) {
    return /(?:simm16|uimm16|imm32)\b/.test(format);
  }
  if (['addi', 'addiu', 'andi', 'ori', 'xori'].includes(mnemonic)) {
    return /\bimm32\b/.test(format);
  }
  if (['and', 'or', 'xor'].includes(mnemonic)) {
    return /\buimm16\b/.test(format);
  }
  if (mnemonic === 'div' || mnemonic === 'divu') {
    return format.includes('$rd') || /(?:simm16|imm32)\b/.test(format);
  }
  if (mnemonic === 'beq' || mnemonic === 'bne') {
    return /(?:simm16|imm32)\b/.test(format);
  }
  if (['lw', 'sw', 'lb', 'lbu', 'lh', 'lhu', 'lwl', 'lwr', 'sb', 'sh', 'swl', 'swr'].includes(mnemonic)) {
    return format.includes('label') || /\b(?:uimm16|imm32)\b/.test(format) || format.includes('($base)');
  }
  return false;
}

function usesAtRegister(line: string): boolean {
  return /(?:^|[\s,])(?:\$at|\$1)(?=$|[\s,)])/.test(line);
}
