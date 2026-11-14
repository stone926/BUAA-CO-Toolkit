// @index mips-core — Versioned, host-free custom instruction SDK and serializable metadata
import type { CourseProfile } from '../generated/isaCatalog';
import type { ArchitectureExceptionName } from '../profiles/profile';

export type CustomInstructionMode = CourseProfile | 'mars';
export type CustomInstructionOperand =
  | { readonly kind: 'register'; readonly field: string }
  | { readonly kind: 'immediate'; readonly field: string; readonly signed?: boolean; readonly relocation?: 'branch' | 'jump' }
  | { readonly kind: 'memory'; readonly baseField: string; readonly offsetField: string; readonly signed?: boolean };
export interface CustomInstructionAccess {
  readonly reads?: readonly string[];
  readonly writes?: readonly string[];
  readonly memory?: 'load' | 'store';
  readonly width?: 1 | 2 | 4;
}
export interface CustomInstructionGeneration {
  readonly weight?: number;
  /** Constrain raw fields; absent fields use their encoding width. */
  readonly fields?: Readonly<Record<string, {
    readonly min?: number; readonly max?: number; readonly values?: readonly number[];
    /** A register containing a legal course-DM address (also supports register-only memory syntax). */
    readonly address?: { readonly alignment?: 1 | 2 | 4; readonly width?: 1 | 2 | 4 };
  }>>;
  /** Bounded control recipe: this field encodes the forward merge target. */
  readonly control?: {
    readonly targetField: string; readonly relocation: 'branch' | 'jump' | 'absolute';
    /** Some course branches additionally scale their displacement using a GPR value. */
    readonly shiftBy?: { readonly field: string; readonly mask: number };
  };
  /** Optional controlled operand cases; the generator materializes these register values before emission. */
  readonly cases?: readonly { readonly registerValues: Readonly<Record<string, number>> }[];
}
export interface CustomInstructionContext {
  readonly pc: number;
  readonly delaySlot: boolean;
  readonly linkAddress: number;
  readGpr(register: number): number;
  readHi(): number;
  readLo(): number;
  /** At most one architectural memory access per instruction. Faults commit no effects. */
  load(address: number, width: 1 | 2 | 4, signed?: boolean, addressOverflow?: boolean): number;
}
export interface CustomInstructionEffect {
  readonly gprWrites?: readonly { readonly register: number; readonly value: number }[];
  readonly hiLoWrites?: readonly { readonly register: 'hi' | 'lo'; readonly value: number }[];
  readonly store?: { readonly address: number; readonly width: 1 | 2 | 4; readonly value: number; readonly addressOverflow?: boolean };
  readonly control?: { readonly target: number; readonly taken: boolean; readonly annulDelaySlot?: boolean };
  readonly trap?: { readonly name: ArchitectureExceptionName; readonly message?: string };
}
export interface CustomInstructionMetadata {
  readonly apiVersion: 1;
  readonly mnemonic: string;
  /** Alternate assembly names sharing this exact encoding and execute callback. */
  readonly aliases?: readonly string[];
  readonly modes: readonly CustomInstructionMode[];
  /** Space-separated fixed bits and named widths, totaling 32 bits, MSB first. */
  readonly encoding: string;
  readonly operands: readonly CustomInstructionOperand[];
  readonly access?: CustomInstructionAccess;
  readonly controlFlow?: boolean;
  readonly override?: boolean;
  readonly generation?: CustomInstructionGeneration;
  readonly timing?: {
    readonly latency?: number; readonly initiationInterval?: number;
    /** Optional course AT facts. Omission deliberately excludes this instruction from coverage. */
    readonly hazardClass?: 'cal_rr' | 'cal_ri' | 'br_r1' | 'br_r2' | 'mv_fr' | 'mv_to' | 'load' | 'store' | 'mul_div' | 'lui' | 'jal' | 'jalr' | 'jr' | 'cp0_fr' | 'cp0_to' | 'trap' | 'other';
    readonly reads?: readonly { readonly field: string; readonly role: 'rs' | 'rt'; readonly useStage: 'D' | 'E' | 'M' | 'W' }[];
    readonly readyStage?: 'D' | 'E' | 'M' | 'W';
  };
}
export interface CustomInstructionDefinition extends CustomInstructionMetadata {
  execute(context: CustomInstructionContext, fields: Readonly<Record<string, number>>): CustomInstructionEffect;
}
/** Identity helper provides contextual types in TypeScript instruction modules. */
export function defineInstruction(definition: CustomInstructionDefinition): CustomInstructionDefinition { return definition; }
