// @index mips-core — Ordinary MARS COP1 operand validation, pseudo expansion and instruction encoding

import { AssemblerDiagnostic, assemblerDiagnostic, AssemblerDiagnosticCode, SourceSpan } from './diagnostics';
import { evaluateExpression } from './expression';
import { parseInstructionOperand, ParsedInstructionOperand } from './operands';
import { expandLoadStorePseudo } from './pseudo';
import { ParsedStatement } from './syntax';
import { WorkInstruction, WorkOperand, workOriginFor } from './work';
import {
  marsFpArithmetic as arithmetic, marsFpUnary as unary, marsFpRounding as rounding,
  marsFpComparison as comparison, marsFpMemoryOpcodes as memoryOpcodes, marsFpAliases as aliases,
  marsInstructionByMnemonic
} from './marsInstructionFacts';
export { marsInstructionFacts, marsInstructionByMnemonic } from './marsInstructionFacts';

const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

export interface MarsInstructionWorkOptions {
  readonly compactAddresses: boolean;
  readonly maximumInstructionsPerStatement: number;
}

interface WorkResult {
  readonly ok: boolean;
  readonly instructions?: readonly WorkInstruction[];
  readonly diagnostic?: AssemblerDiagnostic;
}

class OperandError extends Error {
  constructor(readonly code: AssemblerDiagnosticCode, message: string, readonly span?: SourceSpan) { super(message); }
}

function known(mnemonic: string): boolean {
  return marsInstructionByMnemonic.has(mnemonic);
}

