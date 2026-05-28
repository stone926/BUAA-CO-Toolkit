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
  let section: 'text' | 'data' | 'other' = 'text';
  let sectionBeforeMacro: 'text' | 'data' | 'other' | undefined;
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
        .map((item) => (item.startsWith('%') ? item : `%${item}`));
      const selectionRange = Range.create(lineNumber, nameStart, lineNumber, nameStart + name.length);
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
      }
      overloads.push(macro);
      macros.set(name, overloads);
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

    validateRegisters(document, lineNumber, original, diagnostics);

    const firstToken = trimmed.match(/^([A-Za-z_.$][\w.$]*|\.[A-Za-z_][\w.]*)/);
    if (!firstToken) {
      continue;
    }
    const mnemonic = firstToken[1].toLowerCase();
    if (mnemonic.startsWith('.')) {
      if (!directives.has(mnemonic)) {
        diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, firstToken[1]), `Unknown directive '${firstToken[1]}'.`, DiagnosticSeverity.Warning, 'unknown-directive'));
      }
      continue;
    }

    const instruction = instructions[mnemonic];
    const macroOverloads = macros.get(firstToken[1]);
    if (!instruction && !macroOverloads?.length) {
      diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, firstToken[1]), `Unknown instruction or macro '${firstToken[1]}'.`, DiagnosticSeverity.Error, 'unknown-instruction'));
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
      validateInstruction(document, lineNumber, instruction, operands, profile, settings, options, diagnostics);
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
  const normalized = text.trim().replace(/^\(/, '').replace(/\)$/, '');
  if (!normalized) {
    return [];
  }
  return normalized
    .split(',')
    .map((operand) => operand.trim())
    .filter(Boolean);
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

export function isInsideAnyRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function validateInstruction(
  document: TextDocument,
  lineNumber: number,
  instruction: MipsInstruction,
  operands: string[],
  profile: ProjectProfile,
  settings: CoSettings,
  options: MipsParseOptions,
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

function validateRegisters(document: TextDocument, lineNumber: number, line: string, diagnostics: Diagnostic[]): void {
  const code = stripComment(line);
  const regex = /\$[A-Za-z0-9_]+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code))) {
    const reg = match[0];
    if (!isRegister(reg)) {
      diagnostics.push(makeDiagnostic(Range.create(lineNumber, match.index, lineNumber, match.index + reg.length), `Unknown register '${reg}'.`, DiagnosticSeverity.Error, 'unknown-register'));
    }
  }
}

function collectUndeclaredSymbolDiagnostics(document: TextDocument, parsed: MipsParseResult, diagnostics: Diagnostic[], skippedRanges: Set<string>): void {
  const reported = new Set<string>();
  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const original = lineAt(document, lineNumber).text;
    const commentIndex = findCommentIndex(original);
    const code = commentIndex >= 0 ? original.slice(0, commentIndex) : original;
    const stringRanges = getStringRanges(code);
    const executableToken = executableTokenRange(code, lineNumber);
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

      if (!resolveSymbolAtPosition(parsed, token, range.start)) {
        diagnostics.push(makeDiagnostic(range, `Use of undeclared symbol '${token}'.`, DiagnosticSeverity.Error, 'undeclared-symbol'));
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
  const operands = parseOperands(operandText);
  const macro = overloads.find((candidate) => candidate.params.length === operands.length) ?? overloads[0];
  return {
    macro,
    operands
  };
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
