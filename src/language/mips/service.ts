import {
  CodeAction,
  CodeActionKind,
  Command,
  CompletionItem,
  CompletionItemKind,
  Diagnostic,
  DocumentSymbol,
  Hover,
  InlayHint,
  InlayHintKind,
  InsertTextFormat,
  Location,
  MarkupKind,
  Position,
  Range,
  ReferenceParams,
  SemanticTokens,
  SemanticTokensBuilder,
  SymbolKind,
  TextEdit
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt, rangesEqual } from '../common/lsp';
import { CoSettings } from '../common/settings';
import {
  allDataSymbols,
  allEqvSymbols,
  allLabelSymbols,
  allMacros,
  allMacroParams,
  allSymbols,
  findCommentIndex,
  findMacroAtPosition,
  findMacroParamAtPosition,
  formatMipsLine,
  getStringRanges,
  isInsideAnyRange,
  MipsMacro,
  MipsParseResult,
  parseIntegerLiteral,
  parseMacroArguments,
  resolveDataSymbolAtPosition,
  resolveEqvSymbolAtPosition,
  resolveLabelAtPosition,
  resolveSymbolAtPosition,
  symbolsVisibleAtPosition
} from './parser';
import { clearCachedMipsParse, getCachedMipsParse } from './parseCache';
import {
  canonicalRegister,
  cp0Registers,
  cp0RegistersByNumber,
  directives,
  instructions,
  instructionSemanticTokenType,
  instructionTypeLabel,
  isFloatingPointRegister,
  isRegister,
  MipsCp0RegisterInfo,
  mipsSemanticTokenTypes,
  MipsSemanticTokenType,
  MipsSyscallInfo,
  numericRegisters,
  registerDescriptions,
  registerNames,
  syscalls,
  syscallsByCode
} from './resources';

export const mipsIgnorePseudoFileCommand = 'co.server.mips.ignorePseudoWarningsForFile';
export const mipsIgnorePseudoMnemonicCommand = 'co.server.mips.ignorePseudoWarningsForMnemonic';

export interface MipsServerState {
  ignoredPseudoInstructionFiles: Set<string>;
  ignoredPseudoInstructionMnemonics: Set<string>;
}

interface MipsSemanticTokenCandidate {
  range: Range;
  tokenType: MipsSemanticTokenType;
  modifiers?: string[];
}

const tokenTypeIndex = new Map(mipsSemanticTokenTypes.map((type, index) => [type, index] as const));
const tokenModifierIndex = new Map<string, number>([['declaration', 0]]);

export const clearMipsParseCache = clearCachedMipsParse;

export function getMipsDiagnostics(document: TextDocument, settings: CoSettings, state: MipsServerState): Diagnostic[] {
  return getCachedMipsParse(document, settings, state).diagnostics;
}

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

function directiveCompletionReplaceRange(linePrefix: string, position: Position): Range | undefined {
  const match = linePrefix.match(/\.[A-Za-z_]*$/);
  if (!match) {
    return undefined;
  }
  return Range.create(position.line, position.character - match[0].length, position.line, position.character);
}

