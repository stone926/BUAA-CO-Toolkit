// @index mips-core — 真实指令 operand form 投影（generated catalog 之外不另设语义源）

import { IsaInstructionEntry } from '../generated/isaCatalog';

export type RealOperandForm =
  | { readonly kind: 'register'; readonly role: 'rs' | 'rt' | 'rd' }
  | { readonly kind: 'shamt' }
  | { readonly kind: 'immediate' }
  | { readonly kind: 'label' }
  | { readonly kind: 'memory' }
  | { readonly kind: 'cp0' };

const rStandard = (entry: IsaInstructionEntry): RealOperandForm[] => [
  { kind: 'register', role: 'rd' },
  { kind: 'register', role: 'rs' },
  { kind: 'register', role: 'rt' }
];

const rStandardRs = (entry: IsaInstructionEntry): RealOperandForm[] => [
  { kind: 'register', role: 'rd' },
  { kind: 'register', role: 'rs' }
];

const rStandardRsRt = (entry: IsaInstructionEntry): RealOperandForm[] => [
  { kind: 'register', role: 'rs' },
  { kind: 'register', role: 'rt' }
];

export function realInstructionForms(mnemonic: string, entry: IsaInstructionEntry): readonly RealOperandForm[] {
  if (mnemonic === 'nop' || mnemonic === 'eret' || mnemonic === 'syscall') return [];
  switch (entry.formatKind) {
    case 'r': {
      if (mnemonic === 'sll' || mnemonic === 'srl' || mnemonic === 'sra') {
        return [
          { kind: 'register', role: 'rd' },
          { kind: 'register', role: 'rt' },
          { kind: 'shamt' }
        ];
      }
      if (mnemonic === 'jr') return [{ kind: 'register', role: 'rs' }];
      if (mnemonic === 'jalr') {
        return [
          { kind: 'register', role: 'rd' },
          { kind: 'register', role: 'rs' }
        ];
      }
      if (mnemonic === 'mfhi' || mnemonic === 'mflo') {
        return [{ kind: 'register', role: 'rd' }];
      }
      if (mnemonic === 'mthi' || mnemonic === 'mtlo') {
        return [{ kind: 'register', role: 'rs' }];
      }
      if (mnemonic === 'mult' || mnemonic === 'multu' || mnemonic === 'div' || mnemonic === 'divu'
        || mnemonic === 'tge' || mnemonic === 'tgeu' || mnemonic === 'tlt' || mnemonic === 'tltu'
        || mnemonic === 'teq' || mnemonic === 'tne') {
        return rStandardRsRt(entry);
      }
      return rStandard(entry);
    }
    case 'special2': {
      if (mnemonic === 'clz' || mnemonic === 'clo') return rStandardRs(entry);
      if (mnemonic === 'mul') return rStandard(entry);
      return rStandardRsRt(entry);
    }
    case 'regimm':
      return entry.controlKind === 'trap'
        ? [{ kind: 'register', role: 'rs' }, { kind: 'immediate' }]
        : [{ kind: 'register', role: 'rs' }, { kind: 'label' }];
    case 'j':
      return [{ kind: 'label' }];
    case 'branch':
      return entry.gprReads.includes('rt')
        ? [
          { kind: 'register', role: 'rs' },
          { kind: 'register', role: 'rt' },
          { kind: 'label' }
        ]
        : [
          { kind: 'register', role: 'rs' },
          { kind: 'label' }
        ];
    case 'imm':
      return mnemonic === 'lui'
        ? [{ kind: 'register', role: 'rt' }, { kind: 'immediate' }]
        : [
          { kind: 'register', role: 'rt' },
          { kind: 'register', role: 'rs' },
          { kind: 'immediate' }
        ];
    case 'load':
    case 'store':
      return [
        { kind: 'register', role: 'rt' },
        { kind: 'memory' }
      ];
    case 'cop0':
      return [
        { kind: 'register', role: 'rt' },
        { kind: 'cp0' }
      ];
    case 'eret':
      return [];
    default:
      throw new Error(`no operand form for ${mnemonic} (${entry.formatKind})`);
  }
}

