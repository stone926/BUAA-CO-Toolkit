// @index mips-core — Ordinary MARS integer pseudos and breakpoint encoding through shared instruction IR

import type { WorkResult } from './assembler';
import { assemblerDiagnostic, AssemblerDiagnostic } from './diagnostics';
import { evaluateExpression } from './expression';
import { parseIntegerLiteral } from './literals';
import { parseInstructionOperand, ParsedInstructionOperand } from './operands';
import { expandPseudoInstruction } from './pseudo';
import { ParsedStatement } from './syntax';
import { WorkInstruction, WorkOperand, workOriginFor } from './work';
import { encodeInstructionWord } from '../isa/encoder';
import { parseCp0Register } from './registers';

export interface MarsIntegerPseudoOptions {
  readonly delayedBranching: boolean;
  readonly maximumInstructionsPerStatement: number;
}

const extended = new Set(['abs', 'subi', 'subiu', 'mulu', 'mulo', 'mulou', 'div', 'divu', 'rem', 'remu', 'rol', 'ror', 'mul', 'break', 'mfc0', 'mtc0']);
const comparisons = new Set(['blt', 'bltu', 'bgt', 'bgtu', 'ble', 'bleu', 'bge', 'bgeu', 'seq', 'sne', 'sgt', 'sgtu', 'sge', 'sgeu', 'sle', 'sleu']);

/** Adds ordinary MARS forms while leaving the course pseudo registry unchanged. */
export function marsIntegerWork(statement: ParsedStatement, options: MarsIntegerPseudoOptions): WorkResult | undefined {
  const mnemonic = statement.mnemonic?.toLowerCase() ?? '';
  if (!extended.has(mnemonic) && !comparisons.has(mnemonic)) return undefined;
  const parsed = statement.operands.map(operand => parseInstructionOperand(operand.text, operand.span));
  if (['div', 'divu'].includes(mnemonic) && parsed.length === 2) return undefined;
  if (mnemonic === 'mul' && parsed.length === 3 && parsed[2].kind === 'register') return undefined;
  const origin = workOriginFor(statement);
  const register = (index: number): WorkOperand => {
    const operand = parsed[index];
    if (!operand || operand.kind !== 'register') throw new Error(`${mnemonic} operand ${index + 1} requires a general register`);
    return { kind: 'register', register: operand.register, span: operand.span };
  };
  const constant = (value: number): WorkOperand => ({ kind: 'immediate', expression: String(value), span: origin.span });
  const r = (number: number): WorkOperand => ({ kind: 'register', register: number, span: origin.span });
  const make = (name: string, operands: readonly WorkOperand[]): WorkInstruction => ({
    mnemonic: name, operands, origin, pseudo: true, pseudoMnemonic: mnemonic
  });
  const integer = (index: number): number => {
    const operand = parsed[index];
    if (!operand || operand.kind !== 'immediate') throw new Error(`${mnemonic} operand ${index + 1} requires an integer`);
    const value = parseIntegerLiteral(operand.text);
    if (value === undefined) throw new Error(`${mnemonic} invalid integer ${operand.text}`);
    return value | 0;
  };
  const loadAt = (value: number, alwaysWide = false): WorkInstruction[] => {
    if (!alwaysWide && value >= -32768 && value <= 32767) return [make('addi', [r(1), r(0), constant(value)])];
    return [make('lui', [r(1), constant(value >>> 16)]), make('ori', [r(1), r(1), constant(value & 0xffff)])];
  };
  const guard = (name: 'beq' | 'bne', first: WorkOperand, second: WorkOperand): WorkInstruction[] => [
    make(`_mars_${name}_offset`, [first, second, constant(options.delayedBranching ? 2 : 1)]),
    ...(options.delayedBranching ? [make('nop', [])] : []),
    make('_mars_break', [constant(0)])
  ];
  try {
    let instructions: readonly WorkInstruction[];
    if (mnemonic === 'mfc0' || mnemonic === 'mtc0') {
      if (parsed.length !== 2) throw new Error(`${mnemonic} requires a general register and CP0 register`);
      const cp0 = parseCp0Register(statement.operands[1].text)
        ?? parseIntegerLiteral(statement.operands[1].text);
      if (cp0 === undefined || ![8, 12, 13, 14].includes(cp0)) throw new Error(`${mnemonic} CP0 register must be 8, 12, 13, or 14`);
      instructions = [make(`_mars_${mnemonic}`, [register(0), { kind: 'cp0', register: cp0, span: parsed[1].span }])];
    } else if (comparisons.has(mnemonic)) {
      const immediateIndex = mnemonic.startsWith('b') ? 1 : 2;
      if (parsed.length !== 3 || parsed[immediateIndex].kind !== 'immediate') return undefined;
      const value = integer(immediateIndex);
      if (value >= -32768 && value <= 32767) return undefined;
      const operands: ParsedInstructionOperand[] = [...parsed];
      operands[immediateIndex] = { kind: 'register', register: 1, span: parsed[immediateIndex].span };
      const expanded = expandPseudoInstruction({ mnemonic, operands }, statement, {
        profile: 'P7', compactAddresses: false, maximumInstructionsPerStatement: options.maximumInstructionsPerStatement
      });
      if (!expanded.ok) throw new Error(expanded.error);
      instructions = [...loadAt(value), ...expanded.instructions!];
    } else if (mnemonic === 'break') {
      if (parsed.length > 1) throw new Error('break accepts zero or one code operand');
      const code = parsed.length ? integer(0) : 0;
      if (code < 0 || code > 0xfffff) throw new Error('break code must be in 0..1048575');
      instructions = [make('_mars_break', [constant(code)])];
    } else if (mnemonic === 'abs') {
      if (parsed.length !== 2) throw new Error('abs requires two registers');
      const destination = register(0), source = register(1);
      instructions = [make('sra', [r(1), source, constant(31)]), make('xor', [destination, r(1), source]), make('subu', [destination, destination, r(1)])];
    } else {
      if (parsed.length !== 3) throw new Error(`${mnemonic} requires three operands`);
      const destination = register(0), first = register(1);
      if (mnemonic === 'subi' || mnemonic === 'subiu') {
        instructions = [...loadAt(integer(2), mnemonic === 'subiu'), make(mnemonic === 'subi' ? 'sub' : 'subu', [destination, first, r(1)])];
      } else if (mnemonic === 'rol' || mnemonic === 'ror') {
        const left = mnemonic === 'rol';
        if (parsed[2].kind === 'register') {
          const shift = register(2);
          instructions = [make('subu', [r(1), r(0), shift]), make(left ? 'srlv' : 'sllv', [r(1), first, r(1)]),
            make(left ? 'sllv' : 'srlv', [destination, first, shift]), make('or', [destination, destination, r(1)])];
        } else {
          const shift = integer(2);
          if (shift < 0 || shift > 31) throw new Error(`${mnemonic} shift must be in 0..31`);
          instructions = [make(left ? 'srl' : 'sll', [r(1), first, constant((32 - shift) & 31)]),
            make(left ? 'sll' : 'srl', [destination, first, constant(shift)]), make('or', [destination, destination, r(1)])];
        }
      } else {
        const immediate = parsed[2].kind !== 'register';
        const prefix = immediate ? loadAt(integer(2)) : [];
        const second = immediate ? r(1) : register(2);
        if (mnemonic === 'mul') {
          instructions = [...prefix, make('mul', [destination, first, second])];
        } else if (mnemonic.startsWith('mul')) {
          const unsigned = mnemonic === 'mulu' || mnemonic === 'mulou';
          const body = [make(unsigned ? 'multu' : 'mult', [first, second])];
          if (mnemonic !== 'mulu') {
            body.push(make('mfhi', [r(1)]));
            if (!unsigned) body.push(make('mflo', [destination]), make('sra', [destination, destination, constant(31)]));
            body.push(...guard('beq', r(1), unsigned ? r(0) : destination));
          }
          instructions = [...prefix, ...body, make('mflo', [destination])];
        } else {
          const unsigned = mnemonic === 'divu' || mnemonic === 'remu';
          instructions = [...prefix, ...(immediate ? [] : guard('bne', second, r(0))),
            make(unsigned ? 'divu' : 'div', [first, second]), make(mnemonic.startsWith('rem') ? 'mfhi' : 'mflo', [destination])];
        }
      }
    }
    if (instructions.length > options.maximumInstructionsPerStatement) throw new Error(`${mnemonic} exceeds the pseudo instruction budget`);
    return { ok: true, instructions };
  } catch (error) {
    return { ok: false, diagnostic: assemblerDiagnostic('asm.operand.invalid-immediate',
      error instanceof Error ? error.message : String(error), origin.span, origin.expansionStack) };
  }
}

