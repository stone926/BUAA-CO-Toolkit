import {
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ProjectProfile } from '../../projectProfile';
import { lineAt, makeDiagnostic, rangeOfText } from '../common/lsp';
import { CoSettings } from '../common/settings';
import {
  directives,
  instructions,
  isRegister,
  MipsInstruction,
  shouldWarnPseudoInstruction
} from './resources';

export interface MipsSymbol {
  name: string;
  kind: 'label' | 'data' | 'eqv' | 'macro' | 'macroParam';
  range: Range;
  selectionRange: Range;
  detail?: string;
  macroName?: string;
}

export interface MipsMacro {
  name: string;
  params: string[];
  paramSymbols: Map<string, MipsSymbol>;
  labels: Map<string, MipsSymbol>;
  dataSymbols: Map<string, MipsSymbol>;
  eqvSymbols: Map<string, MipsSymbol>;
  range: Range;
  selectionRange: Range;
  bodyStartLine: number;
  bodyEndLine?: number;
}

export interface MipsLine {
  line: number;
  mnemonic: string;
  operands: string[];
  range: Range;
  usesPseudoForm: boolean;
}

export interface MipsLabelReference {
  line: number;
  operand: string;
  macro?: MipsMacro;
}

export interface MipsParseResult {
  labels: Map<string, MipsSymbol>;
  dataSymbols: Map<string, MipsSymbol>;
  eqvSymbols: Map<string, MipsSymbol>;
  macros: Map<string, MipsMacro[]>;
  instructions: MipsLine[];
  diagnostics: Diagnostic[];
}

type MipsSection = 'text' | 'data' | 'other';

interface MipsSymbolScope {
  labels: Map<string, MipsSymbol>;
  dataSymbols: Map<string, MipsSymbol>;
  eqvSymbols: Map<string, MipsSymbol>;
}

export interface MipsParseOptions {
  includeDiagnostics?: boolean;
  ignoredPseudoInstructionFiles?: Set<string>;
  ignoredPseudoInstructionMnemonics?: Set<string>;
}