function completionReplaceRange(linePrefix: string, position: Position, pattern: RegExp): Range {
  const match = linePrefix.match(pattern);
  const length = match?.[0].length ?? 0;
  return Range.create(position.line, position.character - length, position.line, position.character);
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

function directiveHoverText(directive: string): string | undefined {
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

export function getMipsDefinition(document: TextDocument, position: Position, settings: CoSettings, state: MipsServerState): Location | undefined {
  const wordRange = getMipsWordRange(document, position);
  if (!wordRange) {
    return undefined;
  }
  const word = document.getText(wordRange);
  const parsed = getCachedMipsParse(document, settings, state);
  const param = findMacroParamAtPosition(parsed, word, position);
  if (param) {
    return Location.create(document.uri, param.selectionRange);
  }
  const symbol = resolveSymbolAtPosition(parsed, word, position);
  if (symbol) {
    return Location.create(document.uri, symbol.selectionRange);
  }
  const macro = findMacroOverloadAtPosition(document, parsed, word, position);
  if (macro) {
    return Location.create(document.uri, macro.selectionRange);
  }
  return undefined;
}

export function getMipsReferences(document: TextDocument, params: ReferenceParams, settings: CoSettings, state: MipsServerState): Location[] {
  const position = params.position;
  const wordRange = getMipsWordRange(document, position);
  if (!wordRange) {
    return [];
  }
  const word = document.getText(wordRange);
  const parsed = getCachedMipsParse(document, settings, state);

  const param = findMacroParamAtPosition(parsed, word, position) ?? allMacroParams(parsed).find((item) => rangesEqual(item.selectionRange, wordRange));
  if (param) {
    return collectTokenReferences(document, word, (range) => {
      const macro = findMacroAtPosition(parsed, range.start);
      return Boolean(macro && macro.name === param.macroName && macro.paramSymbols.get(word)?.selectionRange.start.line === param.selectionRange.start.line);
    }, param.selectionRange, params.context.includeDeclaration);
  }

  const symbol = resolveSymbolAtPosition(parsed, word, position) ?? allSymbols(parsed).find((item) => rangesEqual(item.selectionRange, wordRange));
  if (symbol) {
    return collectTokenReferences(document, word, (range) => resolveSymbolAtPosition(parsed, word, range.start)?.selectionRange.start.line === symbol.selectionRange.start.line, symbol.selectionRange, params.context.includeDeclaration);
  }

  const macro = findMacroOverloadAtPosition(document, parsed, word, position) ?? allMacros(parsed).find((item) => rangesEqual(item.selectionRange, wordRange));
  if (macro) {
    const targetMacro = macro;
    return collectTokenReferences(document, word, (range) => {
      const overload = findMacroOverloadAtPosition(document, parsed, word, range.start);
      return overload?.selectionRange.start.line === targetMacro.selectionRange.start.line;
    }, targetMacro.selectionRange, params.context.includeDeclaration);
  }

  return [];
}

export function getMipsDocumentSymbols(document: TextDocument, settings: CoSettings, state: MipsServerState): DocumentSymbol[] {
  const parsed = getCachedMipsParse(document, settings, state);
  const symbols: DocumentSymbol[] = [];
  for (const symbol of allSymbols(parsed)) {
    const kind = symbol.kind === 'data' || symbol.kind === 'eqv' ? SymbolKind.Variable : SymbolKind.Function;
    symbols.push(DocumentSymbol.create(symbol.name, symbol.kind, kind, symbol.range, symbol.selectionRange));
  }
  for (const macro of allMacros(parsed)) {
    symbols.push(DocumentSymbol.create(macro.name, `macro(${macro.params.join(', ')})`, SymbolKind.Function, macro.range, macro.selectionRange));
  }
  return symbols.sort((a, b) => a.range.start.line - b.range.start.line);
}

export function getMipsCodeActions(document: TextDocument, diagnostics: Diagnostic[]): CodeAction[] {
  const pseudoDiagnostic = diagnostics.find((diagnostic) => typeof diagnostic.code === 'string' && diagnostic.code.startsWith('pseudo-instruction:'));
  if (!pseudoDiagnostic || typeof pseudoDiagnostic.code !== 'string') {
    return [];
  }

  const mnemonic = pseudoDiagnostic.code.slice('pseudo-instruction:'.length);
  return [
    CodeAction.create(
      `Ignore '${mnemonic}' pseudo-instruction warnings until reload`,
      Command.create(`Ignore ${mnemonic}`, mipsIgnorePseudoMnemonicCommand, mnemonic),
      CodeActionKind.QuickFix
    ),
    CodeAction.create(
      'Ignore pseudo-instruction warnings in this file until reload',
      Command.create('Ignore pseudo warnings for file', mipsIgnorePseudoFileCommand, document.uri),
      CodeActionKind.QuickFix
    ),
    CodeAction.create(
      'Disable pseudo-instruction warnings in this workspace',
      Command.create('Disable pseudo warnings', 'co.mips.disablePseudoWarnings'),
      CodeActionKind.QuickFix
    )
  ];
}

export function getMipsFormattingEdits(document: TextDocument): TextEdit[] {
  const edits: TextEdit[] = [];
  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const line = lineAt(document, lineNumber);
    const formatted = formatMipsLine(line.text);
    if (formatted !== line.text) {
      edits.push(TextEdit.replace(line.range, formatted));
    }
  }
  return edits;
}

export function getMipsInlayHints(document: TextDocument, range: Range, settings: CoSettings, state: MipsServerState): InlayHint[] {
  const hints: InlayHint[] = [];
  const startLine = Math.max(0, range.start.line);
  const endLine = Math.min(document.lineCount - 1, range.end.line);
  const serviceStack: Array<MipsSyscallInfo | undefined> = [];
  let currentSyscall: MipsSyscallInfo | undefined;

  for (let lineNumber = 0; lineNumber <= endLine; lineNumber++) {
    const text = lineAt(document, lineNumber).text;
    const code = stripLineComment(text);
    const trimmed = code.trim();
    const inRequestedRange = lineNumber >= startLine;

    if (/^\.macro\b/.test(trimmed)) {
      serviceStack.push(currentSyscall);
      currentSyscall = undefined;
      continue;
    }

    if (/^\.end_macro\b/.test(trimmed)) {
      currentSyscall = serviceStack.pop();
      continue;
    }

    const syscallLoad = code.match(/\bli\s+\$v0\s*,\s*(\S+)/);
    if (syscallLoad) {
      const syscall = syscallByOperand(syscallLoad[1]);
      if (syscall) {
        const start = code.indexOf(syscallLoad[1]);
        if (inRequestedRange) {
          hints.push({
            position: Position.create(lineNumber, start + syscallLoad[1].length),
            label: ` ${syscall.name}`,
            kind: InlayHintKind.Parameter,
            tooltip: markdownTooltip(syscallMarkdown(syscall)),
            paddingLeft: true
          });
        }
        currentSyscall = syscall;
      }
    } else if (instructionWritesV0(code)) {
      currentSyscall = undefined;
    }

    const syscallInstruction = code.match(/^\s*syscall\b/);
    if (syscallInstruction) {
      if (currentSyscall && inRequestedRange) {
        hints.push({
          position: Position.create(lineNumber, syscallInstruction[0].length),
          label: ` ${currentSyscall.name}`,
          kind: InlayHintKind.Parameter,
          tooltip: markdownTooltip(syscallMarkdown(currentSyscall)),
          paddingLeft: true
        });
      }
      currentSyscall = undefined;
    }

    const cp0Access = code.match(/\b(?:mfc0|mtc0)\s+\$[A-Za-z0-9_]+\s*,\s*(\$?\d+)\b/);
    if (cp0Access && inRequestedRange) {
      const register = cp0ByOperand(cp0Access[1]);
      if (register) {
        const start = code.indexOf(cp0Access[1]);
        hints.push({
          position: Position.create(lineNumber, start + cp0Access[1].length),
          label: ` ${register.name}${register.alias ? `/${register.alias}` : ''}`,
          kind: InlayHintKind.Type,
          tooltip: markdownTooltip(cp0Markdown(register)),
          paddingLeft: true
        });
      }
    }
  }
  return hints;
}

export function getMipsSemanticTokens(document: TextDocument, settings: CoSettings, state: MipsServerState): SemanticTokens {
  const parsed = getCachedMipsParse(document, settings, state);
  const tokens: MipsSemanticTokenCandidate[] = [];
  const builder = new SemanticTokensBuilder();

  for (const macro of allMacros(parsed)) {
    pushSemanticToken(tokens, macro.selectionRange, 'mipsMacro', ['declaration']);
  }
  for (const param of allMacroParams(parsed)) {
    pushSemanticToken(tokens, param.selectionRange, 'mipsMacroParameter', ['declaration']);
  }
  for (const symbol of allLabelSymbols(parsed)) {
    pushSemanticToken(tokens, symbol.selectionRange, 'mipsLabel', ['declaration']);
  }
  for (const symbol of allDataSymbols(parsed)) {
    pushSemanticToken(tokens, symbol.selectionRange, 'mipsDataSymbol', ['declaration']);
  }
  for (const symbol of allEqvSymbols(parsed)) {
    pushSemanticToken(tokens, symbol.selectionRange, 'mipsEqvSymbol', ['declaration']);
  }

  const tokenRegex = /%?[A-Za-z_.$][\w.$]*|\$[A-Za-z0-9_]+/g;
  const numberRegex = /[-+]?(?:0[xX][0-9A-Fa-f]+|0[bB][01]+|0[0-7]+|\b\d+\b)/g;
  const punctuationRegex = /[(),:]/g;
  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const text = lineAt(document, lineNumber).text;
    const commentIndex = findCommentIndex(text);
    if (commentIndex >= 0) {
      pushSemanticToken(tokens, Range.create(lineNumber, commentIndex, lineNumber, text.length), 'mipsComment');
    }
    const code = commentIndex >= 0 ? text.slice(0, commentIndex) : text;
    const stringRanges = getStringRanges(code);
    for (const stringRange of stringRanges) {
      pushSemanticToken(tokens, Range.create(lineNumber, stringRange.start, lineNumber, stringRange.end), 'mipsString');
    }

    let numberMatch: RegExpExecArray | null;
    while ((numberMatch = numberRegex.exec(code))) {
      const previous = numberMatch.index > 0 ? code[numberMatch.index - 1] : '';
      if (!isInsideAnyRange(numberMatch.index, stringRanges) && previous !== '$') {
        pushSemanticToken(tokens, Range.create(lineNumber, numberMatch.index, lineNumber, numberMatch.index + numberMatch[0].length), 'mipsNumber');
      }
    }

    let punctuationMatch: RegExpExecArray | null;
    while ((punctuationMatch = punctuationRegex.exec(code))) {
      if (!isInsideAnyRange(punctuationMatch.index, stringRanges)) {
        pushSemanticToken(tokens, Range.create(lineNumber, punctuationMatch.index, lineNumber, punctuationMatch.index + punctuationMatch[0].length), 'mipsPunctuation');
      }
    }

    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(code))) {
      const token = match[0];
      const previous = match.index > 0 ? code[match.index - 1] : '';
      if (previous === '$' || isInsideAnyRange(match.index, stringRanges)) {
        continue;
      }

      const range = Range.create(lineNumber, match.index, lineNumber, match.index + token.length);
      if (isKnownDeclarationRange(range, parsed)) {
        continue;
      }

      if (token.startsWith('$') && cp0RegisterAtPosition(document, token, range.start)) {
        pushSemanticToken(tokens, range, 'mipsCp0Register');
      } else if (token.startsWith('$') && (isRegister(token) || isFloatingPointRegister(token))) {
        pushSemanticToken(tokens, range, 'mipsRegister');
      } else if (token.startsWith('.') && directives.has(token.toLowerCase())) {
        pushSemanticToken(tokens, range, 'mipsDirective');
      } else if (token.startsWith('%') && findMacroParamAtPosition(parsed, token, range.start)) {
        pushSemanticToken(tokens, range, 'mipsMacroParameter');
      } else if (instructions[token.toLowerCase()]) {
        const parsedInstruction = parsed.instructions.find((line) => rangesEqual(line.range, range));
        pushSemanticToken(tokens, range, instructionSemanticTokenType(instructions[token.toLowerCase()], settings, parsedInstruction?.usesPseudoForm));
      } else if (parsed.macros.has(token)) {
        pushSemanticToken(tokens, range, 'mipsMacro');
      } else if (resolveLabelAtPosition(parsed, token, range.start)) {
        pushSemanticToken(tokens, range, 'mipsLabel');
      } else if (resolveDataSymbolAtPosition(parsed, token, range.start)) {
        pushSemanticToken(tokens, range, 'mipsDataSymbol');
      } else if (resolveEqvSymbolAtPosition(parsed, token, range.start)) {
        pushSemanticToken(tokens, range, 'mipsEqvSymbol');
      }
    }
  }

  tokens.sort(compareSemanticTokens);
  for (const token of tokens) {
    const type = tokenTypeIndex.get(token.tokenType);
    if (type === undefined) {
      continue;
    }
    builder.push(
      token.range.start.line,
      token.range.start.character,
      token.range.end.character - token.range.start.character,
      type,
      tokenModifierBitset(token.modifiers)
    );
  }
  return builder.build();
}

