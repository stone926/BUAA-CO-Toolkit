// @index hazard-instruction — 把生成器发出的 ASM 行解码为冒险模型所需的读写寄存器事实（按指令格式与 ISA 目录）
import { parseGprRegister } from '../mips/core/assembler/registers';
import { realInstructionForms } from '../mips/core/assembler/instructionForms';
import { isaInstructionByMnemonic } from '../mips/core/generated/isaCatalog';
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
  // Share the assembler's real operand order without loading LSP display resources.
  const entry = isaInstructionByMnemonic.get(mnemonic);
  const layout = entry ? realInstructionForms(mnemonic, entry).map((form): OperandSlot => {
    if (form.kind === 'register') return form;
    return { kind: form.kind === 'memory' ? 'base' : 'other' };
  }) : null;
  layoutCache.set(mnemonic, layout);
  return layout ?? undefined;
}

function numericRegister(operand: string): string | undefined {
  const number = parseGprRegister(operand);
  return number === undefined ? undefined : `$${number}`;
}
