import {
  Diagnostic,
  DiagnosticSeverity
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ProjectProfile } from '../../projectProfile';
import { makeDiagnostic, rangeOfText } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { MipsMacro, MipsParseOptions, MipsSymbol } from './model';
import {
  canonicalRegister,
  cp0RegistersByNumber,
  isRegister,
  MipsInstruction,
  pseudoForms,
  shouldWarnPseudoInstruction
} from './resources';
import {
  integerFitsRange,
  isCharLiteral,
  isFloatLiteral,
  isIntegerLiteral,
  parseIntegerLiteral,
  parseOperands,
  signed32ImmediateValue,
  isSymbolLike
} from './syntax';

const MEMORY_ALIGNMENT = new Map<string, number>([
  ['lw', 4],
  ['sw', 4],
  ['lh', 2],
  ['lhu', 2],
  ['sh', 2]
]);

type ImmediateKind = 'imm32' | 'simm16' | 'uimm16';

export function validateInstruction(
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

export function usesMarsPseudoInstructionForm(mnemonic: string, operands: string[], activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
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
    operands.length === 3 &&
    isRegisterOperand(operands[0], activeMacro, eqvSymbols) &&
    isRegisterOperand(operands[1], activeMacro, eqvSymbols) &&
    isImmediateOperand(operands[2], activeMacro, eqvSymbols, 'imm32') &&
    !isImmediateOperand(operands[2], activeMacro, eqvSymbols, 'uimm16')
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

export function instructionWritesRegister(mnemonic: string, operands: string[], register: string): boolean {
  const canonical = canonicalRegister(register);
  if (!operands.length) {
    return false;
  }
  if (['sw', 'swl', 'swr', 'sb', 'sh', 'beq', 'bne', 'bgez', 'bltz', 'blez', 'bgtz', 'bgezal', 'bltzal', 'b', 'j', 'jal', 'jr', 'syscall', 'break', 'eret', 'mtc0', 'mthi', 'mtlo', 'mult', 'multu', 'madd', 'maddu', 'msub', 'msubu'].includes(mnemonic)) {
    return false;
  }
  if (mnemonic === 'jalr') {
    return operands.length === 2 && registerOperandMatches(operands[0], canonical);
  }
  return registerOperandMatches(operands[0], canonical);
}

export function labelOperand(instruction: MipsInstruction, operands: string[]): string | undefined {
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

export function isMacroArgumentToken(operand: string): boolean {
  return /^"([^"\\]|\\.)*"$/.test(operand) ||
    /^'(?:[^'\\]|\\.)'$/.test(operand) ||
    /^[%$]?[A-Za-z_.$][\w.$]*$/.test(operand) ||
    isIntegerLiteral(operand) ||
    isFloatLiteral(operand);
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

function validateMemoryAlignment(
  document: TextDocument,
  lineNumber: number,
  mnemonic: string,
  operands: string[],
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
      rangeOfText(document, lineNumber, operands[1]),
      `${mnemonic} requires a ${alignment}-byte aligned constant address/offset; ${offset} is not divisible by ${alignment}.`,
      DiagnosticSeverity.Warning,
      'memory-alignment'
    )
  );
}

function constantMemoryOffset(operand: string, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): number | undefined {
  if (activeMacro?.paramSymbols.has(operand) || eqvSymbols.has(operand) || isSymbolLike(operand)) {
    return undefined;
  }
  const memory = operand.match(/^(.+)?\(([^()]+)\)$/);
  const offsetText = memory ? (memory[1] ?? '0').trim() : operand.trim();
  if (!offsetText || activeMacro?.paramSymbols.has(offsetText) || eqvSymbols.has(offsetText) || isSymbolLike(offsetText)) {
    return undefined;
  }
  const parsed = parseIntegerLiteral(offsetText);
  return parsed === undefined ? undefined : signed32ImmediateValue(parsed);
}

function validateCp0Access(
  document: TextDocument,
  lineNumber: number,
  mnemonic: string,
  operands: string[],
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
      rangeOfText(document, lineNumber, operands[1]),
      `BUAA CO tests do not write CP0 $${register.number} (${register.name}); ${register.description}`,
      DiagnosticSeverity.Warning,
      'cp0-write'
    )
  );
}

function registerOperandMatches(operand: string, canonical: string): boolean {
  return isRegister(operand) && canonicalRegister(operand) === canonical;
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
  if (pattern === 'cp0') {
    return isCp0RegisterOperand(operand, activeMacro, eqvSymbols);
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

function isCp0RegisterOperand(operand: string, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): boolean {
  return activeMacro?.paramSymbols.has(operand) || eqvSymbols.has(operand) || cp0RegisterNumber(operand, activeMacro, eqvSymbols) !== undefined;
}

function cp0RegisterNumber(operand: string, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): number | undefined {
  if (activeMacro?.paramSymbols.has(operand) || eqvSymbols.has(operand)) {
    return undefined;
  }
  const value = parseIntegerLiteral(operand.replace(/^\$/, ''));
  return value !== undefined && cp0RegistersByNumber.has(value) ? value : undefined;
}

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

function integerFitsImmediateKind(value: number, kind: ImmediateKind): boolean {
  if (kind === 'imm32') {
    return true;
  }
  if (kind === 'uimm16') {
    return integerFitsRange(value, 0, 0xffff);
  }
  return integerFitsRange(signed32ImmediateValue(value), -32768, 32767);
}