export function parseMips(document: TextDocument, settings: CoSettings, options: MipsParseOptions = {}): MipsParseResult {
  const labels = new Map<string, MipsSymbol>();
  const dataSymbols = new Map<string, MipsSymbol>();
  const eqvSymbols = new Map<string, MipsSymbol>();
  const macros = new Map<string, MipsMacro[]>();
  const instructionsSeen: MipsLine[] = [];
  const labelReferences: MipsLabelReference[] = [];
  const diagnostics: Diagnostic[] = [];
  const profile = settings.project.profile;
  const includeDiagnostics = options.includeDiagnostics !== false;
  let section: MipsSection = 'text';
  let sectionBeforeMacro: MipsSection | undefined;
  let activeMacro: MipsMacro | undefined;
  let hasSyscall = false;

  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const original = lineAt(document, lineNumber).text;
    let code = stripComment(original);
    let scanOffset = 0;

    while (true) {
      const labelMatch = code.match(/^\s*([A-Za-z_.$][\w.$]*):/);
      if (!labelMatch) {
        break;
      }
      const name = labelMatch[1];
      const start = original.indexOf(name, scanOffset);
      const selectionRange = Range.create(lineNumber, start, lineNumber, start + name.length);
      const symbol: MipsSymbol = {
        name,
        kind: section === 'data' ? 'data' : 'label',
        range: lineAt(document, lineNumber).range,
        selectionRange,
        macroName: activeMacro?.name
      };
      const scope = symbolScope(activeMacro, labels, dataSymbols, eqvSymbols);
      const targetMap = section === 'data' ? scope.dataSymbols : scope.labels;
      if (isReservedIdentifier(name)) {
        diagnostics.push(makeDiagnostic(selectionRange, `Symbol '${name}' conflicts with a reserved MIPS word.`, DiagnosticSeverity.Error, 'reserved-symbol'));
      }
      if (symbolScopeHas(scope, name)) {
        diagnostics.push(makeDiagnostic(selectionRange, `Duplicate symbol '${name}'.`, DiagnosticSeverity.Error, 'duplicate-symbol'));
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
      const selectionRange = Range.create(lineNumber, start, lineNumber, start + name.length);
      const symbol: MipsSymbol = {
        name,
        kind: 'eqv',
        range: lineAt(document, lineNumber).range,
        selectionRange,
        macroName: activeMacro?.name
      };
      const scope = symbolScope(activeMacro, labels, dataSymbols, eqvSymbols);
      if (symbolScopeHas(scope, name)) {
        diagnostics.push(makeDiagnostic(selectionRange, `Duplicate symbol '${name}'.`, DiagnosticSeverity.Error, 'duplicate-symbol'));
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
        .map((item) => (item.startsWith('%') || item.startsWith('$') ? item : `%${item}`));
      const selectionRange = Range.create(lineNumber, nameStart, lineNumber, nameStart + name.length);
      validateMacroHeader(document, lineNumber, name, params, selectionRange, diagnostics);
      const macro: MipsMacro = {
        name,
        params,
        paramSymbols: new Map(),
        labels: new Map(),
        dataSymbols: new Map(),
        eqvSymbols: new Map(),
        range: lineAt(document, lineNumber).range,
        selectionRange,
        bodyStartLine: lineNumber + 1
      };
      if (activeMacro) {
        diagnostics.push(makeDiagnostic(selectionRange, `Nested macro '${name}' is not supported by this language service.`, DiagnosticSeverity.Warning, 'nested-macro'));
      }
      const overloads = macros.get(name) ?? [];
      if (overloads.some((overload) => overload.params.length === macro.params.length)) {
        diagnostics.push(makeDiagnostic(selectionRange, `Duplicate macro '${name}' with ${macro.params.length} parameter(s).`, DiagnosticSeverity.Error, 'duplicate-macro'));
      } else {
        overloads.push(macro);
        macros.set(name, overloads);
      }
      sectionBeforeMacro = section;
      activeMacro = macro;
      for (const param of params) {
        const paramIndex = original.indexOf(param);
        if (paramIndex >= 0) {
          if (macro.paramSymbols.has(param)) {
            diagnostics.push(makeDiagnostic(Range.create(lineNumber, paramIndex, lineNumber, paramIndex + param.length), `Duplicate macro parameter '${param}'.`, DiagnosticSeverity.Error, 'duplicate-macro-parameter'));
            continue;
          }
          macro.paramSymbols.set(param, {
            name: param,
            kind: 'macroParam',
            range: lineAt(document, lineNumber).range,
            selectionRange: Range.create(lineNumber, paramIndex, lineNumber, paramIndex + param.length),
            macroName: macro.name
          });
        }
      }
      continue;
    }

    if (trimmed.startsWith('.end_macro')) {
      if (!activeMacro) {
        diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, '.end_macro'), 'Unexpected .end_macro without a matching .macro.', DiagnosticSeverity.Error, 'macro-end'));
      } else {
        activeMacro.bodyEndLine = lineNumber - 1;
        activeMacro.range = Range.create(activeMacro.range.start, lineAt(document, lineNumber).range.end);
        activeMacro = undefined;
        section = sectionBeforeMacro ?? section;
        sectionBeforeMacro = undefined;
      }
      continue;
    }

    validateRegisters(document, lineNumber, original, activeMacro, diagnostics);

    const firstToken = trimmed.match(/^([A-Za-z_.$][\w.$]*|\.[A-Za-z_][\w.]*)/);
    if (!firstToken) {
      continue;
    }
    const mnemonic = firstToken[1].toLowerCase();
    if (mnemonic.startsWith('.')) {
      if (!directives.has(mnemonic)) {
        diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, firstToken[1]), `Unknown directive '${firstToken[1]}'.`, DiagnosticSeverity.Error, 'unknown-directive'));
      }
      validateDirective(document, lineNumber, trimmed, section, activeMacro, diagnostics);
      continue;
    }

    const instruction = instructions[mnemonic];
    const macroOverloads = macros.get(firstToken[1]);
    if (!instruction && !macroOverloads?.length) {
      const eqv = resolveEqvSymbolInScope(firstToken[1], activeMacro, eqvSymbols);
      if (eqv && isDeclaredBefore(eqv, Range.create(lineNumber, 0, lineNumber, 0).start)) {
        continue;
      }
      diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, firstToken[1]), `Unknown instruction or macro '${firstToken[1]}'.`, DiagnosticSeverity.Error, 'unknown-instruction'));
      continue;
    }

    if (section === 'data' && instruction) {
      diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, firstToken[1]), `Instruction '${firstToken[1]}' cannot appear in a data segment. Switch to .text first.`, DiagnosticSeverity.Error, 'instruction-in-data'));
    }

    if (!instruction && macroOverloads?.length) {
      const operands = parseMacroArguments(trimmed.slice(firstToken[0].length).trim());
      for (const operand of operands) {
        if (!isMacroArgumentToken(operand)) {
          diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, operand), `Macro argument '${operand}' must be a single MARS language element; memory operands such as 4($t0) are not valid macro arguments.`, DiagnosticSeverity.Error, 'macro-argument'));
        }
      }
      if (!macroOverloads.some((macro) => macro.params.length === operands.length)) {
        const counts = [...new Set(macroOverloads.map((macro) => macro.params.length))].sort((a, b) => a - b).join('/');
        diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, firstToken[1]), `Macro '${firstToken[1]}' expects ${counts} argument(s), got ${operands.length}.`, DiagnosticSeverity.Error, 'macro-argument-count'));
      }
    }

    if (instruction) {
      if (mnemonic === 'syscall') {
        hasSyscall = true;
      }
      const operandText = trimmed.slice(firstToken[0].length).trim();
      const operands = parseOperands(operandText);
      const usesPseudoForm = instruction.pseudo || usesMarsPseudoInstructionForm(mnemonic, operands, activeMacro, eqvSymbols);
      instructionsSeen.push({
        line: lineNumber,
        mnemonic,
        operands,
        range: rangeOfText(document, lineNumber, firstToken[1]),
        usesPseudoForm
      });
      validateInstruction(document, lineNumber, instruction, operands, profile, settings, options, activeMacro, eqvSymbols, diagnostics);
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
    activeMacro.range = Range.create(activeMacro.range.start, lineAt(document, document.lineCount - 1).range.end);
    diagnostics.push(makeDiagnostic(activeMacro.selectionRange, `Macro '${activeMacro.name}' is missing .end_macro.`, DiagnosticSeverity.Error, 'macro-unclosed'));
  }

  const parsed: MipsParseResult = {
    labels,
    dataSymbols,
    eqvSymbols,
    macros,
    instructions: instructionsSeen,
    diagnostics
  };
  const missingLabelRanges = new Set<string>();
  for (const reference of labelReferences) {
    if (!resolveReferenceSymbol(reference.operand, reference.macro, labels, dataSymbols)) {
      const range = rangeOfText(document, reference.line, reference.operand);
      missingLabelRanges.add(rangeKey(range));
      diagnostics.push(makeDiagnostic(range, `Cannot find label or data symbol '${reference.operand}'.`, DiagnosticSeverity.Error, 'missing-label'));
    }
  }
  collectUndeclaredSymbolDiagnostics(document, parsed, diagnostics, missingLabelRanges);

  if (profile === 'P2' && settings.mips.warnMissingExitSyscall && !hasSyscall && document.lineCount > 2) {
    const firstLine = lineAt(document, 0).text;
    const range = Range.create(0, 0, 0, Math.max(1, firstLine.length));
    diagnostics.push(makeDiagnostic(range, 'P2 programs usually need a syscall exit path, otherwise MARS/online tests may time out.', DiagnosticSeverity.Warning, 'missing-syscall'));
  }

  return {
    ...parsed,
    diagnostics: includeDiagnostics ? diagnostics : []
  };
}

export function findMacroAtPosition(parsed: MipsParseResult, position: Position): MipsMacro | undefined {
  for (const macro of allMacros(parsed)) {
    if (containsPosition(macro.range, position)) {
      return macro;
    }
  }
  return undefined;
}

export function findMacroParamAtPosition(parsed: MipsParseResult, name: string, position: Position): MipsSymbol | undefined {
  return findMacroAtPosition(parsed, position)?.paramSymbols.get(name);
}

export function resolveSymbolAtPosition(parsed: MipsParseResult, name: string, position: Position): MipsSymbol | undefined {
  return resolveLabelAtPosition(parsed, name, position) ?? resolveDataSymbolAtPosition(parsed, name, position) ?? resolveEqvSymbolAtPosition(parsed, name, position);
}

