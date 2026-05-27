import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  config,
  getJava,
  getMachineCode,
  getMarsJar,
  getMemoryConfiguration,
  getProfile,
  useDelayedBranching
} from './config';
import { basenameNoExt, dirname, ensureDirectory, writeTextFile } from './fsUtil';
import { runTool } from './process';
import { AppServices, ProjectProfile } from './types';

interface MipsInstruction {
  mnemonic: string;
  summary: string;
  type: MipsInstructionType;
  formats: string[];
  operands: [number, number];
  description: string;
  pseudo?: boolean;
  projects?: ProjectProfile[];
  labelOperand?: 'first' | 'second' | 'last';
  delaySlot?: boolean;
}

type MipsInstructionType = 'R-type' | 'I-type' | 'J-type' | 'special' | 'pseudo';

interface MipsSymbol {
  name: string;
  kind: 'label' | 'data' | 'eqv' | 'macro' | 'macroParam';
  range: vscode.Range;
  selectionRange: vscode.Range;
  detail?: string;
  macroName?: string;
}

interface MipsMacro {
  name: string;
  params: string[];
  paramSymbols: Map<string, MipsSymbol>;
  labels: Map<string, MipsSymbol>;
  dataSymbols: Map<string, MipsSymbol>;
  eqvSymbols: Map<string, MipsSymbol>;
  range: vscode.Range;
  selectionRange: vscode.Range;
  bodyStartLine: number;
  bodyEndLine?: number;
}

interface MipsLine {
  line: number;
  mnemonic: string;
  operands: string[];
  range: vscode.Range;
}

interface MipsLabelReference {
  line: number;
  operand: string;
  macro?: MipsMacro;
}

interface MipsParseResult {
  labels: Map<string, MipsSymbol>;
  dataSymbols: Map<string, MipsSymbol>;
  eqvSymbols: Map<string, MipsSymbol>;
  macros: Map<string, MipsMacro>;
  instructions: MipsLine[];
  diagnostics: vscode.Diagnostic[];
}

interface MipsSymbolScope {
  labels: Map<string, MipsSymbol>;
  dataSymbols: Map<string, MipsSymbol>;
  eqvSymbols: Map<string, MipsSymbol>;
}

interface MipsRegisterInfo {
  number: number;
  names: string[];
  usage: string;
}

const sessionIgnoredPseudoInstructionFiles = new Set<string>();
const sessionIgnoredPseudoInstructionMnemonics = new Set<string>();

interface MipsResourceData {
  registers: MipsRegisterInfo[];
  directives: string[];
  instructions: MipsInstruction[];
}

const mipsResourceData = loadMipsResourceData();
const registerInfos = mipsResourceData.registers;
const registerNames = new Set(registerInfos.flatMap((info) => info.names.map((name) => name.toLowerCase())));
const registerByNumber = new Map(registerInfos.map((info) => [info.number, info]));
const registerAliases = new Map(registerInfos.flatMap((info) => info.names.map((name) => [name.toLowerCase(), info.names[0].toLowerCase()] as const)));
const registerDescriptions = new Map<string, string>();
for (const info of registerInfos) {
  const names = info.names.join(' / ');
  const description = '$' + info.number + ' (' + names + '): ' + info.usage;
  registerDescriptions.set('$' + info.number, description);
  for (const name of info.names) {
    registerDescriptions.set(name.toLowerCase(), description);
  }
}

const directives = new Set(mipsResourceData.directives);
const instructions: Record<string, MipsInstruction> = makeInstructionMap(mipsResourceData.instructions);
const mipsSemanticTokenTypes = [
  'mipsDirective',
  'mipsInstruction',
  'mipsRealInstruction',
  'mipsRInstruction',
  'mipsIInstruction',
  'mipsJInstruction',
  'mipsSpecialInstruction',
  'mipsPseudoInstruction',
  'mipsRegister',
  'mipsMacro',
  'mipsMacroParameter',
  'mipsLabel',
  'mipsDataSymbol',
  'mipsEqvSymbol',
  'mipsNumber',
  'mipsString',
  'mipsComment',
  'mipsPunctuation'
] as const;

type MipsSemanticTokenType = typeof mipsSemanticTokenTypes[number];
type MipsInstructionColorMode = 'realVsPseudo' | 'same' | 'byType';

interface MipsSemanticTokenCandidate {
  range: vscode.Range;
  tokenType: MipsSemanticTokenType;
  modifiers?: string[];
}

const mipsSemanticTokenLegend = new vscode.SemanticTokensLegend([...mipsSemanticTokenTypes], ['declaration']);

