import { TRACE_PROFILES } from '../constants';
import { ProjectProfile } from '../projectProfile';
import { generatorInstructionCatalog, type CpuProfile } from './generatorInstructionCatalog';

export type { CpuProfile } from './generatorInstructionCatalog';
export type MduReadProbeMode = 'busy' | 'ready';

export type ControlMnemonic =
  | 'beq'
  | 'bne'
  | 'bgez'
  | 'bgtz'
  | 'blez'
  | 'bltz'
  | 'bgezal'
  | 'bltzal'
  | 'j'
  | 'jal'
  | 'jr'
  | 'jalr';

export const cpuProfiles = TRACE_PROFILES;

/** Stable-order profile projections generated from the versioned ISA catalog. */
export const defaultInstructionSets: Record<CpuProfile, string[]> = {
  P3: [...generatorInstructionCatalog.profiles.P3],
  P4: [...generatorInstructionCatalog.profiles.P4],
  P5: [...generatorInstructionCatalog.profiles.P5],
  P6: [...generatorInstructionCatalog.profiles.P6],
  P7: [...generatorInstructionCatalog.profiles.P7]
};

export const supportedMnemonics = new Set(generatorInstructionCatalog.categories.supported);
export const controlMnemonics = new Set<string>(generatorInstructionCatalog.categories.control);
export const branchMnemonics = new Set<string>(generatorInstructionCatalog.categories.branch);
export const linkBranchMnemonics = new Set<string>(generatorInstructionCatalog.categories.linkBranch);
export const jumpLinkMnemonics = new Set<string>(generatorInstructionCatalog.categories.jumpLink);
export const divideMnemonics = new Set<string>(generatorInstructionCatalog.categories.divide);
export const hiLoWriteMnemonics = new Set<string>(generatorInstructionCatalog.categories.hiLoWrite);
export const hiLoReadMnemonics = new Set<string>(generatorInstructionCatalog.categories.hiLoRead);
export const longLatencyHiLoWriteMnemonics = new Set<string>(generatorInstructionCatalog.categories.longLatencyHiLoWrite);
export const loadMnemonics = new Set<string>(generatorInstructionCatalog.categories.load);
export const storeMnemonics = new Set<string>(generatorInstructionCatalog.categories.store);
export const cp0Mnemonics = new Set<string>(generatorInstructionCatalog.categories.cp0);

export function falseTrapImmediateOperands(mnemonic: string): [string, string] {
  return generatorInstructionCatalog.falseTrapImmediateOperands[mnemonic]
    ?? generatorInstructionCatalog.falseTrapImmediateOperands.default
    ?? ['$0', '0'];
}

export function memoryAlignment(mnemonic: string): number {
  return generatorInstructionCatalog.memoryAlignment[mnemonic]
    ?? generatorInstructionCatalog.memoryAlignment.default
    ?? 1;
}

export function mduBusyCycles(mnemonic: string): number {
  return generatorInstructionCatalog.mduBusyCycles[mnemonic]
    ?? generatorInstructionCatalog.mduBusyCycles.default
    ?? 5;
}
