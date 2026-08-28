// @index mips-core — 课程常用 pseudo 展开：li/la/move/常用分支/load-store 便捷寻址（纯 TS）

import { CourseProfile } from '../generated/isaCatalog';
import { SourceSpan } from './diagnostics';
import { ParsedInstructionOperand } from './operands';
import { ParsedStatement } from './syntax';
import { WorkInstruction, WorkOperand, workOriginFor } from './work';

export interface PseudoExpansionOptions {
  readonly profile: CourseProfile;
  /** Course assembler always uses the compact 16-bit address model. */
  readonly compactAddresses: boolean;
  readonly maximumInstructionsPerStatement: number;
}

export interface PseudoExpansionResult {
  readonly ok: boolean;
  readonly instructions?: readonly WorkInstruction[];
  readonly error?: string;
}

export interface PseudoInstructionShape {
  readonly mnemonic: string;
  readonly operands: readonly ParsedInstructionOperand[];
}

export const supportedPseudoMnemonics: ReadonlySet<string> = new Set([
  'li', 'la', 'move', 'b', 'beqz', 'bnez', 'not', 'neg', 'negu',
  'blt', 'bltu', 'bgt', 'bgtu', 'ble', 'bleu', 'bge', 'bgeu',
  'seq', 'sne', 'sgt', 'sgtu', 'sge', 'sgeu', 'sle', 'sleu'
]);