export function registerMips(context: vscode.ExtensionContext, services: AppServices): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('buaa-co-mips');
  context.subscriptions.push(diagnostics);

  const refresh = (document: vscode.TextDocument): void => {
    if (document.languageId === 'mipsasm') {
      diagnostics.set(document.uri, parseMips(document).diagnostics);
    }
  };

  const refreshAll = (): void => {
    for (const document of vscode.workspace.textDocuments) {
      refresh(document);
    }
  };

  for (const document of vscode.workspace.textDocuments) {
    refresh(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((event) => refresh(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
    vscode.languages.registerCompletionItemProvider({ language: 'mipsasm' }, new MipsCompletionProvider(), '$', '.', '%'),
    vscode.languages.registerHoverProvider({ language: 'mipsasm' }, new MipsHoverProvider()),
    vscode.languages.registerDefinitionProvider({ language: 'mipsasm' }, new MipsDefinitionProvider()),
    vscode.languages.registerDocumentSymbolProvider({ language: 'mipsasm' }, new MipsDocumentSymbolProvider()),
    vscode.languages.registerDocumentFormattingEditProvider({ language: 'mipsasm' }, new MipsFormatter()),
    (() => {
      const semanticTokensProvider = new MipsSemanticTokensProvider();
      return vscode.Disposable.from(
        semanticTokensProvider,
        vscode.languages.registerDocumentSemanticTokensProvider({ language: 'mipsasm' }, semanticTokensProvider, mipsSemanticTokenLegend),
        vscode.workspace.onDidChangeConfiguration((event) => {
          if (event.affectsConfiguration('co.mips.instructionColorMode')) {
            semanticTokensProvider.refresh();
          }
        })
      );
    })(),
    vscode.languages.registerCodeActionsProvider({ language: 'mipsasm' }, new MipsCodeActionProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    }),
    vscode.commands.registerCommand('co.mips.ignorePseudoWarningsForFile', (uri: vscode.Uri) => {
      sessionIgnoredPseudoInstructionFiles.add(uri.toString());
      refreshAll();
    }),
    vscode.commands.registerCommand('co.mips.ignorePseudoWarningsForMnemonic', (mnemonic: string) => {
      sessionIgnoredPseudoInstructionMnemonics.add(mnemonic.toLowerCase());
      refreshAll();
    }),
    vscode.commands.registerCommand('co.mips.disablePseudoWarnings', async () => {
      await vscode.workspace.getConfiguration('co').update('mips.warnPseudoInstruction', false, vscode.ConfigurationTarget.Workspace);
      refreshAll();
    }),
    vscode.commands.registerCommand('co.mips.runCurrentFile', () => runMarsCurrentFile(services, 'run')),
    vscode.commands.registerCommand('co.mips.dumpText', () => runMarsCurrentFile(services, 'dumpText')),
    vscode.commands.registerCommand('co.mips.dumpKernelText', () => runMarsCurrentFile(services, 'dumpKernel'))
  );
}

class MipsCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const parsed = parseMips(document);
    const linePrefix = document.lineAt(position).text.slice(0, position.character);
    const items: vscode.CompletionItem[] = [];

    if (/\$[\w]*$/.test(linePrefix)) {
      for (const name of [...registerNames, ...numericRegisters()]) {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
        item.detail = registerDescriptions.get(name) ?? 'MIPS register';
        items.push(item);
      }
      return items;
    }

    if (/%[\w]*$/.test(linePrefix)) {
      for (const symbol of findMacroAtPosition(parsed, position)?.paramSymbols.values() ?? []) {
        const item = new vscode.CompletionItem(symbol.name, vscode.CompletionItemKind.Variable);
        item.detail = 'Macro parameter';
        items.push(item);
      }
      return items;
    }

    for (const instruction of Object.values(instructions)) {
      const item = new vscode.CompletionItem(instruction.mnemonic, vscode.CompletionItemKind.Keyword);
      item.detail = `${instructionTypeLabel(instruction.type)} - ${instruction.summary}`;
      item.documentation = new vscode.MarkdownString(instruction.formats.join('\n\n'));
      item.insertText = instruction.mnemonic;
      items.push(item);
    }

    for (const directive of directives) {
      items.push(new vscode.CompletionItem(directive, vscode.CompletionItemKind.Keyword));
    }

    for (const symbol of symbolsVisibleAtPosition(parsed, position)) {
      const item = new vscode.CompletionItem(symbol.name, vscode.CompletionItemKind.Reference);
      item.detail = symbol.kind === 'data' ? 'Data symbol' : symbol.kind === 'eqv' ? '.eqv symbol' : 'Label';
      items.push(item);
    }

    for (const macro of parsed.macros.values()) {
      const item = new vscode.CompletionItem(macro.name, vscode.CompletionItemKind.Function);
      item.detail = `Macro(${macro.params.join(', ')})`;
      item.insertText = `${macro.name}(${macro.params.map((param, index) => `\${${index + 1}:${param}}`).join(', ')})`;
      item.insertText = new vscode.SnippetString(item.insertText as string);
      items.push(item);
    }

    return items;
  }
}

class MipsHoverProvider implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const wordRange = getMipsWordRange(document, position);
    if (!wordRange) {
      return undefined;
    }
    const word = document.getText(wordRange);
    const parsed = parseMips(document);
    const instruction = instructions[word.toLowerCase()];
    if (instruction) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${instruction.mnemonic}** - ${instruction.summary}\n\n`);
      md.appendMarkdown(`Type: **${instructionTypeLabel(instruction.type)}**\n\n`);
      md.appendCodeblock(instruction.formats.join('\n'), 'mipsasm');
      md.appendMarkdown(`\n${instruction.description}`);
      if (instruction.pseudo) {
        md.appendMarkdown('\n\nPseudo instruction. Check generated code before using it in restricted projects.');
      }
      if (instruction.delaySlot) {
        md.appendMarkdown('\n\nControl-transfer instruction. Delay-slot behavior depends on the current project/profile.');
      }
      return new vscode.Hover(md, wordRange);
    }

    if (isRegister(word)) {
      const canonical = canonicalRegister(word);
      return new vscode.Hover(registerDescriptions.get(canonical) ?? `MIPS register ${word}`, wordRange);
    }

    const param = findMacroParamAtPosition(parsed, word, position);
    if (param) {
      return new vscode.Hover(`Macro parameter defined on line ${param.range.start.line + 1}.`, wordRange);
    }

    const symbol = resolveSymbolAtPosition(parsed, word, position);
    if (symbol) {
      const kind = symbol.kind === 'data' ? 'Data symbol' : symbol.kind === 'eqv' ? '.eqv symbol' : 'Label';
      return new vscode.Hover(`${kind} defined on line ${symbol.range.start.line + 1}.`, wordRange);
    }

    const macro = parsed.macros.get(word);
    if (macro) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**Macro** \`${macro.name}(${macro.params.join(', ')})\`\n\n`);
      md.appendCodeblock(macroBody(document, macro), 'mipsasm');
      return new vscode.Hover(md, wordRange);
    }

    return undefined;
  }
}

class MipsDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | undefined {
    const wordRange = getMipsWordRange(document, position);
    if (!wordRange) {
      return undefined;
    }
    const word = document.getText(wordRange);
    const parsed = parseMips(document);
    const param = findMacroParamAtPosition(parsed, word, position);
    if (param) {
      return new vscode.Location(document.uri, param.selectionRange);
    }
    const symbol = resolveSymbolAtPosition(parsed, word, position);
    if (symbol) {
      return new vscode.Location(document.uri, symbol.selectionRange);
    }
    const macro = parsed.macros.get(word);
    if (macro) {
      return new vscode.Location(document.uri, macro.selectionRange);
    }
    return undefined;
  }
}

class MipsCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const pseudoDiagnostic = context.diagnostics.find((diagnostic) => typeof diagnostic.code === 'string' && diagnostic.code.startsWith('pseudo-instruction:'));
    if (!pseudoDiagnostic || typeof pseudoDiagnostic.code !== 'string') {
      return [];
    }

    const mnemonic = pseudoDiagnostic.code.slice('pseudo-instruction:'.length);
    const actions: vscode.CodeAction[] = [];

    const ignoreMnemonic = new vscode.CodeAction(`Ignore '${mnemonic}' pseudo-instruction warnings until reload`, vscode.CodeActionKind.QuickFix);
    ignoreMnemonic.command = {
      command: 'co.mips.ignorePseudoWarningsForMnemonic',
      title: `Ignore ${mnemonic}`,
      arguments: [mnemonic]
    };
    actions.push(ignoreMnemonic);

    const ignoreFile = new vscode.CodeAction('Ignore pseudo-instruction warnings in this file until reload', vscode.CodeActionKind.QuickFix);
    ignoreFile.command = {
      command: 'co.mips.ignorePseudoWarningsForFile',
      title: 'Ignore pseudo warnings for file',
      arguments: [document.uri]
    };
    actions.push(ignoreFile);

    const disableWorkspace = new vscode.CodeAction('Disable pseudo-instruction warnings in this workspace', vscode.CodeActionKind.QuickFix);
    disableWorkspace.command = {
      command: 'co.mips.disablePseudoWarnings',
      title: 'Disable pseudo warnings'
    };
    actions.push(disableWorkspace);

    return actions;
  }
}

class MipsSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeSemanticTokens = this.onDidChangeEmitter.event;

  refresh(): void {
    this.onDidChangeEmitter.fire();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
    const parsed = parseMips(document);
    const tokens: MipsSemanticTokenCandidate[] = [];
    const builder = new vscode.SemanticTokensBuilder(mipsSemanticTokenLegend);

    for (const macro of parsed.macros.values()) {
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
    const numberRegex = /[-+]?(?:0x[0-9A-Fa-f]+|\b\d+\b)/g;
    const punctuationRegex = /[(),:]/g;
    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
      const text = document.lineAt(lineNumber).text;
      const commentIndex = findCommentIndex(text);
      if (commentIndex >= 0) {
        pushSemanticToken(tokens, new vscode.Range(lineNumber, commentIndex, lineNumber, text.length), 'mipsComment');
      }
      const code = commentIndex >= 0 ? text.slice(0, commentIndex) : text;
      const stringRanges = getStringRanges(code);
      for (const stringRange of stringRanges) {
        pushSemanticToken(tokens, new vscode.Range(lineNumber, stringRange.start, lineNumber, stringRange.end), 'mipsString');
      }

      let numberMatch: RegExpExecArray | null;
      while ((numberMatch = numberRegex.exec(code))) {
        const previous = numberMatch.index > 0 ? code[numberMatch.index - 1] : '';
        if (!isInsideAnyRange(numberMatch.index, stringRanges) && previous !== '$') {
          pushSemanticToken(tokens, new vscode.Range(lineNumber, numberMatch.index, lineNumber, numberMatch.index + numberMatch[0].length), 'mipsNumber');
        }
      }

      let punctuationMatch: RegExpExecArray | null;
      while ((punctuationMatch = punctuationRegex.exec(code))) {
        if (!isInsideAnyRange(punctuationMatch.index, stringRanges)) {
          pushSemanticToken(tokens, new vscode.Range(lineNumber, punctuationMatch.index, lineNumber, punctuationMatch.index + punctuationMatch[0].length), 'mipsPunctuation');
        }
      }

      let match: RegExpExecArray | null;
      while ((match = tokenRegex.exec(code))) {
        const token = match[0];
        const previous = match.index > 0 ? code[match.index - 1] : '';
        if (previous === '$' || isInsideAnyRange(match.index, stringRanges)) {
          continue;
        }

        const range = new vscode.Range(lineNumber, match.index, lineNumber, match.index + token.length);
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
          pushSemanticToken(tokens, range, instructionSemanticTokenType(instructions[token.toLowerCase()], document.uri));
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
      builder.push(token.range, token.tokenType, token.modifiers);
    }
    return builder.build();
  }
}

class MipsDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const parsed = parseMips(document);
    const symbols: vscode.DocumentSymbol[] = [];
    for (const symbol of allSymbols(parsed)) {
      const kind = symbol.kind === 'data' || symbol.kind === 'eqv' ? vscode.SymbolKind.Variable : vscode.SymbolKind.Function;
      symbols.push(new vscode.DocumentSymbol(symbol.name, symbol.kind, kind, symbol.range, symbol.selectionRange));
    }
    for (const macro of parsed.macros.values()) {
      symbols.push(new vscode.DocumentSymbol(macro.name, `macro(${macro.params.join(', ')})`, vscode.SymbolKind.Function, macro.range, macro.selectionRange));
    }
    return symbols.sort((a, b) => a.range.start.line - b.range.start.line);
  }
}

class MipsFormatter implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
    const edits: vscode.TextEdit[] = [];
    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
      const line = document.lineAt(lineNumber);
      const formatted = formatMipsLine(line.text);
      if (formatted !== line.text) {
        edits.push(vscode.TextEdit.replace(line.range, formatted));
      }
    }
    return edits;
  }
}

export function parseMips(document: vscode.TextDocument): MipsParseResult {
  const labels = new Map<string, MipsSymbol>();
  const dataSymbols = new Map<string, MipsSymbol>();
  const eqvSymbols = new Map<string, MipsSymbol>();
  const macros = new Map<string, MipsMacro>();
  const instructionsSeen: MipsLine[] = [];
  const labelReferences: MipsLabelReference[] = [];
  const diagnostics: vscode.Diagnostic[] = [];
  const profile = getProfile(document.uri);
  let section: 'text' | 'data' | 'other' = 'text';
  let sectionBeforeMacro: 'text' | 'data' | 'other' | undefined;
  let activeMacro: MipsMacro | undefined;
  let hasSyscall = false;

  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const original = document.lineAt(lineNumber).text;
    let code = stripComment(original);
    let scanOffset = 0;

    while (true) {
      const labelMatch = code.match(/^\s*([A-Za-z_.$][\w.$]*):/);
      if (!labelMatch) {
        break;
      }
      const name = labelMatch[1];
      const start = original.indexOf(name, scanOffset);
      const selectionRange = new vscode.Range(lineNumber, start, lineNumber, start + name.length);
      const symbol: MipsSymbol = {
        name,
        kind: section === 'data' ? 'data' : 'label',
        range: document.lineAt(lineNumber).range,
        selectionRange,
        macroName: activeMacro?.name
      };
      const scope = symbolScope(activeMacro, labels, dataSymbols, eqvSymbols);
      const targetMap = section === 'data' ? scope.dataSymbols : scope.labels;
      if (symbolScopeHas(scope, name)) {
        diagnostics.push(makeDiagnostic(selectionRange, `Duplicate symbol '${name}'.`, vscode.DiagnosticSeverity.Error, 'duplicate-symbol'));
      } else {
        targetMap.set(name, symbol);
      }
      const consumed = labelMatch[0].length;
      code = code.slice(consumed);
      scanOffset += consumed;
    }

    const trimmed = code.trim();
    if (!trimmed) {
      continue;
    }

    const eqvMatch = trimmed.match(/^\.eqv\s+([A-Za-z_.$][\w.$]*)/);
    if (eqvMatch) {
      const name = eqvMatch[1];
      const start = original.indexOf(name);
      const selectionRange = new vscode.Range(lineNumber, start, lineNumber, start + name.length);
      const symbol: MipsSymbol = {
        name,
        kind: 'eqv',
        range: document.lineAt(lineNumber).range,
        selectionRange,
        macroName: activeMacro?.name
      };
      const scope = symbolScope(activeMacro, labels, dataSymbols, eqvSymbols);
      if (symbolScopeHas(scope, name)) {
        diagnostics.push(makeDiagnostic(selectionRange, `Duplicate symbol '${name}'.`, vscode.DiagnosticSeverity.Error, 'duplicate-symbol'));
      } else {
        scope.eqvSymbols.set(name, symbol);
      }
    }

    if (trimmed.startsWith('.data')) {
      section = 'data';
    } else if (trimmed.startsWith('.text') || trimmed.startsWith('.ktext')) {
      section = 'text';
    } else if (trimmed.startsWith('.kdata')) {
      section = 'data';
    }

    const macroStart = trimmed.match(/^\.macro\s+([A-Za-z_.$][\w.$]*)(.*)$/);
    if (macroStart) {
      const name = macroStart[1];
      const nameStart = original.indexOf(name);
      const params = macroStart[2]
        .trim()
        .replace(/^\(/, '')
        .replace(/\)$/, '')
        .split(/[,\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => (item.startsWith('%') ? item : `%${item}`));
      const selectionRange = new vscode.Range(lineNumber, nameStart, lineNumber, nameStart + name.length);
      const macro: MipsMacro = {
        name,
        params,
        paramSymbols: new Map(),
        labels: new Map(),
        dataSymbols: new Map(),
        eqvSymbols: new Map(),
        range: document.lineAt(lineNumber).range,
        selectionRange,
        bodyStartLine: lineNumber + 1
      };
      if (activeMacro) {
        diagnostics.push(makeDiagnostic(selectionRange, `Nested macro '${name}' is not supported by this language service.`, vscode.DiagnosticSeverity.Warning, 'nested-macro'));
      }
      if (macros.has(name)) {
        diagnostics.push(makeDiagnostic(selectionRange, `Duplicate macro '${name}'.`, vscode.DiagnosticSeverity.Error, 'duplicate-macro'));
      } else {
        macros.set(name, macro);
      }
      sectionBeforeMacro = section;
      activeMacro = macro;
      for (const param of params) {
        const paramIndex = original.indexOf(param);
        if (paramIndex >= 0) {
          if (macro.paramSymbols.has(param)) {
            diagnostics.push(makeDiagnostic(new vscode.Range(lineNumber, paramIndex, lineNumber, paramIndex + param.length), `Duplicate macro parameter '${param}'.`, vscode.DiagnosticSeverity.Error, 'duplicate-macro-parameter'));
            continue;
          }
          macro.paramSymbols.set(param, {
            name: param,
            kind: 'macroParam',
            range: document.lineAt(lineNumber).range,
            selectionRange: new vscode.Range(lineNumber, paramIndex, lineNumber, paramIndex + param.length),
            macroName: macro.name
          });
        }
      }
      continue;
    }

    if (trimmed.startsWith('.end_macro')) {
      if (!activeMacro) {
        diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, '.end_macro'), 'Unexpected .end_macro without a matching .macro.', vscode.DiagnosticSeverity.Error, 'macro-end'));
      } else {
        activeMacro.bodyEndLine = lineNumber - 1;
        activeMacro.range = new vscode.Range(activeMacro.range.start, document.lineAt(lineNumber).range.end);
        activeMacro = undefined;
        section = sectionBeforeMacro ?? section;
        sectionBeforeMacro = undefined;
      }
      continue;
    }

    validateRegisters(document, lineNumber, original, diagnostics);

    const firstToken = trimmed.match(/^([A-Za-z_.$][\w.$]*|\.[A-Za-z_][\w.]*)/);
    if (!firstToken) {
      continue;
    }
    const mnemonic = firstToken[1].toLowerCase();
    if (mnemonic.startsWith('.')) {
      if (!directives.has(mnemonic)) {
        diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, firstToken[1]), `Unknown directive '${firstToken[1]}'.`, vscode.DiagnosticSeverity.Warning, 'unknown-directive'));
      }
      continue;
    }

    const instruction = instructions[mnemonic];
    const macro = macros.get(firstToken[1]);
    if (!instruction && !macro) {
      diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, firstToken[1]), `Unknown instruction or macro '${firstToken[1]}'.`, vscode.DiagnosticSeverity.Warning, 'unknown-instruction'));
      continue;
    }

    if (instruction) {
      if (mnemonic === 'syscall') {
        hasSyscall = true;
      }
      const operandText = trimmed.slice(firstToken[0].length).trim();
      const operands = parseOperands(operandText);
      instructionsSeen.push({
        line: lineNumber,
        mnemonic,
        operands,
        range: rangeOfText(document, lineNumber, firstToken[1])
      });
      validateInstruction(document, lineNumber, instruction, operands, profile, diagnostics);
      const labelRef = labelOperand(instruction, operands);
      if (labelRef && isSymbolLike(labelRef)) {
        labelReferences.push({
          line: lineNumber,
          operand: labelRef,
          macro: activeMacro
        });
      }
    }
  }

  if (activeMacro) {
    activeMacro.range = new vscode.Range(activeMacro.range.start, document.lineAt(document.lineCount - 1).range.end);
    diagnostics.push(makeDiagnostic(activeMacro.selectionRange, `Macro '${activeMacro.name}' is missing .end_macro.`, vscode.DiagnosticSeverity.Error, 'macro-unclosed'));
  }

  for (const reference of labelReferences) {
    if (!resolveReferenceSymbol(reference.operand, reference.macro, labels, dataSymbols)) {
      diagnostics.push(makeDiagnostic(rangeOfText(document, reference.line, reference.operand), `Cannot find label or data symbol '${reference.operand}'.`, vscode.DiagnosticSeverity.Error, 'missing-label'));
    }
  }

  if (profile === 'P2' && config<boolean>('mips.warnMissingExitSyscall', true, document.uri) && !hasSyscall && document.lineCount > 2) {
    const range = new vscode.Range(0, 0, 0, Math.max(1, document.lineAt(0).text.length));
    diagnostics.push(makeDiagnostic(range, 'P2 programs usually need a syscall exit path, otherwise MARS/online tests may time out.', vscode.DiagnosticSeverity.Warning, 'missing-syscall'));
  }

  return {
    labels,
    dataSymbols,
    eqvSymbols,
    macros,
    instructions: instructionsSeen,
    diagnostics
  };
}