function getMipsWordRange(document: TextDocument, position: Position): Range | undefined {
  const text = lineAt(document, position.line).text;
  const regex = /[%$]?[A-Za-z_.$0-9][\w.$]*/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character >= start && position.character <= end) {
      return Range.create(position.line, start, position.line, end);
    }
  }
  return undefined;
}

function findMacroOverloadAtPosition(document: TextDocument, parsed: MipsParseResult, name: string, position: Position): MipsMacro | undefined {
  const currentMacro = findMacroAtPosition(parsed, position);
  if (currentMacro?.name === name) {
    return currentMacro;
  }

  const overloads = parsed.macros.get(name) ?? [];
  if (!overloads.length) {
    return undefined;
  }

  const callArgs = macroCallArgumentsAtPosition(document, name, position);
  if (callArgs !== undefined) {
    return overloads.find((macro) => macro.params.length === callArgs.length) ?? overloads[0];
  }

  return overloads[0];
}

function macroCallArgumentsAtPosition(document: TextDocument, name: string, position: Position): string[] | undefined {
  const text = lineAt(document, position.line).text;
  const commentIndex = findCommentIndex(text);
  const code = commentIndex >= 0 ? text.slice(0, commentIndex) : text;
  const indent = code.search(/\S/);
  if (indent < 0) {
    return undefined;
  }
  const trimmed = code.trim();
  const firstToken = trimmed.match(/^([A-Za-z_.$][\w.$]*)/);
  if (!firstToken || firstToken[1] !== name) {
    return undefined;
  }
  const tokenStart = indent + trimmed.indexOf(firstToken[1]);
  const tokenEnd = tokenStart + firstToken[1].length;
  if (position.character < tokenStart || position.character > tokenEnd) {
    return undefined;
  }
  return parseMacroArguments(trimmed.slice(firstToken[0].length).trim());
}

