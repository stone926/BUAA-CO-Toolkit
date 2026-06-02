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
  findMacroParamAtPosition,
  resolveSymbolAtPosition
} from './parser';
import { getCachedMipsParse } from './parseCache';
import { findMacroOverloadAtPosition } from './queries';
import {
  canonicalRegister,
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

  const instruction = instructions[word.toLowerCase()];
  if (instruction) {
    const details = [
      `**${instruction.mnemonic}** - ${instruction.summary}`,
      '',
      `类型：**${instructionTypeLabel(instruction.type)}**`,
      '',
      '```mipsasm',
      instruction.formats.join('\n'),
      '```',
      '',
      instruction.description
    ];
    if (instruction.pseudo) {
      details.push('', '⚠️ 伪指令。在受限项目中使用前请检查生成的代码。');
    }
    if (instruction.delaySlot) {
      details.push('', '🔄 控制转移指令。延迟槽行为取决于当前项目/Profile。');
    }
    const parsedInstruction = parsed.instructions.find((line) => rangesEqual(line.range, wordRange));
    const expansion = parsedInstruction ? pseudoExpansionPreview(instruction.mnemonic, parsedInstruction.operands) : undefined;
    if (expansion?.length) {
      details.push('', '可能的 MARS 展开：', '', '```mipsasm', expansion.join('\n'), '```');
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

  const param = findMacroParamAtPosition(parsed, word, position);
  if (param) {
    return {
      contents: `宏参数，定义于第 ${param.range.start.line + 1} 行。`,
      range: wordRange
    };
  }

  const symbol = resolveSymbolAtPosition(parsed, word, position);
  if (symbol) {
    const kind = symbol.kind === 'data' ? '数据符号' : symbol.kind === 'eqv' ? '.eqv 符号' : '标签';
    if (symbol.kind === 'eqv') {
      const replacement = eqvReplacementText(parsed, symbol.selectionRange.start.line, symbol.name);
      return {
        contents: replacement ? `${kind}，定义于第 ${symbol.range.start.line + 1} 行。\n\n替换为：\`${replacement}\`` : `${kind}，定义于第 ${symbol.range.start.line + 1} 行。`,
        range: wordRange
      };
    }
    return {
      contents: `${kind}，定义于第 ${symbol.range.start.line + 1} 行。`,
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
