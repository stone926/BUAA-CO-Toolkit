import {
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { containsPosition, lineAt, makeDiagnostic, rangeOfText, rangesEqual } from '../common/lsp';
import { CoSettings } from '../common/settings';
import {
  instructionWritesRegister,
  isMacroArgumentToken,
  labelOperand,
  usesMarsPseudoInstructionForm,
  validateInstruction
} from './instructionValidation';
import {
  directives,
  instructions,
  instructionMeta,
  isFloatingPointRegister,
  isRegister
} from './resources';
import {
  escapeRegExp,
  findCommentIndex,
  getNumericLikeRanges,
  getStringRanges,
  isFloatLiteral,
  isInsideAnyRange,
  isIntegerLiteral,
  isNonNegativeIntegerLiteral,
  isSymbolLike,
  parseIntegerLiteral,
  parseMacroArguments,
  parseOperands,
  stripComment
} from './syntax';
import type {
  MipsLabelReference,
  MipsLine,
  MipsMacro,
  MipsParseOptions,
  MipsParseResult,
  MipsSymbol
} from './model';

export type {
  MipsLabelReference,
  MipsLine,
  MipsMacro,
  MipsParseOptions,
  MipsParseResult,
  MipsSymbol
} from './model';

export {
  findCommentIndex,
  formatMipsLine,
  getStringRanges,
  isInsideAnyRange,
  parseIntegerLiteral,
  parseMacroArguments,
  parseOperands,
  stripComment
} from './syntax';

type MipsSection = 'text' | 'data' | 'other';

interface MipsSymbolScope {
  labels: Map<string, MipsSymbol>;
  dataSymbols: Map<string, MipsSymbol>;
  eqvSymbols: Map<string, MipsSymbol>;
}

// 从资源文件加载指令元数据
const STORAGE_DIRECTIVES = new Set(instructionMeta.storageDirectives);
const CO_FIXED_SECTION_DIRECTIVES = new Set(instructionMeta.coFixedSectionDirectives);
const SECTION_DIRECTIVES = new Map(Object.entries(instructionMeta.sectionDirectives));
const SECTION_ADDRESS_RANGES = new Map<string, { min: number; max: number; label: string }>([
  ['.data', { min: 0x00000000, max: 0x00002fff, label: '0x00000000-0x00002fff' }],
  ['.text', { min: 0x00003000, max: 0x00006fff, label: '0x00003000-0x00006fff' }]
]);

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
  let v0BeforeMacro: boolean | undefined;
  let activeMacro: MipsMacro | undefined;
  let hasSyscall = false;
  let v0Initialized = false;

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
        diagnostics.push(makeDiagnostic(selectionRange, `符号 '${name}' 与保留的 MIPS 关键字冲突。`, DiagnosticSeverity.Error, 'reserved-symbol'));
      }
      if (symbolScopeHas(scope, name)) {
        diagnostics.push(makeDiagnostic(selectionRange, `重复的符号 '${name}'。`, DiagnosticSeverity.Error, 'duplicate-symbol'));
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
        diagnostics.push(makeDiagnostic(selectionRange, `重复的符号 '${name}'。`, DiagnosticSeverity.Error, 'duplicate-symbol'));
      } else {
        scope.eqvSymbols.set(name, symbol);
      }
    }

    // 从资源文件检查段切换指令
    for (const [directive, targetSection] of SECTION_DIRECTIVES) {
      if (trimmed.startsWith(directive)) {
        section = targetSection as MipsSection;
        break;
      }
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
        diagnostics.push(makeDiagnostic(selectionRange, `嵌套宏 '${name}' 不受此语言服务支持。`, DiagnosticSeverity.Warning, 'nested-macro'));
      }
      const overloads = macros.get(name) ?? [];
      if (overloads.some((overload) => overload.params.length === macro.params.length)) {
        diagnostics.push(makeDiagnostic(selectionRange, `重复的宏 '${name}'，具有 ${macro.params.length} 个参数。`, DiagnosticSeverity.Error, 'duplicate-macro'));
      } else {
        overloads.push(macro);
        macros.set(name, overloads);
      }
      sectionBeforeMacro = section;
      v0BeforeMacro = v0Initialized;
      v0Initialized = false;
      activeMacro = macro;
      for (const param of params) {
        const paramIndex = original.indexOf(param);
        if (paramIndex >= 0) {
          if (macro.paramSymbols.has(param)) {
            diagnostics.push(makeDiagnostic(Range.create(lineNumber, paramIndex, lineNumber, paramIndex + param.length), `重复的宏参数 '${param}'。`, DiagnosticSeverity.Error, 'duplicate-macro-parameter'));
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
        v0Initialized = v0BeforeMacro ?? v0Initialized;
        v0BeforeMacro = undefined;
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
        diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, firstToken[1]), `未知的指令 '${firstToken[1]}'。`, DiagnosticSeverity.Error, 'unknown-directive'));
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
      diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, firstToken[1]), `未知的指令或宏 '${firstToken[1]}'。`, DiagnosticSeverity.Error, 'unknown-instruction'));
      continue;
    }

    if (section === 'data' && instruction) {
      diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, firstToken[1]), `指令 '${firstToken[1]}' 不能出现在数据段中。请先切换到 .text。`, DiagnosticSeverity.Error, 'instruction-in-data'));
    }

    if (!instruction && macroOverloads?.length) {
      const operands = parseMacroArguments(trimmed.slice(firstToken[0].length).trim());
      for (const operand of operands) {
        if (!isMacroArgumentToken(operand)) {
          diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, operand), `宏参数 '${operand}' 必须是单个 MARS 语言元素；内存操作数如 4($t0) 不是有效的宏参数。`, DiagnosticSeverity.Error, 'macro-argument'));
        }
      }
      if (!macroOverloads.some((macro) => macro.params.length === operands.length)) {
        const counts = [...new Set(macroOverloads.map((macro) => macro.params.length))].sort((a, b) => a - b).join('/');
        diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, firstToken[1]), `宏 '${firstToken[1]}' 期望 ${counts} 个参数，实际得到 ${operands.length} 个。`, DiagnosticSeverity.Error, 'macro-argument-count'));
      }
    }

    if (instruction) {
      const operandText = trimmed.slice(firstToken[0].length).trim();
      const operands = parseOperands(operandText);
      if (mnemonic === 'syscall') {
        hasSyscall = true;
        if (profile === 'P2' && !v0Initialized) {
          diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, firstToken[1]), 'P2 syscall uses $v0 as the service number, but $v0 has not been initialized since the previous syscall.', DiagnosticSeverity.Warning, 'syscall-v0-uninitialized'));
        }
      }
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
      if (mnemonic === 'syscall') {
        v0Initialized = false;
      } else if (instructionWritesRegister(mnemonic, operands, '$v0')) {
        v0Initialized = true;
      }
    }
  }

  if (activeMacro) {
    activeMacro.range = Range.create(activeMacro.range.start, lineAt(document, document.lineCount - 1).range.end);
    diagnostics.push(makeDiagnostic(activeMacro.selectionRange, `宏 '${activeMacro.name}' 缺少 .end_macro。`, DiagnosticSeverity.Error, 'macro-unclosed'));
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
      diagnostics.push(makeDiagnostic(range, `找不到标签或数据符号 '${reference.operand}'。`, DiagnosticSeverity.Error, 'missing-label'));
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

function validateDirective(document: TextDocument, lineNumber: number, trimmed: string, section: MipsSection, activeMacro: MipsMacro | undefined, diagnostics: Diagnostic[]): void {
  const firstToken = trimmed.match(/^(\.[A-Za-z_][\w.]*)/);
  if (!firstToken) {
    return;
  }
  const directive = firstToken[1].toLowerCase();
  const operandText = trimmed.slice(firstToken[0].length).trim();
  const directiveRange = rangeOfText(document, lineNumber, firstToken[1]);
  if (STORAGE_DIRECTIVES.has(directive) && section !== 'data') {
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
      validateSectionAddressRange(document, lineNumber, directive, operandText, diagnostics);
      if (operandText && CO_FIXED_SECTION_DIRECTIVES.has(directive)) {
        diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, operandText), 'BUAA CO uses the CompactDataAtZero memory configuration; do not pass a custom address to .data or .text.', DiagnosticSeverity.Error, 'co-section-address'));
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
    diagnostics.push(makeDiagnostic(selectionRange, `宏名 '${name}' 与保留的 MIPS 关键字冲突。`, DiagnosticSeverity.Error, 'reserved-symbol'));
  }
  for (const param of params) {
    const paramIndex = lineAt(document, lineNumber).text.indexOf(param);
    const range = paramIndex >= 0 ? Range.create(lineNumber, paramIndex, lineNumber, paramIndex + param.length) : selectionRange;
    if (!/^[%$][A-Za-z_.$][\w.$]*$/.test(param)) {
      diagnostics.push(makeDiagnostic(range, `宏参数 '${param}' 必须以 % 或 $ 开头，并使用标识符字符。`, DiagnosticSeverity.Error, 'macro-parameter'));
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

function validateSectionAddressRange(document: TextDocument, lineNumber: number, directive: string, operandText: string, diagnostics: Diagnostic[]): void {
  if (!operandText) {
    return;
  }
  const expected = SECTION_ADDRESS_RANGES.get(directive);
  if (!expected) {
    return;
  }
  const address = parseIntegerLiteral(operandText);
  if (address === undefined) {
    return;
  }
  if (address < expected.min || address > expected.max) {
    diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, operandText), `${directive} address ${operandText} is outside the BUAA CO CompactDataAtZero range ${expected.label}.`, DiagnosticSeverity.Warning, 'section-address-range'));
  }
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
  const operand = operands[0];
  if (!(isNonNegativeIntegerLiteral(operand) || Boolean(activeMacro?.paramSymbols.has(operand)))) {
    diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, operand), `${directive} expects one non-negative integer operand.`, DiagnosticSeverity.Error, 'directive-operand'));
    return;
  }

  const value = parseIntegerLiteral(operand);
  if (value === undefined) {
    return;
  }
  if (directive === '.space' && value % 4 !== 0) {
    diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, operand), '.space size is usually a multiple of 4 in BUAA CO so later word accesses stay aligned.', DiagnosticSeverity.Warning, 'space-alignment'));
  }
  if (directive === '.align' && value > 3) {
    diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, operand), `.align ${value} means 2^${value} byte alignment; this is rarely needed in BUAA CO.`, DiagnosticSeverity.Warning, 'align-large'));
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

