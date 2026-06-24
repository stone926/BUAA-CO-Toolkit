import {
  Diagnostic,
  DiagnosticSeverity,
  Range
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ProjectProfile } from '../../projectProfile';
import { makeDiagnostic, rangeOfText } from '../common/lsp';
import { CoSettings } from '../common/settings';
import type { MipsLabelPlusImmediateAst, MipsOperandAst } from './ast';
import { MipsMacro, MipsParseOptions, MipsSymbol } from './model';
import {
  canonicalRegister,
  cp0RegistersByNumber,
  instructionMeta,
  isRegister,
  MipsInstruction,
  pseudoForms,
  shouldWarnPseudoInstruction
} from './resources';
import {
  integerFitsRange,
  isFloatLiteral,
  isIntegerLiteral,
  parseCharLiteral,
  parseIntegerLiteral,
  signed32ImmediateValue
} from './syntax';
import {
  isMipsMacroArgumentTokenText,
  splitFormatMnemonic,
  stripLeadingDollar
} from './operandAst';

// 从资源文件加载内存对齐要求
const MEMORY_ALIGNMENT = new Map<string, number>(
  Object.entries(instructionMeta.memoryAlignment)
);

type ImmediateKind = 'imm32' | 'simm16' | 'uimm16';
export type MipsInstructionOperand = MipsOperandAst;
interface MemoryOperandParts {
  offset: MipsOperandAst;
  base: MipsOperandAst;
}

export function validateInstruction(
  document: TextDocument,
  lineNumber: number,
  instruction: MipsInstruction,
  operands: MipsOperandAst[],
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
  validateMemoryAlignment(document, lineNumber, instruction.mnemonic, operands, activeMacro, eqvSymbols, diagnostics);
  validateCp0Access(document, lineNumber, instruction.mnemonic, operands, activeMacro, eqvSymbols, diagnostics);

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

export function usesMarsPseudoInstructionForm(mnemonic: string, operands: readonly MipsInstructionOperand[], activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  if (
    pseudoForms.registerRegisterImmediate.has(mnemonic) &&
    operands.length === 3 &&
    isRegisterOperand(operands[0], activeMacro, eqvSymbols) &&
    isRegisterOperand(operands[1], activeMacro, eqvSymbols) &&
    isImmediateOperand(operands[2], activeMacro, eqvSymbols, 'imm32')
  ) {
    return true;
  }

  if (
    pseudoForms.bitwiseImmediate.has(mnemonic) &&
    operands.length >= 2 &&
    operands.length <= 3 &&
    isRegisterOperand(operands[0], activeMacro, eqvSymbols) &&
    (operands.length === 2 || isRegisterOperand(operands[1], activeMacro, eqvSymbols)) &&
    isImmediateOperand(operands[operands.length - 1], activeMacro, eqvSymbols, 'uimm16')
  ) {
    return true;
  }

  if (
    pseudoForms.signedImmediateExpansion.has(mnemonic) &&
    operands.length === 3 &&
    isRegisterOperand(operands[0], activeMacro, eqvSymbols) &&
    isRegisterOperand(operands[1], activeMacro, eqvSymbols) &&
    isImmediateOperand(operands[2], activeMacro, eqvSymbols, 'imm32') &&
    !isImmediateOperand(operands[2], activeMacro, eqvSymbols, 'simm16')
  ) {
    return true;
  }

  if (
    pseudoForms.unsignedImmediateExpansion.has(mnemonic) &&
    (
      (
        operands.length === 3 &&
        isRegisterOperand(operands[0], activeMacro, eqvSymbols) &&
        isRegisterOperand(operands[1], activeMacro, eqvSymbols) &&
        isImmediateOperand(operands[2], activeMacro, eqvSymbols, 'imm32') &&
        !isImmediateOperand(operands[2], activeMacro, eqvSymbols, 'uimm16')
      ) ||
      (
        operands.length === 2 &&
        isRegisterOperand(operands[0], activeMacro, eqvSymbols) &&
        isImmediateOperand(operands[1], activeMacro, eqvSymbols, 'imm32')
      )
    )
  ) {
    return true;
  }

  if (
    pseudoForms.threeOperandImmediate.has(mnemonic) &&
    operands.length === 3 &&
    isRegisterOperand(operands[0], activeMacro, eqvSymbols) &&
    isRegisterOperand(operands[1], activeMacro, eqvSymbols) &&
    isImmediateOperand(operands[2], activeMacro, eqvSymbols, 'imm32')
  ) {
    return true;
  }

  if (
    pseudoForms.threeRegisterPseudo.has(mnemonic) &&
    operands.length === 3 &&
    operands.every((operand) => isRegisterOperand(operand, activeMacro, eqvSymbols))
  ) {
    return true;
  }

  if (
    pseudoForms.branchImmediateCompare.has(mnemonic) &&
    operands.length === 3 &&
    isRegisterOperand(operands[0], activeMacro, eqvSymbols) &&
    isImmediateOperand(operands[1], activeMacro, eqvSymbols, 'imm32') &&
    isLabelOperand(operands[2], activeMacro)
  ) {
    return true;
  }

  if (
    pseudoForms.loadStorePseudoOffset.has(mnemonic) &&
    operands.length === 2 &&
    isRegisterOperand(operands[0], activeMacro, eqvSymbols) &&
    isMemoryOperandWithPseudoOffset(operands[1], activeMacro, eqvSymbols)
  ) {
    return true;
  }

  return false;
}

export function instructionWritesRegister(mnemonic: string, operands: readonly MipsInstructionOperand[], register: string): boolean {
  const canonical = canonicalRegister(register);
  if (!operands.length) {
    return false;
  }
  // 从资源文件检查指令是否写入第一个操作数
  const writesFirst = instructionMeta.writesFirstOperand[mnemonic];
  if (writesFirst === false) {
    return false;
  }
  if (mnemonic === 'jalr') {
    return operands.length === 2 && registerOperandMatches(operands[0], canonical);
  }
  return registerOperandMatches(operands[0], canonical);
}

export function labelOperand(instruction: MipsInstruction, operands: readonly MipsInstructionOperand[]): string | undefined {
  if (instruction.labelOperand === 'first') {
    return operands[0] ? operandText(operands[0]) : undefined;
  }
  if (instruction.labelOperand === 'second') {
    return operands[1] ? operandText(operands[1]) : undefined;
  }
  if (instruction.labelOperand === 'last') {
    const operand = operands[operands.length - 1];
    return operand ? operandText(operand) : undefined;
  }
  return undefined;
}

export function isMacroArgumentToken(operand: string): boolean {
  return isMipsMacroArgumentTokenText(operand) ||
    isIntegerLiteral(operand) ||
    isFloatLiteral(operand);
}

function validateInstructionOperands(
  document: TextDocument,
  lineNumber: number,
  instruction: MipsInstruction,
  operands: readonly MipsInstructionOperand[],
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
  diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, instruction.mnemonic), `${instruction.mnemonic} 操作数与 MARS 格式不匹配：${instruction.formats.join(' | ')}`, DiagnosticSeverity.Error, 'operand-type'));
}