export function resolveLabelAtPosition(parsed: MipsParseResult, name: string, position: Position): MipsSymbol | undefined {
  return findMacroAtPosition(parsed, position)?.labels.get(name) ?? parsed.labels.get(name);
}

export function resolveDataSymbolAtPosition(parsed: MipsParseResult, name: string, position: Position): MipsSymbol | undefined {
  return findMacroAtPosition(parsed, position)?.dataSymbols.get(name) ?? parsed.dataSymbols.get(name);
}

export function resolveEqvSymbolAtPosition(parsed: MipsParseResult, name: string, position: Position): MipsSymbol | undefined {
  return findMacroAtPosition(parsed, position)?.eqvSymbols.get(name) ?? parsed.eqvSymbols.get(name);
}

export function symbolsVisibleAtPosition(parsed: MipsParseResult, position: Position): MipsSymbol[] {
  const macro = findMacroAtPosition(parsed, position);
  return [
    ...(macro ? [...macro.labels.values(), ...macro.dataSymbols.values(), ...macro.eqvSymbols.values()] : []),
    ...parsed.labels.values(),
    ...parsed.dataSymbols.values(),
    ...parsed.eqvSymbols.values()
  ];
}

export function allMacroParams(parsed: MipsParseResult): MipsSymbol[] {
  return allMacros(parsed).flatMap((macro) => [...macro.paramSymbols.values()]);
}

export function allLabelSymbols(parsed: MipsParseResult): MipsSymbol[] {
  return [...parsed.labels.values(), ...allMacros(parsed).flatMap((macro) => [...macro.labels.values()])];
}

export function allDataSymbols(parsed: MipsParseResult): MipsSymbol[] {
  return [...parsed.dataSymbols.values(), ...allMacros(parsed).flatMap((macro) => [...macro.dataSymbols.values()])];
}

export function allEqvSymbols(parsed: MipsParseResult): MipsSymbol[] {
  return [...parsed.eqvSymbols.values(), ...allMacros(parsed).flatMap((macro) => [...macro.eqvSymbols.values()])];
}

export function allSymbols(parsed: MipsParseResult): MipsSymbol[] {
  return [...allLabelSymbols(parsed), ...allDataSymbols(parsed), ...allEqvSymbols(parsed)];
}

export function allMacros(parsed: MipsParseResult): MipsMacro[] {
  return [...parsed.macros.values()].flat();
}

export function stripComment(line: string): string {
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

export function parseOperands(text: string): string[] {
  if (!text) {
    return [];
  }
  let normalized = text.trim();
  if (normalized.startsWith('(') && normalized.endsWith(')')) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (!normalized) {
    return [];
  }
  return normalized
    .split(',')
    .map((operand) => operand.trim())
    .filter(Boolean);
}

export function parseMacroArguments(text: string): string[] {
  const normalized = text.trim().replace(/^\(/, '').replace(/\)$/, '').trim();
  if (!normalized) {
    return [];
  }
  const args: string[] = [];
  let start = 0;
  let inString = false;
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === '"' && normalized[index - 1] !== '\\') {
      inString = !inString;
    }
    if (!inString && (char === ',' || /\s/.test(char))) {
      const arg = normalized.slice(start, index).trim();
      if (arg) {
        args.push(arg);
      }
      start = index + 1;
    }
  }
  const tail = normalized.slice(start).trim();
  if (tail) {
    args.push(tail);
  }
  return args;
}

export function formatMipsLine(line: string): string {
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

export function findCommentIndex(line: string): number {
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

export function getStringRanges(code: string): Array<{ start: number; end: number }> {
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

function getNumericLikeRanges(code: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const regex = /[-+]?(?:0[xX][\w]+|0[bB][\w]+|0\d+|\b\d+\b)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code))) {
    ranges.push({
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return ranges;
}

export function isInsideAnyRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function validateDirective(document: TextDocument, lineNumber: number, trimmed: string, section: MipsSection, activeMacro: MipsMacro | undefined, diagnostics: Diagnostic[]): void {
  const firstToken = trimmed.match(/^(\.[A-Za-z_][\w.]*)/);
  if (!firstToken) {
    return;
  }
  const directive = firstToken[1].toLowerCase();
  const operandText = trimmed.slice(firstToken[0].length).trim();
  const directiveRange = rangeOfText(document, lineNumber, firstToken[1]);
  if (storageDirectives().has(directive) && section !== 'data') {
    diagnostics.push(makeDiagnostic(directiveRange, `${directive} can only be used in a data segment. Switch to .data first.`, DiagnosticSeverity.Error, 'directive-segment'));
  }

  switch (directive) {
    case '.text':
    case '.data':
    case '.ktext':
    case '.kdata':
      validateDirectiveOperandCount(document, lineNumber, directive, parseOperands(operandText), 0, 1, diagnostics);
      if (operandText && !isIntegerLiteral(operandText)) {
        diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, operandText), `${directive} address must be an integer literal.`, DiagnosticSeverity.Error, 'directive-operand'));
      }
      return;
    case '.byte':
    case '.half':
      validateStorageNumberList(document, lineNumber, directive, operandText, false, activeMacro, diagnostics);
      return;
    case '.word':
      validateWordDirective(document, lineNumber, operandText, activeMacro, diagnostics);
      return;
    case '.float':
    case '.double':
      validateFloatList(document, lineNumber, directive, operandText, activeMacro, diagnostics);
      return;
    case '.ascii':
    case '.asciiz':
      validateStringList(document, lineNumber, directive, operandText, activeMacro, diagnostics);
      return;
    case '.space':
    case '.align':
      validateSingleIntegerDirective(document, lineNumber, directive, operandText, activeMacro, diagnostics);
      return;
    case '.globl':
      validateLabelListDirective(document, lineNumber, directive, operandText, diagnostics);
      return;
    case '.extern':
      validateExternDirective(document, lineNumber, operandText, diagnostics);
      return;
    case '.eqv':
      validateEqvDirective(document, lineNumber, operandText, diagnostics);
      return;
    case '.macro':
      validateMacroDirectiveSyntax(document, lineNumber, trimmed, diagnostics);
      return;
    case '.end_macro':
      if (operandText) {
        diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, operandText), '.end_macro does not accept operands.', DiagnosticSeverity.Error, 'directive-operand'));
      }
      return;
    case '.include':
      if (!/^"([^"\\]|\\.)*"$/.test(operandText)) {
        diagnostics.push(makeDiagnostic(operandText ? rangeOfText(document, lineNumber, operandText) : directiveRange, '.include expects one quoted path string.', DiagnosticSeverity.Error, 'directive-operand'));
      }
      return;
  }
}