async function runMarsCurrentFile(services: AppServices, mode: 'run' | 'dumpText' | 'dumpKernel'): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'mipsasm') {
    vscode.window.showErrorMessage('Open a MIPS ASM file first.');
    return;
  }
  const document = editor.document;
  if (document.isUntitled) {
    vscode.window.showErrorMessage('Save the ASM file before running MARS.');
    return;
  }
  if (document.isDirty) {
    await document.save();
  }

  const mars = getMarsJar(document.uri);
  if (!mars) {
    vscode.window.showErrorMessage('MARS jar is not configured. Set co.toolchain.mars or co.toolchain.marsP7.');
    return;
  }

  services.output.show(true);
  const java = getJava(document.uri);
  const cwd = dirname(document.uri);
  const asm = document.uri.fsPath;
  const args = ['-jar', mars, 'nc', 'mc', getMemoryConfiguration(document.uri)];
  if (useDelayedBranching(document.uri)) {
    args.push('db');
  }

  if (mode === 'dumpText') {
    args.push('a', 'dump', '.text', 'HexText', path.join(cwd, getMachineCode(document.uri)), asm);
  } else if (mode === 'dumpKernel') {
    args.push('a', 'dump', '0x00004180-0x00004ffc', 'HexText', path.join(cwd, `${basenameNoExt(document.uri)}.kernel.txt`), asm);
  } else {
    args.push(asm);
  }

  const result = await runTool(java, args, {
    cwd,
    output: services.output,
    resource: document.uri
  });

  if (mode === 'run') {
    const outDir = vscode.Uri.file(path.join(cwd, '.co', 'out'));
    await ensureDirectory(outDir);
    const outFile = vscode.Uri.file(path.join(outDir.fsPath, `${basenameNoExt(document.uri)}.mars.out`));
    await writeTextFile(outFile, result.stdout);
  }

  if (result.ok) {
    if (mode === 'dumpText') {
      vscode.window.showInformationMessage(`MARS dumped ${getMachineCode(document.uri)}.`);
    } else if (mode === 'dumpKernel') {
      vscode.window.showInformationMessage('MARS dumped kernel text segment.');
    } else {
      vscode.window.showInformationMessage('MARS run completed.');
    }
  } else {
    vscode.window.showErrorMessage(`MARS failed${result.exitCode === null ? '' : ` with exit code ${result.exitCode}`}.`);
  }
}

