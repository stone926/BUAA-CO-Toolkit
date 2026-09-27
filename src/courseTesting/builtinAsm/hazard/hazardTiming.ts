// @index hazard-timing — 课程 AT 法：指令冒险类别、各源操作数 Tuse 阶段与写回值就绪阶段
import { isaInstructionByMnemonic } from '../../../mips/core/generated/isaCatalog';
import { hiLoReadMnemonics, hiLoWriteMnemonics, longLatencyHiLoWriteMnemonics, mduBusyCycles } from '../../mnemonicSets';

export type PipelineStage = 'D' | 'E' | 'M' | 'W';
export type SourceRole = 'rs' | 'rt';

/**
 * Class names follow the course Hazard-Calculator strength table (P5-4-5). Instructions outside
 * the MIPS-C3 course set map to the course class they share a forwarding/stall datapath with.
 */
export type HazardClass =
  | 'cal_rr' | 'cal_ri' | 'br_r1' | 'br_r2' | 'mv_fr' | 'mv_to' | 'load' | 'store'
  | 'mul_div' | 'lui' | 'jal' | 'jalr' | 'jr' | 'cp0_fr' | 'cp0_to' | 'trap' | 'other';

export const pipelineStageIndex: Readonly<Record<PipelineStage, number>> = { D: 1, E: 2, M: 3, W: 4 };
export const pipelineStages: readonly PipelineStage[] = ['D', 'E', 'M', 'W'];

const courseClasses: Readonly<Record<string, readonly string[]>> = {
  cal_rr: ['add', 'addu', 'sub', 'subu', 'slt', 'sltu', 'and', 'nor', 'or', 'xor', 'sllv', 'srav', 'srlv',
    'mul', 'clz', 'clo', 'movn', 'movz'],
  cal_ri: ['addi', 'addiu', 'slti', 'sltiu', 'andi', 'ori', 'xori', 'sll', 'sra', 'srl'],
  br_r1: ['bgez', 'bgtz', 'blez', 'bltz', 'bgezal', 'bltzal'],
  br_r2: ['beq', 'bne'],
  mv_fr: ['mfhi', 'mflo'],
  mv_to: ['mthi', 'mtlo'],
  load: ['lw', 'lh', 'lhu', 'lb', 'lbu', 'lwl', 'lwr'],
  store: ['sw', 'sh', 'sb', 'swl', 'swr'],
  mul_div: ['mult', 'multu', 'div', 'divu', 'madd', 'maddu', 'msub', 'msubu'],
  lui: ['lui'],
  jal: ['jal'],
  jalr: ['jalr'],
  jr: ['jr'],
  cp0_fr: ['mfc0'],
  cp0_to: ['mtc0'],
  trap: ['teq', 'tne', 'tge', 'tgeu', 'tlt', 'tltu', 'teqi', 'tnei', 'tgei', 'tgeiu', 'tlti', 'tltiu']
};

const classByMnemonic = new Map<string, HazardClass>(
  Object.entries(courseClasses).flatMap(([hazardClass, mnemonics]) =>
    mnemonics.map((mnemonic) => [mnemonic, hazardClass as HazardClass] as const))
);

export function hazardClassOf(mnemonic: string): HazardClass {
  return classByMnemonic.get(mnemonic) ?? 'other';
}

/** Stage at which the value read through `role` must be correct (course Tuse, counted from D). */
export function hazardUseStage(mnemonic: string, role: SourceRole): PipelineStage {
  const hazardClass = hazardClassOf(mnemonic);
  if (hazardClass === 'br_r1' || hazardClass === 'br_r2' || hazardClass === 'jr' || hazardClass === 'jalr') {
    return 'D';
  }
  if (role === 'rt' && (hazardClass === 'store' || hazardClass === 'cp0_to' || mnemonic === 'lwl' || mnemonic === 'lwr')) {
    return 'M';
  }
  return 'E';
}

/**
 * Stage from which the produced GPR value can be forwarded. The course reference pipeline
 * completes LUI and link addresses in D, ALU/HI-LO reads in E, and loads/CP0 reads in M.
 */
export function hazardReadyStage(mnemonic: string): PipelineStage {
  const hazardClass = hazardClassOf(mnemonic);
  if (hazardClass === 'lui' || hazardClass === 'jal' || hazardClass === 'jalr' || hazardClass === 'br_r1') {
    return 'E';
  }
  if (hazardClass === 'load' || hazardClass === 'cp0_fr') {
    return 'W';
  }
  return 'M';
}

/** Cycles after E during which the multiply/divide unit is busy; zero for other instructions. */
export function mduBusyCycleCount(mnemonic: string): number {
  return longLatencyHiLoWriteMnemonics.has(mnemonic) ? mduBusyCycles(mnemonic) : 0;
}

export function usesMultiplyDivideUnit(mnemonic: string): boolean {
  return hiLoReadMnemonics.has(mnemonic) || hiLoWriteMnemonics.has(mnemonic);
}

/** Source roles that the ISA catalog reports as GPR reads, in stable rs/rt order. */
export function hazardSourceRoles(mnemonic: string): SourceRole[] {
  const reads = isaInstructionByMnemonic.get(mnemonic)?.gprReads ?? [];
  return (['rs', 'rt'] as const).filter((role) => (reads as readonly unknown[]).includes(role));
}

/** True when the instruction writes a GPR that a younger instruction can consume. */
export function producesGeneralRegister(mnemonic: string): boolean {
  return (isaInstructionByMnemonic.get(mnemonic)?.gprWrites.length ?? 0) > 0;
}