function validateMacroHeader(document: TextDocument, lineNumber: number, name: string, params: string[], selectionRange: Range, diagnostics: Diagnostic[]): void {
  if (isReservedIdentifier(name)) {
    diagnostics.push(makeDiagnostic(selectionRange, `Macro name '${name}' conflicts with a reserved MIPS word.`, DiagnosticSeverity.Error, 'reserved-symbol'));
  }
  for (const param of params) {
    const paramIndex = lineAt(document, lineNumber).text.indexOf(param);
    const range = paramIndex >= 0 ? Range.create(lineNumber, paramIndex, lineNumber, paramIndex + param.length) : selectionRange;
    if (!/^[%$][A-Za-z_.$][\w.$]*$/.test(param)) {
      diagnostics.push(makeDiagnostic(range, `Macro parameter '${param}' must start with % or $ and use identifier characters.`, DiagnosticSeverity.Error, 'macro-parameter'));
    }
  }
}

function validateMacroDirectiveSyntax(document: TextDocument, lineNumber: number, trimmed: string, diagnostics: Diagnostic[]): void {
  if (!/^\.macro\s+[A-Za-z_.$][\w.$]*(?:\s*(?:\([^)]*\)|.*))?$/.test(trimmed)) {
    diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, '.macro'), '.macro expects a macro name and optional formal parameters.', DiagnosticSeverity.Error, 'macro-header'));
  }
}

function validateDirectiveOperandCount(document: TextDocument, lineNumber: number, directive: string, operands: string[], min: number, max: number, diagnostics: Diagnostic[]): boolean {
  if (operands.length < min || operands.length > max) {
    diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, directive), `${directive} expects ${min === max ? min : `${min}-${max}`} operand(s), got ${operands.length}.`, DiagnosticSeverity.Error, 'directive-operand-count'));
    return false;
  }
  return true;
}

function validateStorageNumberList(document: TextDocument, lineNumber: number, directive: string, operandText: string, allowLabels: boolean, activeMacro: MipsMacro | undefined, diagnostics: Diagnostic[]): void {
  const operands = parseOperands(operandText);
  if (!validateDirectiveOperandCount(document, lineNumber, directive, operands, 1, Number.MAX_SAFE_INTEGER, diagnostics)) {
    return;
  }
  for (const operand of operands) {
    const [value, count] = splitRepeatOperand(operand);
    if (!(isIntegerLiteral(value) || Boolean(activeMacro?.paramSymbols.has(value)) || (allowLabels && isSymbolLike(value)))) {
      diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, value), `${directive} expects integer${allowLabels ? ' or label' : ''} operands.`, DiagnosticSeverity.Error, 'directive-operand'));
    }
    if (count !== undefined && !isNonNegativeIntegerLiteral(count)) {
      diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, count), `${directive} repeat count must be a non-negative integer.`, DiagnosticSeverity.Error, 'directive-operand'));
    }
  }
}

function validateWordDirective(document: TextDocument, lineNumber: number, operandText: string, activeMacro: MipsMacro | undefined, diagnostics: Diagnostic[]): void {
  const operands = parseOperands(operandText);
  if (!validateDirectiveOperandCount(document, lineNumber, '.word', operands, 1, Number.MAX_SAFE_INTEGER, diagnostics)) {
    return;
  }
  for (const operand of operands) {
    const [value, count] = splitRepeatOperand(operand);
    if (!(isIntegerLiteral(value) || isSymbolLike(value) || Boolean(activeMacro?.paramSymbols.has(value)))) {
      diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, value), '.word expects integer or label operands.', DiagnosticSeverity.Error, 'directive-operand'));
    }
    if (count !== undefined && !isNonNegativeIntegerLiteral(count)) {
      diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, count), '.word repeat count must be a non-negative integer.', DiagnosticSeverity.Error, 'directive-operand'));
    }
  }
}

function validateFloatList(document: TextDocument, lineNumber: number, directive: string, operandText: string, activeMacro: MipsMacro | undefined, diagnostics: Diagnostic[]): void {
  const operands = parseOperands(operandText);
  if (!validateDirectiveOperandCount(document, lineNumber, directive, operands, 1, Number.MAX_SAFE_INTEGER, diagnostics)) {
    return;
  }
  for (const operand of operands) {
    const [value, count] = splitRepeatOperand(operand);
    if (!(isFloatLiteral(value) || Boolean(activeMacro?.paramSymbols.has(value)))) {
      diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, value), `${directive} expects floating-point operands.`, DiagnosticSeverity.Error, 'directive-operand'));
    }
    if (count !== undefined && !isNonNegativeIntegerLiteral(count)) {
      diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, count), `${directive} repeat count must be a non-negative integer.`, DiagnosticSeverity.Error, 'directive-operand'));
    }
  }
}

function validateStringList(document: TextDocument, lineNumber: number, directive: string, operandText: string, activeMacro: MipsMacro | undefined, diagnostics: Diagnostic[]): void {
  const operands = parseOperands(operandText);
  if (!validateDirectiveOperandCount(document, lineNumber, directive, operands, 1, Number.MAX_SAFE_INTEGER, diagnostics)) {
    return;
  }
  for (const operand of operands) {
    if (!(/^"([^"\\]|\\.)*"$/.test(operand) || Boolean(activeMacro?.paramSymbols.has(operand)))) {
      diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, operand), `${directive} expects string literal operands.`, DiagnosticSeverity.Error, 'directive-operand'));
    }
  }
}

function validateSingleIntegerDirective(document: TextDocument, lineNumber: number, directive: string, operandText: string, activeMacro: MipsMacro | undefined, diagnostics: Diagnostic[]): void {
  const operands = parseOperands(operandText);
  if (!validateDirectiveOperandCount(document, lineNumber, directive, operands, 1, 1, diagnostics)) {
    return;
  }
  if (!(isNonNegativeIntegerLiteral(operands[0]) || Boolean(activeMacro?.paramSymbols.has(operands[0])))) {
    diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, operands[0]), `${directive} expects one non-negative integer operand.`, DiagnosticSeverity.Error, 'directive-operand'));
  }
}