/** Called exclusively by the ordinary assembler; the course catalog stays unchanged. */
export function marsInstructionWork(statement: ParsedStatement, options: MarsInstructionWorkOptions): WorkResult | undefined {
  const sourceMnemonic = statement.mnemonic?.toLowerCase() ?? '';
  if (!known(sourceMnemonic)) return undefined;
  const mnemonic = aliases[sourceMnemonic] ?? sourceMnemonic;
  const origin = workOriginFor(statement);
  const parsed = statement.operands.map(operand => parseInstructionOperand(operand.text, operand.span));
  const reg = (index: number, floating: boolean, double = false): WorkOperand => {
    const operand = parsed[index];
    if (!operand) throw new OperandError('asm.operand.wrong-count', `${sourceMnemonic}: missing operand ${index + 1}`);
    const match = /^\$f([0-9]|[12][0-9]|3[01])$/i.exec(statement.operands[index].text.trim());
    const register = floating ? (match ? Number(match[1]) : undefined) : (operand.kind === 'register' ? operand.register : undefined);
    if (register === undefined || (double && (register & 1) !== 0)) {
      throw new OperandError('asm.operand.invalid-register', floating
        ? `${sourceMnemonic}: operand ${index + 1} requires ${double ? 'an even ' : 'a '}$f0..$f31 register`
        : `${sourceMnemonic}: operand ${index + 1} requires a general purpose register`, operand.span);
    }
    return { kind: 'register', register, span: operand.span };
  };
  const count = (...allowed: number[]): void => {
    if (!allowed.includes(parsed.length)) throw new OperandError('asm.operand.wrong-count', `${sourceMnemonic}: expected ${allowed.join(' or ')} operands, got ${parsed.length}`);
  };
  const imm = (index: number, label = false): WorkOperand => {
    const operand = parsed[index];
    if (operand.kind !== 'immediate' && operand.kind !== 'character') throw new OperandError('asm.operand.invalid-immediate', `${sourceMnemonic}: operand ${index + 1} requires an expression`, operand.span);
    return { kind: label ? 'label' : 'immediate', expression: operand.text, span: operand.span };
  };
  const zero = (): WorkOperand => ({ kind: 'immediate', expression: '0', span: origin.span });
  const make = (operands: readonly WorkOperand[]): WorkInstruction => ({ mnemonic, operands, origin, pseudo: mnemonic !== sourceMnemonic, ...(mnemonic !== sourceMnemonic ? { pseudoMnemonic: sourceMnemonic } : {}) });
  try {
    let instructions: readonly WorkInstruction[];
    if (own(memoryOpcodes, mnemonic)) {
      count(2);
      const destination = reg(0, true, mnemonic === 'ldc1' || mnemonic === 'sdc1');
      const memory = parsed[1];
      const bareBaseAlias = own(aliases, sourceMnemonic) && /^\s*\(/.test(statement.operands[1].text);
      if (memory.kind === 'memory' && signedOffset(memory.offsetText) && (!own(aliases, sourceMnemonic) || bareBaseAlias)) {
        instructions = [make([destination, { kind: 'memory', baseRegister: memory.baseRegister, offsetExpression: memory.offsetText, offsetSpan: memory.offsetSpan, span: memory.span }])];
      } else {
        const addressExpression = memory.kind === 'memory' ? memory.offsetText : memory.kind === 'immediate' ? memory.text : '';
        const constantAddress = evaluateExpression(addressExpression, { resolve: () => undefined }, { unresolvedIsError: true }).ok;
        const expanded = expandLoadStorePseudo(mnemonic, [destination as Extract<ParsedInstructionOperand, { kind: 'register' }>, memory], statement, options.compactAddresses && !constantAddress);
        if (!expanded) throw new OperandError('asm.operand.invalid-memory-operand', `${sourceMnemonic}: expected an address or offset($base)`, memory.span);
        instructions = expanded;
      }
    } else if (mnemonic === 'mfc1' || mnemonic === 'mtc1') {
      count(2);
      instructions = [make([reg(0, false), reg(1, true)])];
    } else if (mnemonic === 'bc1f' || mnemonic === 'bc1t') {
      count(1, 2);
      instructions = [make([parsed.length === 2 ? imm(0) : zero(), imm(parsed.length - 1, true)])];
    } else if (mnemonic === 'li.s' || mnemonic === 'li.d') {
      count(2);
      const destination = reg(0, true, mnemonic === 'li.d');
      const value = statement.operands[1].text.trim();
      if (!/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|Infinity|NaN)$/i.test(value)) {
        throw new OperandError('asm.operand.invalid-immediate', `${mnemonic}: expected a floating point literal`, parsed[1].span);
      }
      instructions = floatingImmediate(mnemonic, Number(value.replace(/infinity/i, 'Infinity')), destination, origin);
    } else {
      const parts = mnemonic.split('.');
      const double = parts[parts.length - 1] === 'd';
      if (parts[0] === 'c') {
        count(2, 3);
        const start = parsed.length === 3 ? 1 : 0;
        instructions = [make([start ? imm(0) : zero(), reg(start, true, double), reg(start + 1, true, double)])];
      } else if (own(arithmetic, parts[0])) {
        count(3);
        instructions = [make([reg(0, true, double), reg(1, true, double), reg(2, true, double)])];
      } else if (parts[0] === 'movf' || parts[0] === 'movt') {
        count(2, 3);
        instructions = [make([reg(0, true, double), reg(1, true, double), parsed.length === 3 ? imm(2) : zero()])];
      } else if (parts[0] === 'movn' || parts[0] === 'movz') {
        count(3);
        instructions = [make([reg(0, true, double), reg(1, true, double), reg(2, false)])];
      } else {
        count(2);
        instructions = [make([reg(0, true, parts[0] === 'cvt' ? parts[1] === 'd' : parts.length === 2 && double), reg(1, true, double)])];
      }
    }
    if (instructions.length > options.maximumInstructionsPerStatement) throw new OperandError('asm.macro.expansion-limit', `${sourceMnemonic}: expansion exceeds ${options.maximumInstructionsPerStatement} instructions`);
    return { ok: true, instructions };
  } catch (error) {
    if (!(error instanceof OperandError)) throw error;
    return { ok: false, diagnostic: assemblerDiagnostic(error.code, error.message, error.span ?? origin.span, origin.expansionStack) };
  }
}

function signedOffset(expression: string): boolean {
  const result = evaluateExpression(expression, { resolve: () => undefined }, { unresolvedIsError: true });
  return result.ok && result.value! >= -32768 && result.value! <= 32767;
}

/** li.s/li.d are ordinary-engine conveniences; official MARS exposes raw mtc1 instead. */
function floatingImmediate(mnemonic: string, value: number, destination: WorkOperand, origin: WorkInstruction['origin']): WorkInstruction[] {
  const bytes = new DataView(new ArrayBuffer(8));
  if (mnemonic === 'li.s') bytes.setFloat32(0, value, true);
  else bytes.setFloat64(0, value, true);
  const instructions: WorkInstruction[] = [];
  const register = (index: number): WorkOperand => ({ kind: 'register', register: index, span: destination.span });
  const immediate = (number: number): WorkOperand => ({ kind: 'immediate', expression: String(number), span: destination.span });
  const push = (name: string, operands: WorkOperand[]): void => { instructions.push({ mnemonic: name, operands, origin, pseudo: true, pseudoMnemonic: mnemonic }); };
  for (let index = 0; index < (mnemonic === 'li.s' ? 1 : 2); index++) {
    const bits = bytes.getUint32(index * 4, true);
    push('lui', [register(1), immediate(bits >>> 16)]);
    push('ori', [register(1), register(1), immediate(bits & 65535)]);
    push('mtc1', [register(1), register((destination as Extract<WorkOperand, { kind: 'register' }>).register + index)]);
  }
  return instructions;
}