function validateInstruction(
  document: vscode.TextDocument,
  lineNumber: number,
  instruction: MipsInstruction,
  operands: string[],
  profile: ProjectProfile,
  diagnostics: vscode.Diagnostic[]
): void {
  const [min, max] = instruction.operands;
  if (operands.length < min || operands.length > max) {
    diagnostics.push(
      makeDiagnostic(
        rangeOfText(document, lineNumber, instruction.mnemonic),
        `${instruction.mnemonic} expects ${min === max ? min : `${min}-${max}`} operand(s), got ${operands.length}.`,
        vscode.DiagnosticSeverity.Error,
        'operand-count'
      )
    );
  }

  if (instruction.pseudo && shouldWarnPseudoInstruction(document, instruction.mnemonic)) {
    diagnostics.push(
      makeDiagnostic(
        rangeOfText(document, lineNumber, instruction.mnemonic),
        `${instruction.mnemonic} is a pseudo instruction. Verify expansion when generating CPU tests.`,
        vscode.DiagnosticSeverity.Information,
        `pseudo-instruction:${instruction.mnemonic}`
      )
    );
  }

  if (profile !== 'auto' && instruction.projects && !instruction.projects.includes(profile)) {
    diagnostics.push(
      makeDiagnostic(
        rangeOfText(document, lineNumber, instruction.mnemonic),
        `${instruction.mnemonic} is normally used in ${instruction.projects.join('/')} profile(s), not ${profile}.`,
        vscode.DiagnosticSeverity.Warning,
        'project-instruction'
      )
    );
  }
}

function validateRegisters(document: vscode.TextDocument, lineNumber: number, line: string, diagnostics: vscode.Diagnostic[]): void {
  const code = stripComment(line);
  const regex = /\$[A-Za-z0-9_]+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code))) {
    const reg = match[0];
    if (!isRegister(reg)) {
      diagnostics.push(makeDiagnostic(new vscode.Range(lineNumber, match.index, lineNumber, match.index + reg.length), `Unknown register '${reg}'.`, vscode.DiagnosticSeverity.Error, 'unknown-register'));
    }
  }
}

function stripComment(line: string): string {
  let inString = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && line[index - 1] !== '\\') {
      inString = !inString;
    }
    if (char === '#' && !inString) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseOperands(text: string): string[] {
  if (!text) {
    return [];
  }
  const normalized = text.trim().replace(/^\(/, '').replace(/\)$/, '');
  if (!normalized) {
    return [];
  }
  return normalized
    .split(',')
    .map((operand) => operand.trim())
    .filter(Boolean);
}

function labelOperand(instruction: MipsInstruction, operands: string[]): string | undefined {
  if (instruction.labelOperand === 'first') {
    return operands[0];
  }
  if (instruction.labelOperand === 'second') {
    return operands[1];
  }
  if (instruction.labelOperand === 'last') {
    return operands[operands.length - 1];
  }
  return undefined;
}

function isSymbolLike(value: string): boolean {
  return /^[A-Za-z_.$][\w.$]*$/.test(value);
}

function isRegister(value: string): boolean {
  const canonical = canonicalRegister(value);
  return registerNames.has(canonical) || /^\$(?:[0-9]|[12][0-9]|3[01])$/.test(value);
}

function canonicalRegister(value: string): string {
  if (/^\$(?:[0-9]|[12][0-9]|3[01])$/.test(value)) {
    const number = Number(value.slice(1));
    return registerByNumber.get(number)?.names[0].toLowerCase() ?? value;
  }
  const lower = value.toLowerCase();
  return registerAliases.get(lower) ?? lower;
}

function shouldWarnPseudoInstruction(document: vscode.TextDocument, mnemonic: string): boolean {
  return (
    config<boolean>('mips.warnPseudoInstruction', true, document.uri) &&
    !sessionIgnoredPseudoInstructionFiles.has(document.uri.toString()) &&
    !sessionIgnoredPseudoInstructionMnemonics.has(mnemonic.toLowerCase())
  );
}