export function encodeMarsIntegerInstruction(instruction: WorkInstruction, _address: number,
  resolve: (name: string) => number | undefined): { word?: number; diagnostic?: AssemblerDiagnostic } | undefined {
  if (instruction.mnemonic === '_mars_mfc0' || instruction.mnemonic === '_mars_mtc0') {
    const [general, cp0] = instruction.operands;
    if (general.kind !== 'register' || cp0.kind !== 'cp0') throw new Error('Invalid internal CP0 operands');
    return { word: (0x4000_0000 | (instruction.mnemonic === '_mars_mtc0' ? 4 << 21 : 0)
      | (general.register << 16) | (cp0.register << 11)) >>> 0 };
  }
  if (!['_mars_break', '_mars_beq_offset', '_mars_bne_offset'].includes(instruction.mnemonic)) return undefined;
  const operands = instruction.operands;
  const valueOperand = operands.at(-1)!;
  const expression = valueOperand.kind === 'immediate' ? valueOperand.expression : '';
  const evaluated = evaluateExpression(expression, { resolve }, { unresolvedIsError: true });
  if (!evaluated.ok) return { diagnostic: assemblerDiagnostic('asm.operand.invalid-immediate', evaluated.error ?? 'Invalid pseudo operand', instruction.origin.span) };
  if (instruction.mnemonic === '_mars_break') return { word: ((evaluated.value! << 6) | 0x0d) >>> 0 };
  const first = operands[0], second = operands[1];
  if (first.kind !== 'register' || second.kind !== 'register') throw new Error('Invalid internal branch operands');
  return { word: encodeInstructionWord(instruction.mnemonic === '_mars_beq_offset' ? 'beq' : 'bne', {
    rs: first.register, rt: second.register, immediate: evaluated.value!
  }) };
}