function validateMemoryAlignment(
  document: TextDocument,
  lineNumber: number,
  mnemonic: string,
  operands: readonly MipsInstructionOperand[],
  activeMacro: MipsMacro | undefined,
  eqvSymbols: Map<string, MipsSymbol>,
  diagnostics: Diagnostic[]
): void {
  const alignment = MEMORY_ALIGNMENT.get(mnemonic);
  if (!alignment || operands.length !== 2) {
    return;
  }
  const offset = constantMemoryOffset(operands[1], activeMacro, eqvSymbols);
  if (offset === undefined || offset % alignment === 0) {
    return;
  }
  diagnostics.push(
    makeDiagnostic(
      operandRange(document, lineNumber, operands[1]),
      `${mnemonic} requires a ${alignment}-byte aligned constant address/offset; ${offset} is not divisible by ${alignment}.`,
      DiagnosticSeverity.Warning,
      'memory-alignment'
    )
  );
}

function constantMemoryOffset(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): number | undefined {
  if (isMacroOrEqvOperand(operand, activeMacro, eqvSymbols) || isSymbolOperand(operand)) {
    return undefined;
  }
  const memory = memoryOperand(operand);
  const offset = memory?.offset ?? operand;
  if (isMacroOrEqvOperand(offset, activeMacro, eqvSymbols) || isSymbolOperand(offset)) {
    return undefined;
  }
  const value = integerOperandValue(offset);
  return value === undefined ? undefined : signed32ImmediateValue(value);
}

function validateCp0Access(
  document: TextDocument,
  lineNumber: number,
  mnemonic: string,
  operands: readonly MipsInstructionOperand[],
  activeMacro: MipsMacro | undefined,
  eqvSymbols: Map<string, MipsSymbol>,
  diagnostics: Diagnostic[]
): void {
  if (mnemonic !== 'mtc0' || operands.length !== 2) {
    return;
  }
  const number = cp0RegisterNumber(operands[1], activeMacro, eqvSymbols);
  const register = number === undefined ? undefined : cp0RegistersByNumber.get(number);
  if (!register || register.writableByTest !== false) {
    return;
  }
  diagnostics.push(
    makeDiagnostic(
      operandRange(document, lineNumber, operands[1]),
      `BUAA CO 测试不写入 CP0 $${register.number} (${register.name})；${register.description}`,
      DiagnosticSeverity.Warning,
      'cp0-write'
    )
  );
}