export function expandPseudoInstruction(
  shape: PseudoInstructionShape,
  statement: ParsedStatement,
  options: PseudoExpansionOptions
): PseudoExpansionResult {
  const mnemonic = shape.mnemonic.toLowerCase();
  const operands = shape.operands;
  const origin = workOriginFor(statement);
  try {
    const instructions = expand(mnemonic, operands, origin, statement, options);
    if (instructions.length === 0) {
      return { ok: false, error: `pseudo ${mnemonic} 展开为空` };
    }
    if (instructions.length > options.maximumInstructionsPerStatement) {
      return {
        ok: false,
        error: `pseudo ${mnemonic} 展开 ${instructions.length} 条指令，超过单语句上限 ${options.maximumInstructionsPerStatement}`
      };
    }
    return { ok: true, instructions };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function expand(
  mnemonic: string,
  operands: readonly ParsedInstructionOperand[],
  origin: WorkInstruction['origin'],
  statement: ParsedStatement,
  options: PseudoExpansionOptions
): WorkInstruction[] {
  if (!supportedPseudoMnemonics.has(mnemonic)) {
    throw new Error(`不支持的 pseudo 指令 ${mnemonic}`);
  }
  switch (mnemonic) {
    case 'move': {
      requireCount(mnemonic, operands, 2);
      return [real('addu', [
        registerOperand(operands[0]),
        registerNumber(0, operandSpan(operands[0])),
        registerOperand(operands[1])
      ], origin, mnemonic)];
    }
    case 'not': {
      requireCount(mnemonic, operands, 2);
      return [real('nor', [
        registerOperand(operands[0]),
        registerOperand(operands[1]),
        registerNumber(0, operandSpan(operands[0]))
      ], origin, mnemonic)];
    }
    case 'neg': {
      requireCount(mnemonic, operands, 2);
      return [real('sub', [
        registerOperand(operands[0]),
        registerNumber(0, operandSpan(operands[0])),
        registerOperand(operands[1])
      ], origin, mnemonic)];
    }
    case 'negu': {
      requireCount(mnemonic, operands, 2);
      return [real('subu', [
        registerOperand(operands[0]),
        registerNumber(0, operandSpan(operands[0])),
        registerOperand(operands[1])
      ], origin, mnemonic)];
    }
    case 'li':
    case 'la':
      return expandLoadImmediate(mnemonic, operands, origin, statement, options);
    case 'b':
      requireCount(mnemonic, operands, 1);
      return [real('bgez', [
        registerNumber(0, operandSpan(operands[0])),
        labelOperand(operands[0])
      ], origin, mnemonic)];
    case 'beqz':
    case 'bnez':
      requireCount(mnemonic, operands, 2);
      return [real(mnemonic === 'beqz' ? 'beq' : 'bne', [
        registerOperand(operands[0]),
        registerNumber(0, operandSpan(operands[0])),
        labelOperand(operands[1])
      ], origin, mnemonic)];
    case 'blt':
    case 'bltu':
    case 'bgt':
    case 'bgtu':
    case 'ble':
    case 'bleu':
    case 'bge':
    case 'bgeu':
      return expandBranchComparison(mnemonic, operands, origin);
    case 'seq':
    case 'sne':
    case 'sgt':
    case 'sgtu':
    case 'sge':
    case 'sgeu':
    case 'sle':
    case 'sleu':
      return expandSetComparison(mnemonic, operands, origin);
    default:
      throw new Error(`不支持的 pseudo 指令 ${mnemonic}`);
  }
}

function expandLoadImmediate(
  mnemonic: 'li' | 'la',
  operands: readonly ParsedInstructionOperand[],
  origin: WorkInstruction['origin'],
  _statement: ParsedStatement,
  options: PseudoExpansionOptions
): WorkInstruction[] {
  requireCount(mnemonic, operands, 2);
  const destination = registerOperand(operands[0]);
  const second = operands[1];
  const at = (span: ParsedInstructionOperand): WorkOperand =>
    ({ kind: 'register', register: 1, span: operandSpan(span) } as WorkOperand);

  // la $rd, ($rs) is an address move.
  if (mnemonic === 'la' && second.kind === 'immediate') {
    const memory = parseBareRegisterParen(second.text);
    if (memory !== undefined) {
      return [real('addi', [
        destination,
        registerNumber(memory, operandSpan(second)),
        immediateOperand('0', operandSpan(second))
      ], origin, mnemonic)];
    }
  }

  let expression: string;
  let baseRegister: number | undefined;
  if (second.kind === 'memory') {
    expression = second.offsetText || '0';
    baseRegister = second.baseRegister;
  } else if (second.kind === 'immediate') {
    const memory = parseAddressBase(second.text);
    expression = memory?.expression ?? second.text;
    baseRegister = memory?.baseRegister;
  } else {
    expression = operandText(second);
  }

  if (isPureInteger(expression)) {
    const value = parsePureInteger(expression)!;
    return liExpansion(destination, value, origin, mnemonic, second);
  }

  if (mnemonic === 'li') {
    throw new Error('li 的立即数必须是可在汇编期求值的整数');
  }

  // la $rd, expression or la $rd, expression($rs).
  if (options.compactAddresses && !containsArithmetic(expression) && baseRegister === undefined) {
    return [real('addi', [
      destination,
      registerNumber(0, operandSpan(second)),
      immediateOperand(expression, operandSpan(second))
    ], origin, mnemonic)];
  }
  const high = `((${expression}) >> 16)`;
  const low = `((${expression}) << 16) >> 16`;
  if (baseRegister === undefined) {
    return [
      real('lui', [at(second), immediateOperand(high, operandSpan(second))], origin, mnemonic),
      real('ori', [destination, at(second), immediateOperand(low, operandSpan(second))], origin, mnemonic)
    ];
  }
  return [
    real('lui', [at(second), immediateOperand(high, operandSpan(second))], origin, mnemonic),
    real('ori', [at(second), at(second), immediateOperand(low, operandSpan(second))], origin, mnemonic),
    real('add', [
      destination,
      registerNumber(baseRegister, operandSpan(second)),
      at(second)
    ], origin, mnemonic)
  ];
}

function liExpansion(
  destination: WorkOperand,
  value: number,
  origin: WorkInstruction['origin'],
  pseudo: string,
  span: ParsedInstructionOperand
): WorkInstruction[] {
  const signed = value | 0;
  if (signed >= -32768 && signed <= 32767) {
    return [real('addiu', [
      destination,
      registerNumber(0, operandSpan(span)),
      immediateOperand(String(signed), operandSpan(span))
    ], origin, pseudo)];
  }
  const unsigned = value >>> 0;
  if (unsigned <= 0xffff) {
    return [real('ori', [
      destination,
      registerNumber(0, operandSpan(span)),
      immediateOperand(String(unsigned), operandSpan(span))
    ], origin, pseudo)];
  }
  const high = Math.floor(unsigned / 0x10000);
  const low = unsigned & 0xffff;
  return [
    real('lui', [
      { kind: 'register', register: 1, span: operandSpan(span) },
      immediateOperand(String(high), operandSpan(span))
    ], origin, pseudo),
    real('ori', [
      destination,
      { kind: 'register', register: 1, span: operandSpan(span) },
      immediateOperand(String(low), operandSpan(span))
    ], origin, pseudo)
  ];
}

function expandBranchComparison(
  mnemonic: string,
  operands: readonly ParsedInstructionOperand[],
  origin: WorkInstruction['origin']
): WorkInstruction[] {
  requireCount(mnemonic, operands, 3);
  const first = registerOperand(operands[0]);
  const label = labelOperand(operands[2]);
  const unsigned = mnemonic.endsWith('u');
  const base = mnemonic.slice(0, 3);
  const zero = (): WorkOperand => registerNumber(0, operandSpan(operands[1]));
  const at = (): WorkOperand => ({ kind: 'register', register: 1, span: operandSpan(operands[1]) } as WorkOperand);

  if (operands[1].kind === 'register') {
    const second = registerOperand(operands[1]);
    const slt = unsigned ? 'sltu' : 'slt';
    switch (base) {
      case 'blt': return [real(slt, [at(), first, second], origin, mnemonic), real('bne', [at(), zero(), label], origin, mnemonic)];
      case 'bgt': return [real(slt, [at(), second, first], origin, mnemonic), real('bne', [at(), zero(), label], origin, mnemonic)];
      case 'ble': return [real(slt, [at(), second, first], origin, mnemonic), real('beq', [at(), zero(), label], origin, mnemonic)];
      case 'bge': return [real(slt, [at(), first, second], origin, mnemonic), real('beq', [at(), zero(), label], origin, mnemonic)];
      default: throw new Error(`不支持的伪分支 ${mnemonic}`);
    }
  }
  if (operands[1].kind !== 'immediate') {
    throw new Error(`${mnemonic} 的第二操作数必须是寄存器或立即数`);
  }
  const signedValue = parsePureInteger(operands[1].text);
  if (signedValue === undefined || (signedValue | 0) < -32768 || (signedValue | 0) > 32767) {
    throw new Error(`${mnemonic} 的立即数形式仅支持 16 位有符号立即数`);
  }
  const value = signedValue | 0;
  const slt = unsigned ? 'sltu' : 'slt';
  const slti = unsigned ? 'sltiu' : 'slti';
  switch (base) {
    case 'blt':
      return [real(slti, [at(), first, immediateOperand(String(value), operandSpan(operands[1]))], origin, mnemonic), real('bne', [at(), zero(), label], origin, mnemonic)];
    case 'bge':
      return [real(slti, [at(), first, immediateOperand(String(value), operandSpan(operands[1]))], origin, mnemonic), real('beq', [at(), zero(), label], origin, mnemonic)];
    case 'bgt':
      return [
        real('addi', [at(), zero(), immediateOperand(String(value), operandSpan(operands[1]))], origin, mnemonic),
        real(slt, [at(), at(), first], origin, mnemonic),
        real('bne', [at(), zero(), label], origin, mnemonic)
      ];
    case 'ble':
      if (unsigned) {
        return [
          real('addi', [at(), zero(), immediateOperand(String(value), operandSpan(operands[1]))], origin, mnemonic),
          real('sltu', [at(), at(), first], origin, mnemonic),
          real('beq', [at(), zero(), label], origin, mnemonic)
        ];
      }
      return [
        real('addi', [at(), first, immediateOperand(String(-1), operandSpan(operands[1]))], origin, mnemonic),
        real(slti, [at(), at(), immediateOperand(String(value), operandSpan(operands[1]))], origin, mnemonic),
        real('bne', [at(), zero(), label], origin, mnemonic)
      ];
    default:
      throw new Error(`不支持的伪分支 ${mnemonic}`);
  }
}

function expandSetComparison(
  mnemonic: string,
  operands: readonly ParsedInstructionOperand[],
  origin: WorkInstruction['origin']
): WorkInstruction[] {
  requireCount(mnemonic, operands, 3);
  const destination = registerOperand(operands[0]);
  const unsigned = mnemonic.endsWith('u');
  const base = mnemonic.slice(0, 3);
  const at = (): WorkOperand => ({ kind: 'register', register: 1, span: operandSpan(operands[1]) } as WorkOperand);
  const zero = (): WorkOperand => registerNumber(0, operandSpan(operands[1]));
  const slt = unsigned ? 'sltu' : 'slt';

  if (operands[1].kind === 'register' && operands[2].kind === 'register') {
    const first = registerOperand(operands[1]);
    const second = registerOperand(operands[2]);
    switch (base) {
      case 'seq': return [
        real('subu', [destination, first, second], origin, mnemonic),
        real('ori', [at(), zero(), immediateOperand('1', operandSpan(operands[1]))], origin, mnemonic),
        real('sltu', [destination, destination, at()], origin, mnemonic)
      ];
      case 'sne': return [
        real('subu', [destination, first, second], origin, mnemonic),
        real('sltu', [destination, zero(), destination], origin, mnemonic)
      ];
      case 'sgt': return [real(slt, [destination, second, first], origin, mnemonic)];
      case 'sge': return [
        real(slt, [destination, first, second], origin, mnemonic),
        real('ori', [at(), zero(), immediateOperand('1', operandSpan(operands[1]))], origin, mnemonic),
        real('subu', [destination, at(), destination], origin, mnemonic)
      ];
      case 'sle': return [
        real(slt, [destination, second, first], origin, mnemonic),
        real('ori', [at(), zero(), immediateOperand('1', operandSpan(operands[1]))], origin, mnemonic),
        real('subu', [destination, at(), destination], origin, mnemonic)
      ];
      default: throw new Error(`不支持的伪比较 ${mnemonic}`);
    }
  }

  if (operands[1].kind === 'register' && operands[2].kind === 'immediate') {
    const first = registerOperand(operands[1]);
    const value = parsePureInteger(operands[2].text);
    if (value === undefined || (value | 0) < -32768 || (value | 0) > 32767) {
      throw new Error(`${mnemonic} 的立即数形式仅支持 16 位有符号立即数`);
    }
    const immediate = immediateOperand(String(value | 0), operandSpan(operands[2]));
    switch (base) {
      case 'seq': return [
        real('addi', [at(), zero(), immediate], origin, mnemonic),
        real('subu', [destination, first, at()], origin, mnemonic),
        real('ori', [at(), zero(), immediateOperand('1', operandSpan(operands[1]))], origin, mnemonic),
        real('sltu', [destination, destination, at()], origin, mnemonic)
      ];
      case 'sne': return [
        real('addi', [at(), zero(), immediate], origin, mnemonic),
        real('subu', [destination, first, at()], origin, mnemonic),
        real('sltu', [destination, zero(), destination], origin, mnemonic)
      ];
      case 'sgt': return [
        real('addi', [at(), zero(), immediate], origin, mnemonic),
        real(slt, [destination, at(), first], origin, mnemonic)
      ];
      case 'sge': return [
        real('addi', [at(), zero(), immediate], origin, mnemonic),
        real(slt, [destination, first, at()], origin, mnemonic),
        real('ori', [at(), zero(), immediateOperand('1', operandSpan(operands[1]))], origin, mnemonic),
        real('subu', [destination, at(), destination], origin, mnemonic)
      ];
      case 'sle': return [
        real('addi', [at(), zero(), immediate], origin, mnemonic),
        real(slt, [destination, at(), first], origin, mnemonic),
        real('ori', [at(), zero(), immediateOperand('1', operandSpan(operands[1]))], origin, mnemonic),
        real('subu', [destination, at(), destination], origin, mnemonic)
      ];
      default: throw new Error(`不支持的伪比较 ${mnemonic}`);
    }
  }

  throw new Error(`${mnemonic} 需要三个操作数`);
}

/** Load/store address pseudo forms. Returns replacement real instructions. */
export function expandLoadStorePseudo(
  mnemonic: string,
  operands: readonly ParsedInstructionOperand[],
  statement: ParsedStatement,
  compactAddresses: boolean
): WorkInstruction[] | undefined {
  if (operands.length !== 2 || (operands[1].kind !== 'immediate' && operands[1].kind !== 'memory')) {
    return undefined;
  }
  const destination = registerOperand(operands[0]);
  const origin = workOriginFor(statement);
  const span = operands[1];
  const text = operandText(operands[1]);
  const memoryBase = operands[1].kind === 'memory'
    ? { expression: operands[1].offsetText || '0', baseRegister: operands[1].baseRegister }
    : parseAddressBase(text);

  if (memoryBase) {
    const expr = memoryBase.expression;
    if (memoryBase.baseRegister !== undefined) {
      // MARS compact expansion for symbol($base) with a pure course-sized symbol.
      if (compactAddresses && !containsArithmetic(expr)) {
        return [real(mnemonic, [
          destination,
          memoryOperand(memoryBase.baseRegister, expr, span)
        ], origin, 'load-store-address')];
      }
      const high = `(((${expr}) >> 16) + (((${expr}) >> 15) & 1))`;
      const low = `((${expr}) << 16) >> 16`;
      return [
        real('lui', [{ kind: 'register', register: 1, span: operandSpan(span) }, immediateOperand(high, span)], origin, 'load-store-address'),
        real('addu', [{ kind: 'register', register: 1, span: operandSpan(span) }, { kind: 'register', register: 1, span: operandSpan(span) }, registerNumber(memoryBase.baseRegister, operandSpan(span))], origin, 'load-store-address'),
        real(mnemonic, [destination, memoryOperand(1, low, span)], origin, 'load-store-address')
      ];
    }

    const value = parsePureInteger(expr);
    if (value !== undefined) {
      const signed = value | 0;
      if (signed >= -32768 && signed <= 32767) {
        return [real(mnemonic, [destination, memoryOperand(0, String(signed), span)], origin, 'load-store-address')];
      }
      const unsigned = value >>> 0;
      if (unsigned <= 0xffff) {
        return [
          real('ori', [{ kind: 'register', register: 1, span: operandSpan(span) }, registerNumber(0, operandSpan(span)), immediateOperand(String(unsigned), span)], origin, 'load-store-address'),
          real(mnemonic, [destination, memoryOperand(1, '0', span)], origin, 'load-store-address')
        ];
      }
      const high = (value + 0x8000) >> 16;
      const low = (value << 16) >> 16;
      return [
        real('lui', [{ kind: 'register', register: 1, span: operandSpan(span) }, immediateOperand(String(high), span)], origin, 'load-store-address'),
        real(mnemonic, [destination, memoryOperand(1, String(low), span)], origin, 'load-store-address')
      ];
    }

    if (compactAddresses && !containsArithmetic(expr)) {
      return [real(mnemonic, [destination, memoryOperand(0, expr, span)], origin, 'load-store-address')];
    }
    const high = `(((${expr}) >> 16) + (((${expr}) >> 15) & 1))`;
    const low = `((${expr}) << 16) >> 16`;
    return [
      real('lui', [{ kind: 'register', register: 1, span: operandSpan(span) }, immediateOperand(high, span)], origin, 'load-store-address'),
      real(mnemonic, [destination, memoryOperand(1, low, span)], origin, 'load-store-address')
    ];
  }

  // A bare register in parentheses, e.g. lw $t0, ($t1).
  const bareBase = parseBareRegisterParen(text);
  if (bareBase !== undefined) {
    return [real(mnemonic, [destination, memoryOperand(bareBase, '0', span)], origin, 'load-store-address')];
  }
  return undefined;
}

/** Pseudo immediate forms for R-type ALU instructions (add/sub/and/or/xor and unsigned). */
export function expandAluImmediatePseudo(
  mnemonic: string,
  operands: readonly ParsedInstructionOperand[],
  statement: ParsedStatement
): WorkInstruction[] | undefined {
  if (operands.length !== 3 || operands[2].kind !== 'immediate') return undefined;
  const destination = registerOperand(operands[0]);
  const first = registerOperand(operands[1]);
  const origin = workOriginFor(statement);
  const span = operands[2];
  const value = parsePureInteger(operands[2].text);
  if (value === undefined) return undefined;

  const signedValue = value | 0;
  const unsignedValue = value >>> 0;
  if (mnemonic === 'add' || mnemonic === 'addu') {
    if (signedValue >= -32768 && signedValue <= 32767) {
      return [real(mnemonic === 'add' ? 'addi' : 'addiu', [destination, first, immediateOperand(String(signedValue), span)], origin, 'alu-immediate')];
    }
  } else if (mnemonic === 'sub' || mnemonic === 'subu') {
    if (signedValue >= -32768 && signedValue <= 32767) {
      return [
        real(mnemonic === 'sub' ? 'addi' : 'addiu', [{ kind: 'register', register: 1, span: operandSpan(span) }, registerNumber(0, operandSpan(span)), immediateOperand(String(signedValue), span)], origin, 'alu-immediate'),
        real(mnemonic, [destination, first, { kind: 'register', register: 1, span: operandSpan(span) }], origin, 'alu-immediate')
      ];
    }
  } else if (unsignedValue <= 0xffff) {
    return [real(`${mnemonic}i`, [destination, first, immediateOperand(String(unsignedValue), span)], origin, 'alu-immediate')];
  }

  const high = Math.floor(unsignedValue / 0x10000);
  const low = unsignedValue & 0xffff;
  const build = [
    real('lui', [{ kind: 'register', register: 1, span: operandSpan(span) }, immediateOperand(String(high), span)], origin, 'alu-immediate'),
    real('ori', [{ kind: 'register', register: 1, span: operandSpan(span) }, { kind: 'register', register: 1, span: operandSpan(span) }, immediateOperand(String(low), span)], origin, 'alu-immediate')
  ];
  return [
    ...build,
    real(mnemonic, [destination, first, { kind: 'register', register: 1, span: operandSpan(span) }], origin, 'alu-immediate')
  ];
}

export function expandTwoOperandLogicalPseudo(
  mnemonic: string,
  operands: readonly ParsedInstructionOperand[],
  statement: ParsedStatement
): WorkInstruction[] | undefined {
  if (operands.length !== 2 || operands[1].kind !== 'immediate') return undefined;
  const destination = registerOperand(operands[0]);
  const origin = workOriginFor(statement);
  const span = operands[1];
  const value = parsePureInteger(operands[1].text);
  if (value === undefined) return undefined;
  const unsigned = value >>> 0;
  if (unsigned <= 0xffff) {
    return [real(`${mnemonic}i`, [destination, destination, immediateOperand(String(unsigned), span)], origin, 'logical-immediate')];
  }
  const high = Math.floor(unsigned / 0x10000);
  const low = unsigned & 0xffff;
  return [
    real('lui', [{ kind: 'register', register: 1, span: operandSpan(span) }, immediateOperand(String(high), span)], origin, 'logical-immediate'),
    real('ori', [{ kind: 'register', register: 1, span: operandSpan(span) }, { kind: 'register', register: 1, span: operandSpan(span) }, immediateOperand(String(low), span)], origin, 'logical-immediate'),
    real(mnemonic, [destination, destination, { kind: 'register', register: 1, span: operandSpan(span) }], origin, 'logical-immediate')
  ];
}

export function expandBranchImmediatePseudo(
  mnemonic: 'beq' | 'bne',
  operands: readonly ParsedInstructionOperand[],
  statement: ParsedStatement
): WorkInstruction[] | undefined {
  if (operands.length !== 3 || operands[1].kind !== 'immediate' || operands[2].kind !== 'immediate') return undefined;
  const origin = workOriginFor(statement);
  const span = operands[1];
  const value = parsePureInteger(operands[1].text);
  if (value === undefined) return undefined;
  const unsigned = value >>> 0;
  const at = (): WorkOperand => ({ kind: 'register', register: 1, span: operandSpan(span) } as WorkOperand);
  const zero = (): WorkOperand => registerNumber(0, operandSpan(span));
  const build: WorkInstruction[] = [];
  if ((value | 0) >= -32768 && (value | 0) <= 32767) {
    build.push(real('addi', [at(), zero(), immediateOperand(String(value | 0), span)], origin, 'branch-immediate'));
  } else {
    build.push(
      real('lui', [at(), immediateOperand(String(Math.floor(unsigned / 0x10000)), span)], origin, 'branch-immediate'),
      real('ori', [at(), at(), immediateOperand(String(unsigned & 0xffff), span)], origin, 'branch-immediate')
    );
  }
  build.push(real(mnemonic, [at(), registerOperand(operands[0]), labelOperand(operands[2])], origin, 'branch-immediate'));
  return build;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function real(
  mnemonic: string,
  operands: WorkOperand[],
  origin: WorkInstruction['origin'],
  pseudoMnemonic: string
): WorkInstruction {
  return { mnemonic, operands, origin, pseudo: true, pseudoMnemonic };
}

function requireCount(mnemonic: string, operands: readonly ParsedInstructionOperand[], count: number): void {
  if (operands.length !== count) {
    throw new Error(`${mnemonic} 需要 ${count} 个操作数，实际 ${operands.length}`);
  }
}

function registerOperand(operand: ParsedInstructionOperand): WorkOperand {
  if (operand.kind !== 'register') {
    throw new Error('期望寄存器操作数');
  }
  return { kind: 'register', register: operand.register, span: operand.span };
}

function operandText(operand: ParsedInstructionOperand): string {
  switch (operand.kind) {
    case 'immediate':
    case 'string':
    case 'character':
    case 'macro-parameter':
      return operand.text;
    default:
      return operand.kind;
  }
}

function registerNumber(register: number, span: SourceSpan): WorkOperand {
  return { kind: 'register', register, span };
}

function operandSpan(operand: ParsedInstructionOperand): SourceSpan {
  return operand.span;
}

function immediateOperand(expression: string, span: ParsedInstructionOperand | SourceSpan): WorkOperand {
  const sourceSpan = isParsedOperand(span) ? span.span : span;
  return { kind: 'immediate', expression, span: sourceSpan };
}

function labelOperand(operand: ParsedInstructionOperand): WorkOperand {
  if (operand.kind !== 'immediate') {
    throw new Error('期望地址表达式操作数');
  }
  return { kind: 'label', expression: operand.text, span: operand.span };
}

function memoryOperand(baseRegister: number, offsetExpression: string, span: ParsedInstructionOperand): WorkOperand {
  return {
    kind: 'memory',
    baseRegister,
    offsetExpression,
    offsetSpan: span.span,
    span: span.span
  };
}

function isParsedOperand(value: ParsedInstructionOperand | SourceSpan): value is ParsedInstructionOperand {
  return 'kind' in value;
}

/** Parse `expression($reg)` from an immediate-form address operand. */
function parseAddressBase(text: string): { expression: string; baseRegister?: number } | undefined {
  const trimmed = text.trim();
  const close = findMatchingCloseParen(trimmed);
  if (close < 0) return { expression: trimmed };
  const after = trimmed.slice(close + 1).trim();
  if (!after.startsWith('(') || !after.endsWith(')')) return undefined;
  const baseText = after.slice(1, -1).trim();
  const base = parseGprRegisterForPseudo(baseText);
  if (base === undefined) return undefined;
  const expression = trimmed.slice(0, close).trim();
  return { expression: expression || '0', baseRegister: base };
}

function parseBareRegisterParen(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return undefined;
  return parseGprRegisterForPseudo(trimmed.slice(1, -1).trim());
}

function parseGprRegisterForPseudo(text: string): number | undefined {
  const normalized = text.trim().toLowerCase();
  if (/^\$\d{1,2}$/.test(normalized)) {
    const number = Number(normalized.slice(1));
    return number >= 0 && number <= 31 ? number : undefined;
  }
  // Reuse the shared table without importing registers.ts twice.
  return parseGprRegisterText(normalized);
}

function parseGprRegisterText(text: string): number | undefined {
  const names: readonly (readonly string[])[] = [
    ['$zero', '$0'], ['$at', '$1'], ['$v0', '$2'], ['$v1', '$3'],
    ['$a0', '$4'], ['$a1', '$5'], ['$a2', '$6'], ['$a3', '$7'],
    ['$t0', '$8'], ['$t1', '$9'], ['$t2', '$10'], ['$t3', '$11'],
    ['$t4', '$12'], ['$t5', '$13'], ['$t6', '$14'], ['$t7', '$15'],
    ['$s0', '$16'], ['$s1', '$17'], ['$s2', '$18'], ['$s3', '$19'],
    ['$s4', '$20'], ['$s5', '$21'], ['$s6', '$22'], ['$s7', '$23'],
    ['$t8', '$24'], ['$t9', '$25'], ['$k0', '$26'], ['$k1', '$27'],
    ['$gp', '$28'], ['$sp', '$29'], ['$fp', '$s8', '$30'], ['$ra', '$31']
  ];
  for (let register = 0; register < names.length; register++) {
    for (const name of names[register]) {
      if (name === text) return register;
    }
  }
  return undefined;
}

function findMatchingCloseParen(text: string): number {
  let quoted: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === quoted && !escaped) quoted = undefined;
      escaped = char === '\\' && !escaped;
      if (char !== '\\') escaped = false;
      continue;
    }
    if (char === '"' || char === "'") {
      quoted = char;
      continue;
    }
    if (char === ')') return index;
  }
  return -1;
}

