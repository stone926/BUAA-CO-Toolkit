import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  MarkupKind,
  Position,
  Range,
  TextEdit
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { cp0Markdown, syscallMarkdown } from './display';
import {
  findMipsSemanticMacroAtPosition,
  mipsSemanticSymbolsVisibleAtPosition
} from './semantic';
import { getCachedMipsParse } from './parseCache';
import {
  cp0Registers,
  directives,
  instructions,
  instructionTypeLabel,
  numericRegisters,
  registerDescriptions,
  registerNames,
  syscalls
} from './resources';
import { MipsServerState } from './state';
import {
  directiveCompletionReplaceRange,
  isIntegerLiteralPart,
  isMacroParameterPart,
  isRegisterPart,
  prefixedCompletionReplaceRange,
  suffixCompletionReplaceRange
} from './text';
import { MipsCstExecutable, parseMipsCstLine } from './syntax';

export function getMipsCompletions(document: TextDocument, position: Position, settings: CoSettings, state: MipsServerState): CompletionItem[] {
  const parsed = getCachedMipsParse(document, settings, state);
  const linePrefix = lineAt(document, position.line).text.slice(0, position.character);
  const prefixLine = parseMipsCstLine(linePrefix, position.line);
  const prefixExecutable = prefixLine.kind === 'statement' ? prefixLine.executable : undefined;
  const items: CompletionItem[] = [];
  const directiveReplaceRange = directiveCompletionReplaceRange(linePrefix, position);

  const cp0Items = cp0CompletionItems(prefixExecutable, linePrefix, position);
  if (cp0Items) {
    return cp0Items;
  }

  const syscallItems = syscallCompletionItems(prefixExecutable, linePrefix, position);
  if (syscallItems) {
    return syscallItems;
  }

  const registerReplaceRange = prefixedCompletionReplaceRange(linePrefix, position, '$', isRegisterPart);
  if (registerReplaceRange) {
    for (const name of [...registerNames, ...numericRegisters()]) {
      items.push({
        label: name,
        kind: CompletionItemKind.Variable,
        detail: registerDescriptions.get(name) ?? 'MIPS 寄存器',
        textEdit: TextEdit.replace(registerReplaceRange, name)
      });
    }
    return items;
  }

  const macroParameterReplaceRange = prefixedCompletionReplaceRange(linePrefix, position, '%', isMacroParameterPart);
  if (macroParameterReplaceRange) {
    for (const symbol of findMipsSemanticMacroAtPosition(parsed.semantic, position)?.paramSymbols.values() ?? []) {
      items.push({
        label: symbol.name,
        kind: CompletionItemKind.Variable,
        detail: '宏参数',
        textEdit: TextEdit.replace(macroParameterReplaceRange, symbol.name)
      });
    }
    return items;
  }

  for (const instruction of Object.values(instructions)) {
    items.push({
      label: instruction.mnemonic,
      kind: CompletionItemKind.Keyword,
      detail: `${instructionTypeLabel(instruction.type)} - ${instruction.summary}`,
      documentation: {
        kind: MarkupKind.Markdown,
        value: '```mipsasm\n' + instruction.formats.join('\n') + '\n```'
      }
    });
  }

  for (const directive of directives) {
    const item: CompletionItem = {
      label: directive,
      kind: CompletionItemKind.Keyword
    };
    if (directiveReplaceRange) {
      item.textEdit = TextEdit.replace(directiveReplaceRange, directive);
    }
    if (directive === '.macro') {
      item.detail = 'MIPS 宏定义';
      item.insertTextFormat = InsertTextFormat.Snippet;
      item.textEdit = TextEdit.replace(
        directiveReplaceRange ?? Range.create(position, position),
        '.macro ${1:name}(${2:%arg})\n  ${0}\n.end_macro'
      );
    } else if (directive === '.align') {
      item.detail = '按 2^n 字节对齐下一个数据项';
    }
    items.push(item);
  }

  items.push(
    {
      label: '.align 0',
      kind: CompletionItemKind.Keyword,
      detail: '1 字节对齐',
      textEdit: directiveReplaceRange ? TextEdit.replace(directiveReplaceRange, '.align 0') : undefined
    },
    {
      label: '.align 1',
      kind: CompletionItemKind.Keyword,
      detail: '2 字节对齐',
      textEdit: directiveReplaceRange ? TextEdit.replace(directiveReplaceRange, '.align 1') : undefined
    },
    {
      label: '.align 2',
      kind: CompletionItemKind.Keyword,
      detail: '4 字节对齐',
      textEdit: directiveReplaceRange ? TextEdit.replace(directiveReplaceRange, '.align 2') : undefined
    }
  );

  for (const symbol of mipsSemanticSymbolsVisibleAtPosition(parsed.semantic, position)) {
    items.push({
      label: symbol.name,
      kind: CompletionItemKind.Reference,
      detail: symbol.kind === 'data' ? '数据符号' : symbol.kind === 'eqv' ? '.eqv 符号' : '标签'
    });
  }

  for (const macro of parsed.semantic.macros) {
    items.push({
      label: macro.name,
      kind: CompletionItemKind.Function,
      detail: `宏(${macro.params.join(', ')})`,
      insertText: `${macro.name}(${macro.params.map((param, index) => `\${${index + 1}:${param}}`).join(', ')})`,
      insertTextFormat: InsertTextFormat.Snippet
    });
  }

  return items;
}

