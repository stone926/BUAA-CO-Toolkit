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

export const defaultInstructionSets: Record<CpuProfile, string[]> = cloneProfiles(generatorInstructionCatalog.profiles);

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

function cloneProfiles(profiles: Record<CpuProfile, string[]>): Record<CpuProfile, string[]> {
  return {
    P3: [...profiles.P3],
    P4: [...profiles.P4],
    P5: [...profiles.P5],
    P6: [...profiles.P6],
    P7: [...profiles.P7]
  };
}