export function encodeMarsInstruction(instruction: WorkInstruction, address: number, resolve: (name: string) => number | undefined): { word?: number; diagnostic?: AssemblerDiagnostic } | undefined {
  const mnemonic = instruction.mnemonic;
  if (!known(mnemonic) || own(aliases, mnemonic) || mnemonic.startsWith('li.')) return undefined;
  const operands = instruction.operands;
  const register = (index: number): number => {
    const operand = operands[index];
    if (operand?.kind !== 'register') throw new OperandError('asm.operand.invalid-register', `${mnemonic}: expected register`, operand?.span);
    return operand.register;
  };
  const expression = (index: number): number => {
    const operand = operands[index];
    if (operand.kind !== 'immediate' && operand.kind !== 'label' && operand.kind !== 'memory') throw new OperandError('asm.operand.invalid-immediate', `${mnemonic}: expected expression`, operand.span);
    const result = evaluateExpression(operand.kind === 'memory' ? operand.offsetExpression : operand.expression, { resolve }, { unresolvedIsError: true });
    if (!result.ok) throw new OperandError(result.unresolvedSymbols?.length || /^undefined symbol\b/.test(result.error ?? '') ? 'asm.symbol.undefined' : 'asm.operand.invalid-immediate', result.error ?? `Invalid expression in ${mnemonic}`, operand.span);
    return result.value!;
  };
  const range = (value: number, low: number, high: number, span: SourceSpan): number => {
    if (value < low || value > high) throw new OperandError('asm.immediate.out-of-range', `${mnemonic}: ${value} is outside ${low}..${high}`, span);
    return value;
  };
  const condition = (index: number): number => range(expression(index), 0, 7, operands[index].span);
  try {
    let word: number;
    if (own(memoryOpcodes, mnemonic)) {
      const memory = operands[1];
      if (memory.kind !== 'memory') throw new OperandError('asm.operand.invalid-memory-operand', `${mnemonic}: expected memory address`, memory.span);
      const offset = range(expression(1), -32768, 32767, memory.span);
      word = (memoryOpcodes[mnemonic] << 26) | (memory.baseRegister << 21) | (register(0) << 16) | (offset & 65535);
    } else if (mnemonic === 'mfc1' || mnemonic === 'mtc1') {
      word = 0x44000000 | (mnemonic === 'mtc1' ? 4 << 21 : 0) | (register(0) << 16) | (register(1) << 11);
    } else if (mnemonic === 'bc1f' || mnemonic === 'bc1t') {
      const target = expression(1) >>> 0;
      const delta = target - ((address + 4) >>> 0);
      if (delta % 4 !== 0) throw new OperandError('asm.immediate.out-of-range', `${mnemonic}: branch target must be word aligned`, operands[1].span);
      const offset = range(delta / 4, -32768, 32767, operands[1].span);
      word = 0x45000000 | (condition(0) << 18) | (mnemonic === 'bc1t' ? 1 << 16 : 0) | (offset & 65535);
    } else {
      const parts = mnemonic.split('.');
      const fmt = parts[parts.length - 1] === 's' ? 16 : parts[parts.length - 1] === 'd' ? 17 : 20;
      word = 0x44000000 | (fmt << 21);
      if (parts[0] === 'c') word |= (register(2) << 16) | (register(1) << 11) | (condition(0) << 8) | comparison[parts[1]];
      else {
        word |= (register(0) << 6) | (register(1) << 11);
        if (own(arithmetic, parts[0])) word |= (register(2) << 16) | arithmetic[parts[0]];
        else if (own(unary, parts[0])) word |= unary[parts[0]];
        else if (own(rounding, parts[0])) word |= rounding[parts[0]];
        else if (parts[0] === 'cvt') word |= parts[1] === 's' ? 32 : parts[1] === 'd' ? 33 : 36;
        else if (parts[0] === 'movf' || parts[0] === 'movt') word |= (condition(2) << 18) | (parts[0] === 'movt' ? 1 << 16 : 0) | 17;
        else word |= (register(2) << 16) | (parts[0] === 'movz' ? 18 : 19);
      }
    }
    return { word: word >>> 0 };
  } catch (error) {
    if (!(error instanceof OperandError)) throw error;
    return { diagnostic: assemblerDiagnostic(error.code, error.message, error.span ?? instruction.origin.span, instruction.origin.expansionStack) };
  }
}