function registerOperandMatches(operand: MipsInstructionOperand, canonical: string): boolean {
  return isRegister(operand.text) && canonicalRegister(operand.text) === canonical;
}

function instructionPattern(format: string): string[] {
  const split = splitFormatMnemonic(format);
  if (!split) {
    return [];
  }
  return splitInstructionFormatOperands(split.operands);
}

function splitInstructionFormatOperands(text: string): string[] {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(',').map((operand) => operand.trim()).filter(Boolean) : [];
}

function operandMatchesPattern(operand: MipsInstructionOperand, pattern: string, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  if (pattern === '$rd' || pattern === '$rs' || pattern === '$rt' || pattern === '$base') {
    return isRegisterOperand(operand, activeMacro, eqvSymbols);
  }
  if (pattern === 'cp0') {
    return isCp0RegisterOperand(operand, activeMacro, eqvSymbols);
  }
  if (pattern === 'offset($base)') {
    return isMemoryOperand(operand, activeMacro, eqvSymbols, 'simm16');
  }
  if (pattern === '($base)') {
    return isZeroOffsetMemoryOperand(operand, activeMacro, eqvSymbols);
  }
  if (pattern === 'simm16($base)') {
    return isMemoryOperandWithImmediateOffset(operand, activeMacro, eqvSymbols, 'simm16');
  }
  if (pattern === 'uimm16($base)') {
    return isMemoryOperandWithImmediateOffset(operand, activeMacro, eqvSymbols, 'uimm16');
  }
  if (pattern === 'imm32($base)') {
    return isMemoryOperandWithImmediateOffset(operand, activeMacro, eqvSymbols, 'imm32');
  }
  if (pattern === 'label($base)') {
    return isMemoryOperandWithLabelOffset(operand, activeMacro, eqvSymbols);
  }
  if (pattern === 'label+imm32') {
    return isLabelPlusImmediateOperand(operand, activeMacro, eqvSymbols);
  }
  if (pattern === 'label+imm32($base)') {
    return isMemoryOperandWithLabelPlusImmediateOffset(operand, activeMacro, eqvSymbols);
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

function isRegisterOperand(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  if (isMacroOrEqvOperand(operand, activeMacro, eqvSymbols)) {
    return true;
  }
  if (operand.kind !== 'register') {
    return false;
  }
  return isRegister(operand.text);
}

function isCp0RegisterOperand(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  return isMacroOrEqvOperand(operand, activeMacro, eqvSymbols) || cp0RegisterNumber(operand, activeMacro, eqvSymbols) !== undefined;
}

function cp0RegisterNumber(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): number | undefined {
  if (isMacroOrEqvOperand(operand, activeMacro, eqvSymbols)) {
    return undefined;
  }
  const value = operand.kind === 'integer'
    ? operand.value
    : parseIntegerOrCharLiteral(stripLeadingDollar(operandText(operand)));
  return value !== undefined && cp0RegistersByNumber.has(value) ? value : undefined;
}

function isImmediateOperand(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>, kind: ImmediateKind = 'imm32'): boolean {
  if (isMacroOrEqvOperand(operand, activeMacro, eqvSymbols)) {
    return true;
  }
  if (operand.kind !== 'integer') {
    return false;
  }
  const value = integerOperandValue(operand);
  return value !== undefined && integerFitsImmediateKind(value, kind);
}

function isShiftAmountOperand(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  if (isMacroOrEqvOperand(operand, activeMacro, eqvSymbols)) {
    return true;
  }
  if (operand.kind !== 'integer') {
    return false;
  }
  const value = integerOperandValue(operand);
  return value !== undefined && integerFitsRange(value, 0, 31);
}

function isBitPositionOperand(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  return isShiftAmountOperand(operand, activeMacro, eqvSymbols);
}

function isBitSizeOperand(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  if (isMacroOrEqvOperand(operand, activeMacro, eqvSymbols)) {
    return true;
  }
  if (operand.kind !== 'integer') {
    return false;
  }
  const value = integerOperandValue(operand);
  return value !== undefined && value >= 1 && value <= 32;
}

function isMemoryOperand(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>, offsetKind: ImmediateKind = 'simm16'): boolean {
  const memory = memoryOperand(operand);
  if (memory) {
    return (isImmediateOperand(memory.offset, activeMacro, eqvSymbols, offsetKind) || isSymbolOperand(memory.offset)) &&
      isRegisterOperand(memory.base, activeMacro, eqvSymbols);
  }
  return isSymbolOperand(operand) || isImmediateOperand(operand, activeMacro, eqvSymbols, offsetKind);
}

function isZeroOffsetMemoryOperand(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  const memory = memoryOperand(operand);
  return Boolean(memory && isZeroIntegerOperand(memory.offset) && isRegisterOperand(memory.base, activeMacro, eqvSymbols));
}

function isMemoryOperandWithImmediateOffset(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>, offsetKind: ImmediateKind): boolean {
  const memory = memoryOperand(operand);
  return Boolean(
    memory &&
    isImmediateOperand(memory.offset, activeMacro, eqvSymbols, offsetKind) &&
    isRegisterOperand(memory.base, activeMacro, eqvSymbols)
  );
}

function isMemoryOperandWithLabelOffset(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  const memory = memoryOperand(operand);
  return Boolean(
    memory &&
    isLabelLikeOperand(memory.offset, activeMacro, eqvSymbols) &&
    isRegisterOperand(memory.base, activeMacro, eqvSymbols)
  );
}

function isMemoryOperandWithLabelPlusImmediateOffset(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  const memory = memoryOperand(operand);
  return Boolean(
    memory &&
    isLabelPlusImmediateOperand(memory.offset, activeMacro, eqvSymbols) &&
    isRegisterOperand(memory.base, activeMacro, eqvSymbols)
  );
}

function isMemoryOperandWithPseudoOffset(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  const memory = memoryOperand(operand);
  if (!memory) {
    return isImmediateOperand(operand, activeMacro, eqvSymbols, 'imm32') &&
      !isImmediateOperand(operand, activeMacro, eqvSymbols, 'simm16');
  }
  if (isZeroIntegerOperand(memory.offset) || isMacroOrEqvOperand(memory.offset, activeMacro, eqvSymbols) || isSymbolOperand(memory.offset)) {
    return false;
  }
  return isImmediateOperand(memory.offset, activeMacro, eqvSymbols, 'imm32') &&
    !isImmediateOperand(memory.offset, activeMacro, eqvSymbols, 'simm16') &&
    isRegisterOperand(memory.base, activeMacro, eqvSymbols);
}

function isLabelPlusImmediateOperand(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  if (isMacroOrEqvOperand(operand, activeMacro, eqvSymbols)) {
    return true;
  }
  const structured = labelPlusImmediateOperand(operand);
  if (structured) {
    return isLabelLikeOperand(structured.label, activeMacro, eqvSymbols) &&
      isImmediateOperand(structured.immediate, activeMacro, eqvSymbols, 'imm32');
  }
  return false;
}

function isLabelLikeOperand(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  return isSymbolOperand(operand) || isMacroOrEqvOperand(operand, activeMacro, eqvSymbols);
}

function isLabelOperand(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined): boolean {
  return isSymbolOperand(operand) || Boolean(activeMacro?.paramSymbols.has(operandText(operand)));
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

function parseIntegerOrCharLiteral(operand: string): number | undefined {
  const charValue = parseCharLiteral(operand);
  return charValue === undefined ? parseIntegerLiteral(operand) : charValue;
}

function integerOperandValue(operand: MipsInstructionOperand): number | undefined {
  return operand.kind === 'integer' ? operand.value : undefined;
}

function isZeroIntegerOperand(operand: MipsInstructionOperand): boolean {
  return integerOperandValue(operand) === 0;
}

function operandText(operand: MipsInstructionOperand | undefined): string {
  return operand?.text ?? '';
}

function operandRange(document: TextDocument, lineNumber: number, operand: MipsInstructionOperand): Range {
  return operand.range;
}

function memoryOperand(operand: MipsInstructionOperand): MemoryOperandParts | undefined {
  return operand.kind === 'memory' ? operand : undefined;
}

function labelPlusImmediateOperand(operand: MipsInstructionOperand): MipsLabelPlusImmediateAst | undefined {
  return operand.kind === 'expression' ? operand.labelPlusImmediate : undefined;
}

function isMacroOrEqvOperand(operand: MipsInstructionOperand, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  const text = operandText(operand);
  return Boolean(activeMacro?.paramSymbols.has(text)) || eqvSymbols.has(text);
}

function isSymbolOperand(operand: MipsInstructionOperand): boolean {
  return operand.kind === 'symbol';
}
