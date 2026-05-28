import {
  CodeAction,
  CodeActionKind,
  Command,
  CompletionItem,
  CompletionItemKind,
  Diagnostic,
  DocumentSymbol,
  Hover,
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
  parseMips,
  parseMacroArguments,
  parseOperands,
  resolveDataSymbolAtPosition,
  resolveEqvSymbolAtPosition,
  resolveLabelAtPosition,
  resolveSymbolAtPosition,
  symbolsVisibleAtPosition
} from './parser';
import {
  canonicalRegister,
  directives,
  instructions,
  instructionSemanticTokenType,
  instructionTypeLabel,
  isRegister,
  mipsSemanticTokenTypes,
  MipsSemanticTokenType,
  numericRegisters,
  registerDescriptions,
  registerNames
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

export function getMipsDiagnostics(document: TextDocument, settings: CoSettings, state: MipsServerState): Diagnostic[] {
  return parseMips(document, settings, {
    ignoredPseudoInstructionFiles: state.ignoredPseudoInstructionFiles,
    ignoredPseudoInstructionMnemonics: state.ignoredPseudoInstructionMnemonics
  }).diagnostics;
}

export function getMipsCompletions(document: TextDocument, position: Position, settings: CoSettings, state: MipsServerState): CompletionItem[] {
  const parsed = parseMips(document, settings, {
    includeDiagnostics: false,
    ignoredPseudoInstructionFiles: state.ignoredPseudoInstructionFiles,
    ignoredPseudoInstructionMnemonics: state.ignoredPseudoInstructionMnemonics
  });
  const linePrefix = lineAt(document, position.line).text.slice(0, position.character);
  const items: CompletionItem[] = [];
  const directiveReplaceRange = directiveCompletionReplaceRange(linePrefix, position);

  if (/\$[\w]*$/.test(linePrefix)) {
    for (const name of [...registerNames, ...numericRegisters()]) {
      items.push({
        label: name,
        kind: CompletionItemKind.Variable,
        detail: registerDescriptions.get(name) ?? 'MIPS register'
      });
    }
    return items;
  }

  if (/%[\w]*$/.test(linePrefix)) {
    for (const symbol of findMacroAtPosition(parsed, position)?.paramSymbols.values() ?? []) {
      items.push({
        label: symbol.name,
        kind: CompletionItemKind.Variable,
        detail: 'Macro parameter'
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
    }
    items.push(item);
  }

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

export function getMipsHover(document: TextDocument, position: Position, settings: CoSettings, state: MipsServerState): Hover | undefined {
  const wordRange = getMipsWordRange(document, position);
  if (!wordRange) {
    return undefined;
  }
  const word = document.getText(wordRange);
  const parsed = parseMips(document, settings, {
    includeDiagnostics: false,
    ignoredPseudoInstructionFiles: state.ignoredPseudoInstructionFiles,
    ignoredPseudoInstructionMnemonics: state.ignoredPseudoInstructionMnemonics
  });
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
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: details.join('\n')
      },
      range: wordRange
    };
  }

  if (isRegister(word)) {
    const canonical = canonicalRegister(word);
    return {
      contents: registerDescriptions.get(canonical) ?? `MIPS register ${word}`,
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
    return {
      contents: `${kind} defined on line ${symbol.range.start.line + 1}.`,
      range: wordRange
    };
  }

  const macro = findMacroOverloadAtPosition(document, parsed, word, position);
  if (macro) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**Macro** \`${macro.name}(${macro.params.join(', ')})\`\n\n\`\`\`mipsasm\n${macroBody(document, macro.bodyStartLine, macro.bodyEndLine)}\n\`\`\``
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
  const parsed = parseMips(document, settings, {
    includeDiagnostics: false,
    ignoredPseudoInstructionFiles: state.ignoredPseudoInstructionFiles,
    ignoredPseudoInstructionMnemonics: state.ignoredPseudoInstructionMnemonics
  });
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
  const parsed = parseMips(document, settings, {
    includeDiagnostics: false,
    ignoredPseudoInstructionFiles: state.ignoredPseudoInstructionFiles,
    ignoredPseudoInstructionMnemonics: state.ignoredPseudoInstructionMnemonics
  });

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
  const parsed = parseMips(document, settings, {
    includeDiagnostics: false,
    ignoredPseudoInstructionFiles: state.ignoredPseudoInstructionFiles,
    ignoredPseudoInstructionMnemonics: state.ignoredPseudoInstructionMnemonics
  });
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

export function getMipsSemanticTokens(document: TextDocument, settings: CoSettings, state: MipsServerState): SemanticTokens {
  const parsed = parseMips(document, settings, {
    includeDiagnostics: false,
    ignoredPseudoInstructionFiles: state.ignoredPseudoInstructionFiles,
    ignoredPseudoInstructionMnemonics: state.ignoredPseudoInstructionMnemonics
  });
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

      if (token.startsWith('$') && isRegister(token)) {
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

  const callArity = macroCallArityAtPosition(document, name, position);
  if (callArity !== undefined) {
    return overloads.find((macro) => macro.params.length === callArity) ?? overloads[0];
  }

  return overloads[0];
}

function macroCallArityAtPosition(document: TextDocument, name: string, position: Position): number | undefined {
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
  return parseMacroArguments(trimmed.slice(firstToken[0].length).trim()).length;
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

function isKnownDeclarationRange(range: Range, parsed: ReturnType<typeof parseMips>): boolean {
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
