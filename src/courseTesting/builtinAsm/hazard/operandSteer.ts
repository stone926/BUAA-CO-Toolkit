// @index operand-steer — 冒险块对内置生成器单条指令的操作数约束（绑定源/目的寄存器、立即数、地址、取值谓词）
import { SourceRole } from '../../../hazardAnalysis/hazardTiming';

export interface OperandSteer {
  /** Destination register; the emitter chooses one when absent. */
  readonly write?: string;
  /** Source registers bound to operand roles (`rs` is the memory base). */
  readonly reads?: Partial<Record<SourceRole, string>>;
  readonly immediate?: number;
  readonly shamt?: number;
  /** Exact effective address for a load or store. */
  readonly address?: number;
  /** Destinations an unbound choice must avoid, so a hazard register survives its gap. */
  readonly avoidWrites?: ReadonlySet<string>;
  /** Draw unbound sources from small values (address bases, overflow-free arithmetic). */
  readonly preferSmallReads?: boolean;
  /** Required property of the produced value (before `$0` discards it) for a destination. */
  readonly accept?: (value: number, destination: string) => boolean;
  /** Value a faulty forward/priority would deliver on a bound source; prefer operands it changes. */
  readonly wrong?: { readonly role: SourceRole; readonly value: number };
}

export interface SteeredEmission {
  readonly write?: string;
  readonly value?: number;
}