function validateLabelListDirective(document: TextDocument, lineNumber: number, directive: string, operandText: string, diagnostics: Diagnostic[]): void {
  const operands = parseOperands(operandText);
  if (!validateDirectiveOperandCount(document, lineNumber, directive, operands, 1, Number.MAX_SAFE_INTEGER, diagnostics)) {
    return;
  }
  for (const operand of operands) {
    if (!isSymbolLike(operand)) {
      diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, operand), `${directive} expects label operands.`, DiagnosticSeverity.Error, 'directive-operand'));
    }
  }
}

function validateExternDirective(document: TextDocument, lineNumber: number, operandText: string, diagnostics: Diagnostic[]): void {
  const operands = parseOperands(operandText);
  if (!validateDirectiveOperandCount(document, lineNumber, '.extern', operands, 2, 2, diagnostics)) {
    return;
  }
  if (!isSymbolLike(operands[0])) {
    diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, operands[0]), '.extern first operand must be a label.', DiagnosticSeverity.Error, 'directive-operand'));
  }
  if (!isNonNegativeIntegerLiteral(operands[1])) {
    diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, operands[1]), '.extern size must be a non-negative integer.', DiagnosticSeverity.Error, 'directive-operand'));
  }
}

function validateEqvDirective(document: TextDocument, lineNumber: number, operandText: string, diagnostics: Diagnostic[]): void {
  const match = operandText.match(/^([A-Za-z_.$][\w.$]*)(?:\s*,?\s+|\s*,)(.+)$/);
  if (!match) {
    diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, '.eqv'), '.eqv expects an identifier and a replacement sequence.', DiagnosticSeverity.Error, 'directive-operand'));
    return;
  }
  if (isReservedIdentifier(match[1])) {
    diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, match[1]), `.eqv identifier '${match[1]}' conflicts with a reserved MIPS word.`, DiagnosticSeverity.Error, 'reserved-symbol'));
  }
}

function validateInstructionOperands(
  document: TextDocument,
  lineNumber: number,
  instruction: MipsInstruction,
  operands: string[],
  activeMacro: MipsMacro | undefined,
  eqvSymbols: Map<string, MipsSymbol>,
  diagnostics: Diagnostic[]
): void {
  const patterns = instruction.formats
    .map((format) => instructionPattern(format))
    .filter((pattern) => pattern.length === operands.length);
  if (!patterns.length) {
    return;
  }
  if (patterns.some((pattern) => operands.every((operand, index) => operandMatchesPattern(operand, pattern[index], activeMacro, eqvSymbols)))) {
    return;
  }
  if (usesMarsPseudoInstructionForm(instruction.mnemonic, operands, activeMacro, eqvSymbols)) {
    return;
  }
  diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, instruction.mnemonic), `${instruction.mnemonic} operands do not match supported MARS format(s): ${instruction.formats.join(' | ')}.`, DiagnosticSeverity.Error, 'operand-type'));
}

function usesMarsPseudoInstructionForm(mnemonic: string, operands: string[], activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  if (
    ['add', 'addu', 'sub', 'subu'].includes(mnemonic) &&
    operands.length === 3 &&
    isRegisterOperand(operands[0], activeMacro, eqvSymbols) &&
    isRegisterOperand(operands[1], activeMacro, eqvSymbols) &&
    isImmediateOperand(operands[2], activeMacro, eqvSymbols, 'imm32')
  ) {
    return true;
  }

  if (
    ['and', 'or', 'xor'].includes(mnemonic) &&
    operands.length >= 2 &&
    operands.length <= 3 &&
    isRegisterOperand(operands[0], activeMacro, eqvSymbols) &&
    (operands.length === 2 || isRegisterOperand(operands[1], activeMacro, eqvSymbols)) &&
    isImmediateOperand(operands[operands.length - 1], activeMacro, eqvSymbols, 'uimm16')
  ) {
    return true;
  }

  if (
    ['addi', 'addiu'].includes(mnemonic) &&
    operands.length === 3 &&
    isRegisterOperand(operands[0], activeMacro, eqvSymbols) &&
    isRegisterOperand(operands[1], activeMacro, eqvSymbols) &&
    isImmediateOperand(operands[2], activeMacro, eqvSymbols, 'imm32') &&
    !isImmediateOperand(operands[2], activeMacro, eqvSymbols, 'simm16')
  ) {
    return true;
  }

  if (
    ['andi', 'ori', 'xori'].includes(mnemonic) &&
    operands.length === 3 &&
    isRegisterOperand(operands[0], activeMacro, eqvSymbols) &&
    isRegisterOperand(operands[1], activeMacro, eqvSymbols) &&
    isImmediateOperand(operands[2], activeMacro, eqvSymbols, 'imm32') &&
    !isImmediateOperand(operands[2], activeMacro, eqvSymbols, 'uimm16')
  ) {
    return true;
  }

  if (
    ['mul', 'div', 'divu', 'rem', 'remu', 'seq', 'sne', 'sgt', 'sgtu', 'sge', 'sgeu', 'sle', 'sleu'].includes(mnemonic) &&
    operands.length === 3 &&
    isRegisterOperand(operands[0], activeMacro, eqvSymbols) &&
    isRegisterOperand(operands[1], activeMacro, eqvSymbols) &&
    isImmediateOperand(operands[2], activeMacro, eqvSymbols, 'imm32')
  ) {
    return true;
  }

  if (
    ['div', 'divu'].includes(mnemonic) &&
    operands.length === 3 &&
    operands.every((operand) => isRegisterOperand(operand, activeMacro, eqvSymbols))
  ) {
    return true;
  }

  if (
    ['beq', 'bne', 'blt', 'bltu', 'bgt', 'bgtu', 'ble', 'bleu', 'bge', 'bgeu'].includes(mnemonic) &&
    operands.length === 3 &&
    isRegisterOperand(operands[0], activeMacro, eqvSymbols) &&
    isImmediateOperand(operands[1], activeMacro, eqvSymbols, 'imm32') &&
    isLabelOperand(operands[2], activeMacro)
  ) {
    return true;
  }

  if (
    ['lw', 'sw', 'lb', 'lbu', 'lh', 'lhu', 'sb', 'sh'].includes(mnemonic) &&
    operands.length === 2 &&
    isRegisterOperand(operands[0], activeMacro, eqvSymbols) &&
    isMemoryOperandWithPseudoOffset(operands[1], activeMacro, eqvSymbols)
  ) {
    return true;
  }

  return false;
}