function syscallCompletionItems(executable: MipsCstExecutable | undefined, linePrefix: string, position: Position): CompletionItem[] | undefined {
  if (!executable || executable.lowerMnemonic !== 'li' || executable.operands[0]?.text !== '$v0' || operandSlotAtPosition(executable, position.character) !== 1) {
    return undefined;
  }
  const replaceRange = suffixCompletionReplaceRange(linePrefix, position, isIntegerLiteralPart);
  return syscalls.map((syscall) => ({
    label: String(syscall.code),
    kind: CompletionItemKind.Value,
    detail: `syscall ${syscall.name}`,
    textEdit: TextEdit.replace(replaceRange, String(syscall.code)),
    documentation: {
      kind: MarkupKind.Markdown,
      value: syscallMarkdown(syscall)
    }
  }));
}

function cp0CompletionItems(executable: MipsCstExecutable | undefined, linePrefix: string, position: Position): CompletionItem[] | undefined {
  if (!executable || (executable.lowerMnemonic !== 'mfc0' && executable.lowerMnemonic !== 'mtc0') || !executable.operands[0] || operandSlotAtPosition(executable, position.character) !== 1) {
    return undefined;
  }
  const replaceRange = suffixCompletionReplaceRange(linePrefix, position, isCp0RegisterPart);
  return cp0Registers.map((register) => ({
    label: `$${register.number}`,
    kind: CompletionItemKind.Variable,
    detail: `CP0 ${register.name}${register.alias ? ` (${register.alias})` : ''}`,
    textEdit: TextEdit.replace(replaceRange, `$${register.number}`),
    documentation: {
      kind: MarkupKind.Markdown,
      value: cp0Markdown(register)
    }
  }));
}

function operandSlotAtPosition(executable: MipsCstExecutable, character: number): number | undefined {
  if (!executable.operandRange || character < executable.operandRange.start) {
    return undefined;
  }
  const relativeEnd = Math.max(0, Math.min(character - executable.operandRange.start, executable.operandText.length));
  let slot = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < relativeEnd; index++) {
    const char = executable.operandText[index];
    if (inString) {
      if (char === '"' && !escaped) {
        inString = false;
        escaped = false;
      } else if (char !== '\\') {
        escaped = false;
      } else {
        escaped = !escaped;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      escaped = false;
      continue;
    }
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) {
      slot++;
    }
  }
  return slot;
}

function isCp0RegisterPart(char: string): boolean {
  return char === '$' || isRegisterPart(char);
}