function symbolScope(
  macro: MipsMacro | undefined,
  labels: Map<string, MipsSymbol>,
  dataSymbols: Map<string, MipsSymbol>,
  eqvSymbols: Map<string, MipsSymbol>
): MipsSymbolScope {
  if (macro) {
    return {
      labels: macro.labels,
      dataSymbols: macro.dataSymbols,
      eqvSymbols: macro.eqvSymbols
    };
  }
  return {
    labels,
    dataSymbols,
    eqvSymbols
  };
}

function symbolScopeHas(scope: MipsSymbolScope, name: string): boolean {
  return scope.labels.has(name) || scope.dataSymbols.has(name) || scope.eqvSymbols.has(name);
}

function findMacroAtPosition(parsed: MipsParseResult, position: vscode.Position): MipsMacro | undefined {
  for (const macro of parsed.macros.values()) {
    if (macro.range.contains(position)) {
      return macro;
    }
  }
  return undefined;
}

function findMacroParamAtPosition(parsed: MipsParseResult, name: string, position: vscode.Position): MipsSymbol | undefined {
  return findMacroAtPosition(parsed, position)?.paramSymbols.get(name);
}

function resolveSymbolAtPosition(parsed: MipsParseResult, name: string, position: vscode.Position): MipsSymbol | undefined {
  return resolveLabelAtPosition(parsed, name, position) ?? resolveDataSymbolAtPosition(parsed, name, position) ?? resolveEqvSymbolAtPosition(parsed, name, position);
}

function resolveLabelAtPosition(parsed: MipsParseResult, name: string, position: vscode.Position): MipsSymbol | undefined {
  return findMacroAtPosition(parsed, position)?.labels.get(name) ?? parsed.labels.get(name);
}

function resolveDataSymbolAtPosition(parsed: MipsParseResult, name: string, position: vscode.Position): MipsSymbol | undefined {
  return findMacroAtPosition(parsed, position)?.dataSymbols.get(name) ?? parsed.dataSymbols.get(name);
}

function resolveEqvSymbolAtPosition(parsed: MipsParseResult, name: string, position: vscode.Position): MipsSymbol | undefined {
  return findMacroAtPosition(parsed, position)?.eqvSymbols.get(name) ?? parsed.eqvSymbols.get(name);
}

function resolveReferenceSymbol(
  name: string,
  macro: MipsMacro | undefined,
  labels: Map<string, MipsSymbol>,
  dataSymbols: Map<string, MipsSymbol>
): MipsSymbol | undefined {
  return macro?.labels.get(name) ?? macro?.dataSymbols.get(name) ?? labels.get(name) ?? dataSymbols.get(name);
}

function symbolsVisibleAtPosition(parsed: MipsParseResult, position: vscode.Position): MipsSymbol[] {
  const macro = findMacroAtPosition(parsed, position);
  return [
    ...(macro ? [...macro.labels.values(), ...macro.dataSymbols.values(), ...macro.eqvSymbols.values()] : []),
    ...parsed.labels.values(),
    ...parsed.dataSymbols.values(),
    ...parsed.eqvSymbols.values()
  ];
}

function allMacroParams(parsed: MipsParseResult): MipsSymbol[] {
  return [...parsed.macros.values()].flatMap((macro) => [...macro.paramSymbols.values()]);
}

function allLabelSymbols(parsed: MipsParseResult): MipsSymbol[] {
  return [...parsed.labels.values(), ...[...parsed.macros.values()].flatMap((macro) => [...macro.labels.values()])];
}

function allDataSymbols(parsed: MipsParseResult): MipsSymbol[] {
  return [...parsed.dataSymbols.values(), ...[...parsed.macros.values()].flatMap((macro) => [...macro.dataSymbols.values()])];
}

function allEqvSymbols(parsed: MipsParseResult): MipsSymbol[] {
  return [...parsed.eqvSymbols.values(), ...[...parsed.macros.values()].flatMap((macro) => [...macro.eqvSymbols.values()])];
}

function allSymbols(parsed: MipsParseResult): MipsSymbol[] {
  return [...allLabelSymbols(parsed), ...allDataSymbols(parsed), ...allEqvSymbols(parsed)];
}

function isKnownDeclarationRange(range: vscode.Range, parsed: MipsParseResult): boolean {
  const declarationRanges = [
    ...[...parsed.macros.values()].map((macro) => macro.selectionRange),
    ...allMacroParams(parsed).map((param) => param.selectionRange),
    ...allSymbols(parsed).map((symbol) => symbol.selectionRange)
  ];
  return declarationRanges.some((declarationRange) => declarationRange.isEqual(range));
}

