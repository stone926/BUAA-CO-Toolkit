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
  allMacros,
  findMacroAtPosition,
  symbolsVisibleAtPosition
} from './parser';
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
  completionReplaceRange,
  directiveCompletionReplaceRange
} from './text';

export function getMipsCompletions(document: TextDocument, position: Position, settings: CoSettings, state: MipsServerState): CompletionItem[] {
  const parsed = getCachedMipsParse(document, settings, state);
  const linePrefix = lineAt(document, position.line).text.slice(0, position.character);
  const items: CompletionItem[] = [];
  const directiveReplaceRange = directiveCompletionReplaceRange(linePrefix, position);

  const cp0Items = cp0CompletionItems(linePrefix, position);
  if (cp0Items) {
    return cp0Items;
  }

  const syscallItems = syscallCompletionItems(linePrefix, position);
  if (syscallItems) {
    return syscallItems;
  }

  if (/\$[\w]*$/.test(linePrefix)) {
    const replaceRange = completionReplaceRange(linePrefix, position, /\$[\w]*$/);
    for (const name of [...registerNames, ...numericRegisters()]) {
      items.push({
        label: name,
        kind: CompletionItemKind.Variable,
        detail: registerDescriptions.get(name) ?? 'MIPS register',
        textEdit: TextEdit.replace(replaceRange, name)
      });
    }
    return items;
  }

  if (/%[\w]*$/.test(linePrefix)) {
    const replaceRange = completionReplaceRange(linePrefix, position, /%[\w]*$/);
    for (const symbol of findMacroAtPosition(parsed, position)?.paramSymbols.values() ?? []) {
      items.push({
        label: symbol.name,
        kind: CompletionItemKind.Variable,
        detail: 'Macro parameter',
        textEdit: TextEdit.replace(replaceRange, symbol.name)
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
      item.detail = 'MIPS macro definition';
      item.insertTextFormat = InsertTextFormat.Snippet;
      item.textEdit = TextEdit.replace(
        directiveReplaceRange ?? Range.create(position, position),
        '.macro ${1:name}(${2:%arg})\n  ${0}\n.end_macro'
      );
    } else if (directive === '.align') {
      item.detail = 'Align next data item to 2^n bytes';
    }
    items.push(item);
  }

  items.push(
    {
      label: '.align 0',
      kind: CompletionItemKind.Keyword,
      detail: '1-byte alignment',
      textEdit: directiveReplaceRange ? TextEdit.replace(directiveReplaceRange, '.align 0') : undefined
    },
    {
      label: '.align 1',
      kind: CompletionItemKind.Keyword,
      detail: '2-byte alignment',
      textEdit: directiveReplaceRange ? TextEdit.replace(directiveReplaceRange, '.align 1') : undefined
    },
    {
      label: '.align 2',
      kind: CompletionItemKind.Keyword,
      detail: '4-byte alignment',
      textEdit: directiveReplaceRange ? TextEdit.replace(directiveReplaceRange, '.align 2') : undefined
    }
  );

  for (const symbol of symbolsVisibleAtPosition(parsed, position)) {
    items.push({
      label: symbol.name,
      kind: CompletionItemKind.Reference,
      detail: symbol.kind === 'data' ? 'Data symbol' : symbol.kind === 'eqv' ? '.eqv symbol' : 'Label'
    });
  }

  for (const macro of allMacros(parsed)) {
    items.push({
      label: macro.name,
      kind: CompletionItemKind.Function,
      detail: `Macro(${macro.params.join(', ')})`,
      insertText: `${macro.name}(${macro.params.map((param, index) => `\${${index + 1}:${param}}`).join(', ')})`,
      insertTextFormat: InsertTextFormat.Snippet
    });
  }

  return items;
}

function syscallCompletionItems(linePrefix: string, position: Position): CompletionItem[] | undefined {
  if (!/\bli\s+\$v0\s*,\s*[-+]?(?:0[xX][0-9A-Fa-f]*|0[bB][01]*|0[0-7]*|\d*)?$/.test(linePrefix)) {
    return undefined;
  }
  const replaceRange = completionReplaceRange(linePrefix, position, /[-+]?(?:0[xX][0-9A-Fa-f]*|0[bB][01]*|0[0-7]*|\d*)$/);
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

function cp0CompletionItems(linePrefix: string, position: Position): CompletionItem[] | undefined {
  if (!/\b(?:mfc0|mtc0)\s+\$[A-Za-z0-9_]+\s*,\s*\$?[A-Za-z0-9_]*$/.test(linePrefix)) {
    return undefined;
  }
  const replaceRange = completionReplaceRange(linePrefix, position, /\$?[A-Za-z0-9_]*$/);
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