function isPureInteger(text: string): boolean {
  return parsePureInteger(text) !== undefined;
}

function parsePureInteger(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let index = 0;
  let sign = 1;
  if (trimmed[index] === '-' || trimmed[index] === '+') {
    if (trimmed[index] === '-') sign = -1;
    index++;
  }
  const magnitude = parseUnsignedMagnitude(trimmed, index);
  if (magnitude === undefined) return undefined;
  const value = sign * magnitude;
  if (!Number.isSafeInteger(value) || value < -0x80000000 || value > 0xffffffff) return undefined;
  return value | 0;
}

function parseUnsignedMagnitude(text: string, index: number): number | undefined {
  if (index >= text.length) return undefined;
  if (text[index] === '0' && index + 1 === text.length) return 0;
  let radix = 10;
  let cursor = index;
  if (text[index] === '0' && index + 1 < text.length) {
    const prefix = text[index + 1].toLowerCase();
    if (prefix === 'x') {
      radix = 16;
      cursor = index + 2;
    } else if (prefix === 'b') {
      radix = 2;
      cursor = index + 2;
    } else {
      radix = 8;
      cursor = index + 1;
    }
  }
  let value = 0;
  let digits = 0;
  for (; cursor < text.length; cursor++) {
    const digit = digitValueForPseudo(text[cursor]);
    if (digit === undefined || digit >= radix) break;
    value = value * radix + digit;
    digits++;
  }
  return digits > 0 ? value : undefined;
}

function digitValueForPseudo(char: string): number | undefined {
  if (char >= '0' && char <= '9') return char.charCodeAt(0) - 48;
  const lower = char.toLowerCase();
  if (lower >= 'a' && lower <= 'f') return lower.charCodeAt(0) - 87;
  return undefined;
}

function containsArithmetic(text: string): boolean {
  return /[+\-*/%&|^~<>]/.test(text.replace(/\s/g, ''));
}

export function realInstructionWithOperands(
  statement: ParsedStatement,
  mnemonic: string,
  operands: readonly WorkOperand[],
  pseudoMnemonic?: string
): WorkInstruction {
  return {
    mnemonic,
    operands,
    origin: workOriginFor(statement),
    pseudo: pseudoMnemonic !== undefined,
    ...(pseudoMnemonic ? { pseudoMnemonic } : {})
  };
}