function pushSemanticToken(
  tokens: MipsSemanticTokenCandidate[],
  range: vscode.Range,
  tokenType: MipsSemanticTokenType,
  modifiers?: string[]
): void {
  if (range.isEmpty) {
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

function instructionSemanticTokenType(instruction: MipsInstruction, resource: vscode.Uri): MipsSemanticTokenType {
  const colorMode = config<MipsInstructionColorMode>('mips.instructionColorMode', 'realVsPseudo', resource);
  if (colorMode === 'same') {
    return 'mipsInstruction';
  }
  if (colorMode === 'realVsPseudo') {
    return instruction.type === 'pseudo' ? 'mipsPseudoInstruction' : 'mipsRealInstruction';
  }

  switch (instruction.type) {
    case 'R-type':
      return 'mipsRInstruction';
    case 'I-type':
      return 'mipsIInstruction';
    case 'J-type':
      return 'mipsJInstruction';
    case 'special':
      return 'mipsSpecialInstruction';
    case 'pseudo':
      return 'mipsPseudoInstruction';
  }
}

function getStringRanges(code: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start: number | undefined;
  for (let index = 0; index < code.length; index++) {
    if (code[index] !== '"' || code[index - 1] === '\\') {
      continue;
    }
    if (start === undefined) {
      start = index;
    } else {
      ranges.push({
        start,
        end: index + 1
      });
      start = undefined;
    }
  }
  if (start !== undefined) {
    ranges.push({
      start,
      end: code.length
    });
  }
  return ranges;
}

function isInsideAnyRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function numericRegisters(): string[] {
  return Array.from({ length: 32 }, (_, index) => `$${index}`);
}

function loadMipsResourceData(): MipsResourceData {
  const resourceRoot = path.join(__dirname, '..', 'resources', 'mips');
  const registers = readJsonResource<MipsRegisterInfo[]>(path.join(resourceRoot, 'registers.json'));
  const directives = readJsonResource<string[]>(path.join(resourceRoot, 'directives.json')).map((directive) => directive.toLowerCase());
  const loadedInstructions = readJsonResource<MipsInstruction[]>(path.join(resourceRoot, 'instructions.json'));
  const instructions = loadedInstructions.map((instruction) => ({
    ...instruction,
    mnemonic: instruction.mnemonic.toLowerCase(),
    operands: normalizeOperandRange(instruction.operands)
  }));

  validateMipsResources(registers, directives, instructions);
  return {
    registers,
    directives,
    instructions
  };
}

function readJsonResource<T>(file: string): T {
  const content = fs.readFileSync(file, 'utf8');
  return JSON.parse(content) as T;
}

function normalizeOperandRange(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'number' || typeof value[1] !== 'number') {
    throw new Error('Invalid MIPS instruction operand range in resources.');
  }
  return [value[0], value[1]];
}

function validateMipsResources(registers: MipsRegisterInfo[], directiveList: string[], instructionList: MipsInstruction[]): void {
  if (!Array.isArray(registers) || registers.length !== 32) {
    throw new Error('MIPS register resource must contain 32 registers.');
  }
  for (const register of registers) {
    if (!Number.isInteger(register.number) || register.number < 0 || register.number > 31 || !Array.isArray(register.names) || register.names.length === 0) {
      throw new Error('Invalid MIPS register resource entry.');
    }
  }

  if (!Array.isArray(directiveList) || directiveList.some((directive) => typeof directive !== 'string' || !directive.startsWith('.'))) {
    throw new Error('Invalid MIPS directive resource.');
  }

  const seen = new Set<string>();
  for (const instruction of instructionList) {
    if (!instruction.mnemonic || seen.has(instruction.mnemonic) || !Array.isArray(instruction.formats) || !isMipsInstructionType(instruction.type)) {
      throw new Error('Invalid or duplicate MIPS instruction resource entry.');
    }
    normalizeOperandRange(instruction.operands);
    seen.add(instruction.mnemonic);
  }
}

function isMipsInstructionType(value: unknown): value is MipsInstructionType {
  return value === 'R-type' || value === 'I-type' || value === 'J-type' || value === 'special' || value === 'pseudo';
}

function instructionTypeLabel(type: MipsInstructionType): string {
  switch (type) {
    case 'R-type':
      return 'R 型指令';
    case 'I-type':
      return 'I 型指令';
    case 'J-type':
      return 'J 型指令';
    case 'special':
      return '特殊指令';
    case 'pseudo':
      return '伪指令';
  }
}

function makeInstructionMap(list: MipsInstruction[]): Record<string, MipsInstruction> {
  const map: Record<string, MipsInstruction> = {};
  for (const item of list) {
    map[item.mnemonic] = item;
  }
  return map;
}

function makeDiagnostic(range: vscode.Range, message: string, severity: vscode.DiagnosticSeverity, code: string): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(range, message, severity);
  diagnostic.source = 'BUAA CO';
  diagnostic.code = code;
  return diagnostic;
}

function rangeOfText(document: vscode.TextDocument, lineNumber: number, text: string): vscode.Range {
  const line = document.lineAt(lineNumber).text;
  const start = Math.max(0, line.indexOf(text));
  return new vscode.Range(lineNumber, start, lineNumber, start + text.length);
}

function getMipsWordRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
  return document.getWordRangeAtPosition(position, /[%$]?[A-Za-z_.$0-9][\w.$]*/);
}

function macroBody(document: vscode.TextDocument, macro: MipsMacro): string {
  if (macro.bodyEndLine === undefined || macro.bodyEndLine < macro.bodyStartLine) {
    return '';
  }
  const lines: string[] = [];
  for (let line = macro.bodyStartLine; line <= macro.bodyEndLine; line++) {
    lines.push(document.lineAt(line).text);
  }
  return lines.join('\n');
}

function formatMipsLine(line: string): string {
  const commentIndex = findCommentIndex(line);
  const code = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const comment = commentIndex >= 0 ? line.slice(commentIndex).trimEnd() : '';
  if (!code.trim()) {
    return comment ? comment : '';
  }
  const trimmed = code.trim().replace(/\s*,\s*/g, ', ');
  const formattedCode = /^[A-Za-z_.$][\w.$]*:/.test(trimmed) || trimmed.startsWith('.') ? trimmed : `    ${trimmed}`;
  if (!comment) {
    return formattedCode;
  }
  return `${formattedCode.padEnd(Math.max(formattedCode.length + 1, 32))}${comment}`;
}

function findCommentIndex(line: string): number {
  let inString = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && line[index - 1] !== '\\') {
      inString = !inString;
    }
    if (char === '#' && !inString) {
      return index;
    }
  }
  return -1;
}