function validateInstruction(
  document: TextDocument,
  lineNumber: number,
  instruction: MipsInstruction,
  operands: string[],
  profile: ProjectProfile,
  settings: CoSettings,
  options: MipsParseOptions,
  activeMacro: MipsMacro | undefined,
  eqvSymbols: Map<string, MipsSymbol>,
  diagnostics: Diagnostic[]
): void {
  const [min, max] = instruction.operands;
  if (operands.length < min || operands.length > max) {
    diagnostics.push(
      makeDiagnostic(
        rangeOfText(document, lineNumber, instruction.mnemonic),
        `${instruction.mnemonic} expects ${min === max ? min : `${min}-${max}`} operand(s), got ${operands.length}.`,
        DiagnosticSeverity.Error,
        'operand-count'
      )
    );
  }
  validateInstructionOperands(document, lineNumber, instruction, operands, activeMacro, eqvSymbols, diagnostics);

  if (!instruction.pseudo && usesMarsPseudoInstructionForm(instruction.mnemonic, operands, activeMacro, eqvSymbols) && shouldWarnPseudoInstruction(settings, document.uri, instruction.mnemonic, options.ignoredPseudoInstructionFiles ?? new Set(), options.ignoredPseudoInstructionMnemonics ?? new Set())) {
    diagnostics.push(
      makeDiagnostic(
        rangeOfText(document, lineNumber, instruction.mnemonic),
        `${instruction.mnemonic} uses a MARS extended pseudo-instruction form. Verify expansion when generating CPU tests.`,
        DiagnosticSeverity.Information,
        `pseudo-instruction:${instruction.mnemonic}`
      )
    );
  }

  if (instruction.pseudo && shouldWarnPseudoInstruction(settings, document.uri, instruction.mnemonic, options.ignoredPseudoInstructionFiles ?? new Set(), options.ignoredPseudoInstructionMnemonics ?? new Set())) {
    diagnostics.push(
      makeDiagnostic(
        rangeOfText(document, lineNumber, instruction.mnemonic),
        `${instruction.mnemonic} is a pseudo instruction. Verify expansion when generating CPU tests.`,
        DiagnosticSeverity.Information,
        `pseudo-instruction:${instruction.mnemonic}`
      )
    );
  }

  if (profile !== 'auto' && instruction.projects && !instruction.projects.includes(profile)) {
    diagnostics.push(
      makeDiagnostic(
        rangeOfText(document, lineNumber, instruction.mnemonic),
        `${instruction.mnemonic} is normally used in ${instruction.projects.join('/')} profile(s), not ${profile}.`,
        DiagnosticSeverity.Warning,
        'project-instruction'
      )
    );
  }
}

function validateRegisters(document: TextDocument, lineNumber: number, line: string, activeMacro: MipsMacro | undefined, diagnostics: Diagnostic[]): void {
  const code = stripComment(line);
  const regex = /\$[A-Za-z0-9_]+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code))) {
    const reg = match[0];
    if (activeMacro?.paramSymbols.has(reg)) {
      continue;
    }
    if (!isRegister(reg)) {
      diagnostics.push(makeDiagnostic(Range.create(lineNumber, match.index, lineNumber, match.index + reg.length), `Unknown register '${reg}'.`, DiagnosticSeverity.Error, 'unknown-register'));
    }
  }
}

function instructionPattern(format: string): string[] {
  const parts = format.trim().split(/\s+/, 2);
  if (parts.length < 2) {
    return [];
  }
  return parseOperands(format.slice(parts[0].length).trim());
}

function operandMatchesPattern(operand: string, pattern: string, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  if (pattern === '$rd' || pattern === '$rs' || pattern === '$rt' || pattern === '$base') {
    return isRegisterOperand(operand, activeMacro, eqvSymbols);
  }
  if (pattern === 'offset($base)') {
    return isMemoryOperand(operand, activeMacro, eqvSymbols, 'simm16');
  }
  if (pattern === 'imm' || pattern === 'imm32') {
    return isImmediateOperand(operand, activeMacro, eqvSymbols, 'imm32');
  }
  if (pattern === 'simm16') {
    return isImmediateOperand(operand, activeMacro, eqvSymbols, 'simm16');
  }
  if (pattern === 'uimm16') {
    return isImmediateOperand(operand, activeMacro, eqvSymbols, 'uimm16');
  }
  if (pattern === 'shamt') {
    return isShiftAmountOperand(operand, activeMacro, eqvSymbols);
  }
  if (pattern === 'pos') {
    return isBitPositionOperand(operand, activeMacro, eqvSymbols);
  }
  if (pattern === 'size') {
    return isBitSizeOperand(operand, activeMacro, eqvSymbols);
  }
  if (pattern === 'code' || pattern === 'code16') {
    return isImmediateOperand(operand, activeMacro, eqvSymbols, 'uimm16');
  }
  if (pattern === 'label') {
    return isLabelOperand(operand, activeMacro);
  }
  return true;
}

function isRegisterOperand(operand: string, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  return isRegister(operand) || Boolean(activeMacro?.paramSymbols.has(operand)) || eqvSymbols.has(operand);
}

type ImmediateKind = 'imm32' | 'simm16' | 'uimm16';

function isImmediateOperand(operand: string, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>, kind: ImmediateKind = 'imm32'): boolean {
  if (activeMacro?.paramSymbols.has(operand) || eqvSymbols.has(operand)) {
    return true;
  }
  if (isCharLiteral(operand)) {
    return true;
  }
  const value = parseIntegerLiteral(operand);
  return value !== undefined && integerFitsImmediateKind(value, kind);
}

function isShiftAmountOperand(operand: string, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  if (activeMacro?.paramSymbols.has(operand) || eqvSymbols.has(operand)) {
    return true;
  }
  const value = parseIntegerLiteral(operand);
  return value !== undefined && integerFitsRange(value, 0, 31);
}

function isBitPositionOperand(operand: string, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  return isShiftAmountOperand(operand, activeMacro, eqvSymbols);
}