function collectTokenReferences(
  document: TextDocument,
  name: string,
  matchesTarget: (range: Range) => boolean,
  declarationRange?: Range,
  includeDeclaration = false
): Location[] {
  const locations: Location[] = [];
  if (declarationRange && includeDeclaration) {
    locations.push(Location.create(document.uri, declarationRange));
  }

  const tokenRegex = /%?[A-Za-z_.$][\w.$]*|\$[A-Za-z0-9_]+/g;
  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const text = lineAt(document, lineNumber).text;
    const commentIndex = findCommentIndex(text);
    const code = commentIndex >= 0 ? text.slice(0, commentIndex) : text;
    const stringRanges = getStringRanges(code);
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(code))) {
      if (match[0] !== name || isInsideAnyRange(match.index, stringRanges)) {
        continue;
      }
      const previous = match.index > 0 ? code[match.index - 1] : '';
      if (previous === '$') {
        continue;
      }
      const range = Range.create(lineNumber, match.index, lineNumber, match.index + name.length);
      if (declarationRange && rangesEqual(range, declarationRange)) {
        continue;
      }
      if (matchesTarget(range)) {
        locations.push(Location.create(document.uri, range));
      }
    }
  }

  return locations;
}

function macroBody(document: TextDocument, bodyStartLine: number, bodyEndLine?: number): string {
  if (bodyEndLine === undefined || bodyEndLine < bodyStartLine) {
    return '';
  }
  const lines: string[] = [];
  for (let line = bodyStartLine; line <= bodyEndLine; line++) {
    lines.push(lineAt(document, line).text);
  }
  return lines.join('\n');
}

