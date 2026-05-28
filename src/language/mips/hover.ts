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
      `Type: **${instructionTypeLabel(instruction.type)}**`,
      '',
      '```mipsasm',
      instruction.formats.join('\n'),
      '```',
      '',
      instruction.description
    ];
    if (instruction.pseudo) {
      details.push('', 'Pseudo instruction. Check generated code before using it in restricted projects.');
    }
    if (instruction.delaySlot) {
      details.push('', 'Control-transfer instruction. Delay-slot behavior depends on the current project/profile.');
    }
    const parsedInstruction = parsed.instructions.find((line) => rangesEqual(line.range, wordRange));
    const expansion = parsedInstruction ? pseudoExpansionPreview(instruction.mnemonic, parsedInstruction.operands) : undefined;
    if (expansion?.length) {
      details.push('', 'Possible MARS expansion:', '', '```mipsasm', expansion.join('\n'), '```');
    }
    if (instruction.mnemonic === 'syscall') {
      const syscall = syscallServiceBeforeLine(document, position.line);
      if (syscall) {
        details.push('', `Current $v0 service: **${syscall.code} ${syscall.name}** - ${syscall.description}`, '', `参数：${syscall.parameters ?? '无'}`, '', `返回值：${syscall.returns ?? '无'}`);
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

  const syscall = syscallAtLiV0Operand(document, wordRange);
  if (syscall) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: syscallMarkdown(syscall)
      },
      range: wordRange
    };
  }

  const cp0 = cp0RegisterAtPosition(document, word, position);
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
      contents: registerDescriptions.get(canonical) ?? (isFloatingPointRegister(word) ? `MARS floating-point register ${word}` : `MIPS register ${word}`),
      range: wordRange
    };
  }

  const param = findMacroParamAtPosition(parsed, word, position);
  if (param) {
    return {
      contents: `Macro parameter defined on line ${param.range.start.line + 1}.`,
      range: wordRange
    };
  }

  const symbol = resolveSymbolAtPosition(parsed, word, position);
  if (symbol) {
    const kind = symbol.kind === 'data' ? 'Data symbol' : symbol.kind === 'eqv' ? '.eqv symbol' : 'Label';
    if (symbol.kind === 'eqv') {
      const replacement = eqvReplacementText(document, symbol.selectionRange.start.line, symbol.name);
      return {
        contents: replacement ? `${kind} defined on line ${symbol.range.start.line + 1}.\n\nReplacement: \`${replacement}\`` : `${kind} defined on line ${symbol.range.start.line + 1}.`,
        range: wordRange
      };
    }
    return {
      contents: `${kind} defined on line ${symbol.range.start.line + 1}.`,
      range: wordRange
    };
  }

  const macro = findMacroOverloadAtPosition(document, parsed, word, position);
  if (macro) {
    const expansion = macroExpansionPreview(document, macro, word, position);
    const value = [
      `**Macro** \`${macro.name}(${macro.params.join(', ')})\``,
      '',
      '```mipsasm',
      macroBody(document, macro.bodyStartLine, macro.bodyEndLine),
      '```'
    ];
    if (expansion) {
      value.push('', 'Expansion preview:', '', '```mipsasm', expansion, '```');
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
