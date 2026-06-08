import { ProjectProfile } from '../projectProfile';

export type CpuProfile = 'P3' | 'P4' | 'P5' | 'P6' | 'P7';
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

export const cpuProfiles = new Set<ProjectProfile>(['P3', 'P4', 'P5', 'P6', 'P7']);

export const defaultInstructionSets: Record<CpuProfile, string[]> = {
  P3: ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'nop'],
  P4: ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'jal', 'jr', 'nop'],
  P5: ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'jal', 'jr', 'nop'],
  P6: [
    'add', 'sub', 'and', 'or', 'slt', 'sltu', 'lui',
    'addi', 'andi', 'ori',
    'lb', 'lh', 'lw', 'sb', 'sh', 'sw',
    'mult', 'multu', 'div', 'divu', 'mfhi', 'mflo', 'mthi', 'mtlo',
    'beq', 'bne', 'jal', 'jr'
  ],
  P7: [
    'nop', 'add', 'sub', 'and', 'or', 'slt', 'sltu', 'lui',
    'addi', 'andi', 'ori',
    'lb', 'lh', 'lw', 'sb', 'sh', 'sw',
    'mult', 'multu', 'div', 'divu', 'mfhi', 'mflo', 'mthi', 'mtlo',
    'beq', 'bne', 'jal', 'jr',
    'mfc0', 'mtc0', 'eret', 'syscall'
  ]
};

export const supportedMnemonics = new Set([
  'add', 'addu', 'addi', 'addiu', 'sub', 'subu',
  'and', 'andi', 'or', 'ori', 'xor', 'xori', 'nor',
  'slt', 'sltu', 'slti', 'sltiu',
  'sll', 'srl', 'sra', 'sllv', 'srlv', 'srav',
  'lui', 'clz', 'clo',
  'lw', 'lwl', 'lwr', 'sw', 'swl', 'swr', 'lb', 'lbu', 'lh', 'lhu', 'sb', 'sh',
  'beq', 'bne', 'bgez', 'bgtz', 'blez', 'bltz', 'bgezal', 'bltzal',
  'j', 'jal', 'jr', 'jalr',
  'movn', 'movz',
  'mul', 'madd', 'maddu', 'msub', 'msubu', 'mult', 'multu', 'div', 'divu', 'mfhi', 'mflo', 'mthi', 'mtlo',
  'mfc0', 'mtc0',
  'eret', 'syscall',
  'teq', 'tne', 'tge', 'tgeu', 'tlt', 'tltu',
  'teqi', 'tnei', 'tgei', 'tgeiu', 'tlti', 'tltiu',
  'nop'
]);

export const controlMnemonics = new Set<string>([
  'beq', 'bne', 'bgez', 'bgtz', 'blez', 'bltz', 'bgezal', 'bltzal',
  'j', 'jal', 'jr', 'jalr'
]);

export const branchMnemonics = new Set<string>([
  'beq', 'bne', 'bgez', 'bgtz', 'blez', 'bltz', 'bgezal', 'bltzal'
]);

export const linkBranchMnemonics = new Set<string>(['bgezal', 'bltzal']);
export const jumpLinkMnemonics = new Set<string>(['jal', 'jalr']);
export const divideMnemonics = new Set<string>(['div', 'divu']);
export const hiLoWriteMnemonics = new Set<string>(['mult', 'multu', 'div', 'divu', 'madd', 'maddu', 'msub', 'msubu', 'mthi', 'mtlo']);
export const hiLoReadMnemonics = new Set<string>(['mfhi', 'mflo']);
export const longLatencyHiLoWriteMnemonics = new Set<string>(['mult', 'multu', 'div', 'divu']);
export const loadMnemonics = new Set<string>(['lw', 'lwl', 'lwr', 'lb', 'lbu', 'lh', 'lhu']);
export const storeMnemonics = new Set<string>(['sw', 'swl', 'swr', 'sb', 'sh']);
export const cp0Mnemonics = new Set<string>(['mfc0', 'mtc0']);

export function falseTrapImmediateOperands(mnemonic: string): [string, string] {
  switch (mnemonic) {
    case 'teqi':
      return ['$0', '1'];
    case 'tnei':
      return ['$0', '0'];
    case 'tgei':
    case 'tgeiu':
      return ['$0', '1'];
    case 'tlti':
      return ['$0', '-1'];
    case 'tltiu':
      return ['$0', '0'];
    default:
      return ['$0', '0'];
  }
}

export function memoryAlignment(mnemonic: string): number {
  if (mnemonic === 'lw' || mnemonic === 'sw' || mnemonic === 'lwl' || mnemonic === 'lwr' || mnemonic === 'swl' || mnemonic === 'swr') {
    return 4;
  }
  if (mnemonic === 'lh' || mnemonic === 'lhu' || mnemonic === 'sh') {
    return 2;
  }
  return 1;
}

export function mduBusyCycles(mnemonic: string): number {
  return mnemonic === 'div' || mnemonic === 'divu' ? 10 : 5;
}