function macroExpansionPreview(document: TextDocument, macro: MipsMacro, name: string, position: Position): string | undefined {
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

function pseudoExpansionPreview(mnemonic: string, operands: string[]): string[] | undefined {
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

function syscallMarkdown(syscall: MipsSyscallInfo): string {
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

function markdownTooltip(value: string) {
  return {
    kind: MarkupKind.Markdown,
    value
  };
}

function cp0Markdown(register: MipsCp0RegisterInfo): string {
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

function syscallByOperand(operand: string): MipsSyscallInfo | undefined {
  const value = parseIntegerLiteral(operand);
  return value === undefined ? undefined : syscallsByCode.get(value);
}

function cp0ByOperand(operand: string): MipsCp0RegisterInfo | undefined {
  const value = parseIntegerLiteral(operand.replace(/^\$/, ''));
  return value === undefined ? undefined : cp0RegistersByNumber.get(value);
}

function syscallAtLiV0Operand(document: TextDocument, wordRange: Range) {
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

function syscallServiceBeforeLine(document: TextDocument, targetLine: number): MipsSyscallInfo | undefined {
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

function instructionWritesV0(code: string): boolean {
  const match = code.match(/^[A-Za-z_.$][\w.$]*\s+([^,\s]+)/);
  return Boolean(match && (match[1] === '$v0' || match[1] === '$2'));
}

function cp0RegisterAtPosition(document: TextDocument, word: string, position: Position) {
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

function eqvReplacementText(document: TextDocument, lineNumber: number, name: string): string | undefined {
  const code = stripLineComment(lineAt(document, lineNumber).text);
  const pattern = new RegExp(`^\\s*\\.eqv\\s+${escapeRegExp(name)}(?:\\s*,?\\s+|\\s*,)(.+)$`);
  return code.match(pattern)?.[1]?.trim();
}

function stripLineComment(line: string): string {
  const commentIndex = findCommentIndex(line);
  return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isKnownDeclarationRange(range: Range, parsed: MipsParseResult): boolean {
  const declarationRanges = [
    ...allMacros(parsed).map((macro) => macro.selectionRange),
    ...allMacroParams(parsed).map((param) => param.selectionRange),
    ...allSymbols(parsed).map((symbol) => symbol.selectionRange)
  ];
  return declarationRanges.some((declarationRange) => rangesEqual(declarationRange, range));
}

function pushSemanticToken(
  tokens: MipsSemanticTokenCandidate[],
  range: Range,
  tokenType: MipsSemanticTokenType,
  modifiers?: string[]
): void {
  if (range.start.line === range.end.line && range.start.character === range.end.character) {
    return;
  }
  tokens.push({
    range,
    tokenType,
    modifiers
  });
}

function compareSemanticTokens(left: MipsSemanticTokenCandidate, right: MipsSemanticTokenCandidate): number {
  if (left.range.start.line !== right.range.start.line) {
    return left.range.start.line - right.range.start.line;
  }
  if (left.range.start.character !== right.range.start.character) {
    return left.range.start.character - right.range.start.character;
  }
  return left.range.end.character - right.range.end.character;
}

function tokenModifierBitset(modifiers?: string[]): number {
  if (!modifiers?.length) {
    return 0;
  }
  let bitset = 0;
  for (const modifier of modifiers) {
    const index = tokenModifierIndex.get(modifier);
    if (index !== undefined) {
      bitset |= 1 << index;
    }
  }
  return bitset;
}