function validateRegisters(document: TextDocument, lineNumber: number, line: string, activeMacro: MipsMacro | undefined, diagnostics: Diagnostic[]): void {
  const code = stripComment(line);
  const regex = /\$[A-Za-z0-9_]+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code))) {
    const reg = match[0];
    if (activeMacro?.paramSymbols.has(reg)) {
      continue;
    }
    if (!isRegister(reg) && !isFloatingPointRegister(reg)) {
      diagnostics.push(makeDiagnostic(Range.create(lineNumber, match.index, lineNumber, match.index + reg.length), `未知的寄存器 '${reg}'。`, DiagnosticSeverity.Error, 'unknown-register'));
    }
  }
}

function splitRepeatOperand(operand: string): [string, string | undefined] {
  const parts = operand.split(':').map((part) => part.trim());
  return [parts[0], parts.length > 1 ? parts.slice(1).join(':').trim() : undefined];
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
          diagnostics.push(makeDiagnostic(range, `使用未声明的宏参数 '${token}'。`, DiagnosticSeverity.Error, 'undeclared-symbol'));
          reported.add(key);
        }
        continue;
      }

      const symbol = resolveSymbolAtPosition(parsed, token, range.start);
      if (!symbol) {
        diagnostics.push(makeDiagnostic(range, `使用未声明的符号 '${token}'。`, DiagnosticSeverity.Error, 'undeclared-symbol'));
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

function rangeKey(range: Range): string {
  return `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}

function isDeclaredBefore(symbol: MipsSymbol, position: Position): boolean {
  return symbol.selectionRange.start.line < position.line ||
    (symbol.selectionRange.start.line === position.line && symbol.selectionRange.start.character <= position.character);
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
