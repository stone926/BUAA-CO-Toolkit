// @index hazard-instruction — 把生成器发出的 ASM 行解码为冒险模型所需的读写寄存器事实（按指令格式与 ISA 目录）
import { canonicalRegister, instructions, numericRegisters } from '../../../language/mips/resources';
import { isaInstructionByMnemonic } from '../../../mips/core/generated/isaCatalog';
import {
  hazardClassOf,
  hazardReadyStage,
  hazardUseStage,
  HazardClass,
  mduBusyCycleCount,
  PipelineStage,
  SourceRole,
  usesMultiplyDivideUnit
} from './hazardTiming';

export interface HazardRead {
  readonly register: string;
  readonly role: SourceRole;
  readonly useStage: PipelineStage;
}

export interface HazardInstruction {
  readonly mnemonic: string;
  readonly hazardClass: HazardClass;
  readonly reads: readonly HazardRead[];
  /** Destination GPR in `$n` form, including `$0` so zero-destination hazards stay visible. */
  readonly write?: { readonly register: string; readonly readyStage: PipelineStage };
  readonly hiLoReads: readonly ('hi' | 'lo')[];
  readonly hiLoWrites: readonly ('hi' | 'lo')[];
  readonly usesMdu: boolean;
  readonly mduBusyCycles: number;
}

export type RegisterField = 'rd' | 'rs' | 'rt';
type OperandSlot = { kind: 'register'; role: RegisterField } | { kind: 'base' } | { kind: 'other' };

const layoutCache = new Map<string, readonly OperandSlot[] | null>();
const numericByCanonical = new Map(numericRegisters().map((register) => [canonicalRegister(register), register]));

/** Decodes one generated instruction line; returns undefined for directives and unknown text. */
export function decodeHazardInstruction(text: string): HazardInstruction | undefined {
  const match = /^\s*([a-z][a-z0-9]*)\b\s*(.*)$/i.exec(text);
  if (!match) {
    return undefined;
  }
  const mnemonic = match[1].toLowerCase();
  const layout = operandLayout(mnemonic);
  if (!layout) {
    return undefined;
  }
  const operands = match[2].trim() ? match[2].split(',').map((operand) => operand.trim()) : [];
  const registers: Partial<Record<RegisterField, string>> = {};
  layout.forEach((slot, index) => {
    const operand = operands[index];
    if (operand === undefined || slot.kind === 'other') {
      return;
    }
    if (slot.kind === 'base') {
      const base = /\((\$[a-z0-9]+)\)\s*$/i.exec(operand)?.[1];
      const register = base ? numericRegister(base) : undefined;
      if (register) registers.rs = register;
      return;
    }
    const register = numericRegister(operand);
    if (register) registers[slot.role] = register;
  });
  return hazardInstructionFor(mnemonic, registers);
}

/** Builds the hazard facts of `mnemonic` whose register fields hold the given `$n` registers. */
export function hazardInstructionFor(
  mnemonic: string,
  registers: Partial<Record<RegisterField, string>>
): HazardInstruction | undefined {
  const entry = isaInstructionByMnemonic.get(mnemonic);
  if (!entry) {
    return undefined;
  }
  const reads: HazardRead[] = [];
  for (const role of ['rs', 'rt'] as const) {
    const register = registers[role];
    if (register && (entry.gprReads as readonly unknown[]).includes(role)) {
      reads.push({ register, role, useStage: hazardUseStage(mnemonic, role) });
    }
  }
  const destination = entry.gprWrites[0];
  const writeRegister = typeof destination === 'number'
    ? `$${destination}`
    : destination === 'rd' || destination === 'rs' || destination === 'rt'
      ? registers[destination]
      : undefined;
  return {
    mnemonic,
    hazardClass: hazardClassOf(mnemonic),
    reads,
    write: writeRegister ? { register: writeRegister, readyStage: hazardReadyStage(mnemonic) } : undefined,
    hiLoReads: entry.hiloReads as readonly ('hi' | 'lo')[],
    hiLoWrites: entry.hiloWrites as readonly ('hi' | 'lo')[],
    usesMdu: usesMultiplyDivideUnit(mnemonic),
    mduBusyCycles: mduBusyCycleCount(mnemonic)
  };
}

function operandLayout(mnemonic: string): readonly OperandSlot[] | undefined {
  const cached = layoutCache.get(mnemonic);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  // The first documented format is the canonical real-instruction operand order.
  const format = instructions[mnemonic]?.formats[0];
  const operandText = format?.replace(/^\S+\s*/, '') ?? '';
  const layout = format === undefined
    ? null
    : operandText.split(',').filter((operand) => operand.trim()).map((operand): OperandSlot => {
      const token = operand.trim();
      if (/\(\$base\)$/.test(token)) return { kind: 'base' };
      if (token === '$rd' || token === '$rs' || token === '$rt') {
        return { kind: 'register', role: token.slice(1) as RegisterField };
      }
      return { kind: 'other' };
    });
  layoutCache.set(mnemonic, layout);
  return layout ?? undefined;
}

function numericRegister(operand: string): string | undefined {
  if (/^\$(?:[0-9]|[12][0-9]|3[01])$/.test(operand)) {
    return operand;
  }
  return numericByCanonical.get(canonicalRegister(operand));
}