function isBitSizeOperand(operand: string, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  if (activeMacro?.paramSymbols.has(operand) || eqvSymbols.has(operand)) {
    return true;
  }
  const value = parseIntegerLiteral(operand);
  return value !== undefined && value >= 1 && value <= 32;
}

function isMemoryOperand(operand: string, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>, offsetKind: ImmediateKind = 'simm16'): boolean {
  const memory = operand.match(/^(.+)?\(([^()]+)\)$/);
  if (memory) {
    const offset = (memory[1] ?? '0').trim();
    const base = memory[2].trim();
    return (!offset || isImmediateOperand(offset, activeMacro, eqvSymbols, offsetKind) || isSymbolLike(offset)) &&
      isRegisterOperand(base, activeMacro, eqvSymbols);
  }
  return isSymbolLike(operand) || isImmediateOperand(operand, activeMacro, eqvSymbols, offsetKind);
}

function isMemoryOperandWithPseudoOffset(operand: string, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  const memory = operand.match(/^(.+)?\(([^()]+)\)$/);
  if (!memory) {
    return isImmediateOperand(operand, activeMacro, eqvSymbols, 'imm32') &&
      !isImmediateOperand(operand, activeMacro, eqvSymbols, 'simm16');
  }
  const offset = (memory[1] ?? '0').trim();
  if (!offset || activeMacro?.paramSymbols.has(offset) || eqvSymbols.has(offset) || isSymbolLike(offset)) {
    return false;
  }
  return isImmediateOperand(offset, activeMacro, eqvSymbols, 'imm32') &&
    !isImmediateOperand(offset, activeMacro, eqvSymbols, 'simm16') &&
    isRegisterOperand(memory[2].trim(), activeMacro, eqvSymbols);
}

function isLabelOperand(operand: string, activeMacro: MipsMacro | undefined): boolean {
  return isSymbolLike(operand) || Boolean(activeMacro?.paramSymbols.has(operand));
}

function storageDirectives(): Set<string> {
  return new Set(['.byte', '.half', '.word', '.float', '.double', '.ascii', '.asciiz', '.space', '.align']);
}

function splitRepeatOperand(operand: string): [string, string | undefined] {
  const parts = operand.split(':').map((part) => part.trim());
  return [parts[0], parts.length > 1 ? parts.slice(1).join(':').trim() : undefined];
}

function isIntegerLiteral(value: string): boolean {
  return parseIntegerLiteral(value) !== undefined;
}

function isNonNegativeIntegerLiteral(value: string): boolean {
  const parsed = parseIntegerLiteral(value);
  return parsed !== undefined && parsed >= 0;
}

function parseIntegerLiteral(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^[-+]?(?:0[xX][0-9A-Fa-f]+|0[bB][01]+|0[0-7]+|\d+)$/.test(trimmed)) {
    return undefined;
  }
  const sign = trimmed.startsWith('-') ? -1n : 1n;
  const unsigned = trimmed.replace(/^[-+]/, '');
  if (/^0\d+$/.test(unsigned) && !/^0[0-7]+$/.test(unsigned)) {
    return undefined;
  }
  let magnitude: bigint;
  if (/^0[xX]/.test(unsigned)) {
    magnitude = BigInt(unsigned);
  } else if (/^0[bB]/.test(unsigned)) {
    magnitude = BigInt(unsigned);
  } else if (/^0[0-7]+$/.test(unsigned) && unsigned.length > 1) {
    magnitude = BigInt(`0o${unsigned.slice(1)}`);
  } else {
    magnitude = BigInt(unsigned);
  }
  const parsed = sign * magnitude;
  if (parsed < -2147483648n || parsed > 0xffffffffn) {
    return undefined;
  }
  return Number(parsed);
}

function integerFitsImmediateKind(value: number, kind: ImmediateKind): boolean {
  if (kind === 'imm32') {
    return true;
  }
  if (kind === 'uimm16') {
    return integerFitsRange(value, 0, 0xffff);
  }
  return integerFitsRange(signed32ImmediateValue(value), -32768, 32767);
}

function integerFitsRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

function signed32ImmediateValue(value: number): number {
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

function isFloatLiteral(value: string): boolean {
  return /^[-+]?(?:(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?|\d+[eE][-+]?\d+|\d+)$/.test(value.trim());
}

function isCharLiteral(value: string): boolean {
  return /^'(?:[^'\\]|\\.)'$/.test(value.trim());
}

function isReservedIdentifier(value: string): boolean {
  const lower = value.toLowerCase();
  return instructions[lower] !== undefined || directives.has(lower) || isRegister(value);
}

function resolveEqvSymbolInScope(name: string, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): MipsSymbol | undefined {
  return activeMacro?.eqvSymbols.get(name) ?? eqvSymbols.get(name);
}

function collectUndeclaredSymbolDiagnostics(document: TextDocument, parsed: MipsParseResult, diagnostics: Diagnostic[], skippedRanges: Set<string>): void {
  const reported = new Set<string>();
  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const original = lineAt(document, lineNumber).text;
    const commentIndex = findCommentIndex(original);
    const code = commentIndex >= 0 ? original.slice(0, commentIndex) : original;
    const stringRanges = getStringRanges(code);
    const numericRanges = getNumericLikeRanges(code);
    const executableToken = executableTokenRange(code, lineNumber);
    if (shouldSkipUndeclaredCheckForDirective(document, executableToken)) {
      continue;
    }
    const macroCall = macroCallAtLine(parsed, document, lineNumber, code);
    const tokenRegex = /%?[A-Za-z_.$][\w.$]*|\$[A-Za-z0-9_]+/g;
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(code))) {
      const token = match[0];
      const range = Range.create(lineNumber, match.index, lineNumber, match.index + token.length);
      const key = rangeKey(range);
      if (
        skippedRanges.has(key) ||
        reported.has(key) ||
        isInsideAnyRange(match.index, stringRanges) ||
        isInsideAnyRange(match.index, numericRanges) ||
        isDeclarationRange(parsed, range) ||
        (executableToken && rangesEqual(executableToken, range))
      ) {
        continue;
      }

      if (token.startsWith('$')) {
        continue;
      }
      if (token.startsWith('.')) {
        continue;
      }
      if (instructions[token.toLowerCase()]) {
        continue;
      }
      if (parsed.macros.has(token)) {
        continue;
      }
      if (macroCall && isMacroLabelArgument(document, macroCall, token)) {
        continue;
      }

      if (token.startsWith('%')) {
        if (!findMacroParamAtPosition(parsed, token, range.start)) {
          diagnostics.push(makeDiagnostic(range, `Use of undeclared macro parameter '${token}'.`, DiagnosticSeverity.Error, 'undeclared-symbol'));
          reported.add(key);
        }
        continue;
      }

      const symbol = resolveSymbolAtPosition(parsed, token, range.start);
      if (!symbol) {
        diagnostics.push(makeDiagnostic(range, `Use of undeclared symbol '${token}'.`, DiagnosticSeverity.Error, 'undeclared-symbol'));
        reported.add(key);
      } else if (symbol.kind === 'eqv' && !isDeclaredBefore(symbol, range.start)) {
        diagnostics.push(makeDiagnostic(range, `.eqv symbol '${token}' is used before it is defined. MARS .eqv substitutions only apply after the directive.`, DiagnosticSeverity.Error, 'eqv-forward-reference'));
        reported.add(key);
      }
    }
  }
}

function executableTokenRange(code: string, lineNumber: number): Range | undefined {
  let remaining = code;
  let offset = 0;
  while (true) {
    const labelMatch = remaining.match(/^\s*([A-Za-z_.$][\w.$]*):/);
    if (!labelMatch) {
      break;
    }
    offset += labelMatch[0].length;
    remaining = remaining.slice(labelMatch[0].length);
  }
  const tokenMatch = remaining.match(/^\s*([A-Za-z_.$][\w.$]*|\.[A-Za-z_][\w.]*)/);
  if (!tokenMatch) {
    return undefined;
  }
  const start = offset + tokenMatch[0].indexOf(tokenMatch[1]);
  return Range.create(lineNumber, start, lineNumber, start + tokenMatch[1].length);
}

function isDeclarationRange(parsed: MipsParseResult, range: Range): boolean {
  return [
    ...allMacros(parsed).map((macro) => macro.selectionRange),
    ...allMacroParams(parsed).map((param) => param.selectionRange),
    ...allSymbols(parsed).map((symbol) => symbol.selectionRange)
  ].some((declarationRange) => rangesEqual(declarationRange, range));
}

function macroCallAtLine(parsed: MipsParseResult, document: TextDocument, lineNumber: number, code: string): { macro: MipsMacro; operands: string[] } | undefined {
  const executableToken = executableTokenRange(code, lineNumber);
  if (!executableToken) {
    return undefined;
  }
  const name = document.getText(executableToken);
  const overloads = parsed.macros.get(name);
  if (!overloads?.length) {
    return undefined;
  }
  const operandText = code.slice(executableToken.end.character).trim();
  const operands = parseMacroArguments(operandText);
  const macro = overloads.find((candidate) => candidate.params.length === operands.length) ?? overloads[0];
  return {
    macro,
    operands
  };
}

function shouldSkipUndeclaredCheckForDirective(document: TextDocument, executableToken: Range | undefined): boolean {
  if (!executableToken) {
    return false;
  }
  const token = document.getText(executableToken).toLowerCase();
  return token.startsWith('.') && token !== '.word';
}

function isMacroLabelArgument(document: TextDocument, call: { macro: MipsMacro; operands: string[] }, token: string): boolean {
  const labelParams = macroLabelParameters(document, call.macro);
  return call.operands.some((operand, index) => {
    if (operand !== token) {
      return false;
    }
    const param = call.macro.params[index];
    return param !== undefined && labelParams.has(param);
  });
}

function isMacroArgumentToken(operand: string): boolean {
  return /^"([^"\\]|\\.)*"$/.test(operand) ||
    /^'(?:[^'\\]|\\.)'$/.test(operand) ||
    /^[%$]?[A-Za-z_.$][\w.$]*$/.test(operand) ||
    isIntegerLiteral(operand) ||
    isFloatLiteral(operand);
}

function macroLabelParameters(document: TextDocument, macro: MipsMacro): Set<string> {
  const labelParams = new Set<string>();
  if (macro.bodyEndLine === undefined) {
    return labelParams;
  }
  for (let lineNumber = macro.bodyStartLine; lineNumber <= macro.bodyEndLine; lineNumber++) {
    let code = stripComment(lineAt(document, lineNumber).text);
    for (const param of macro.params) {
      if (new RegExp(`${escapeRegExp(param)}\\s*:`).test(code)) {
        labelParams.add(param);
      }
    }

    while (true) {
      const labelMatch = code.match(/^\s*(?:[A-Za-z_.$][\w.$]*|%[A-Za-z_.$][\w.$]*):/);
      if (!labelMatch) {
        break;
      }
      code = code.slice(labelMatch[0].length);
    }

    const trimmed = code.trim();
    const firstToken = trimmed.match(/^([A-Za-z_.$][\w.$]*)/);
    if (!firstToken) {
      continue;
    }
    const instruction = instructions[firstToken[1].toLowerCase()];
    if (!instruction) {
      continue;
    }
    const operands = parseOperands(trimmed.slice(firstToken[0].length).trim());
    const target = labelOperand(instruction, operands);
    if (target?.startsWith('%') && macro.params.includes(target)) {
      labelParams.add(target);
    }
  }
  return labelParams;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rangeKey(range: Range): string {
  return `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}

function rangesEqual(left: Range, right: Range): boolean {
  return left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character;
}

function isDeclaredBefore(symbol: MipsSymbol, position: Position): boolean {
  return symbol.selectionRange.start.line < position.line ||
    (symbol.selectionRange.start.line === position.line && symbol.selectionRange.start.character <= position.character);
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

function resolveReferenceSymbol(
  name: string,
  macro: MipsMacro | undefined,
  labels: Map<string, MipsSymbol>,
  dataSymbols: Map<string, MipsSymbol>
): MipsSymbol | undefined {
  return macro?.labels.get(name) ?? macro?.dataSymbols.get(name) ?? labels.get(name) ?? dataSymbols.get(name);
}

function containsPosition(range: Range, position: Position): boolean {
  const afterStart = position.line > range.start.line || (position.line === range.start.line && position.character >= range.start.character);
  const beforeEnd = position.line < range.end.line || (position.line === range.end.line && position.character <= range.end.character);
  return afterStart && beforeEnd;
}
