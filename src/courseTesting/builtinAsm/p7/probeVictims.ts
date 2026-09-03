// @index p7-probe-victims — P7 精确异常触发序列规划与 EPC/受害 PC 定位
import { Random } from '../../random';
import { BuiltinAsmGeneratorError } from '../randomBody';
import { p7RiWordDirective, p7RiWordEntry } from '../../p7RiWords';
import { P7ProbeScenarioKind } from '../types';
import { loadImmediateInstructions, probeUserScratchRegisters } from './probeAsm';
import {
  p7Timer0Count,
  p7Timer0Ctrl,
  p7Timer0Preset,
  p7Timer1Count,
  p7Timer1Ctrl,
  p7Timer1Preset
} from './constants';

const p7DmEndExclusive = 0x3000;
const p7InvalidFetchPc = 0x7000;
const p7MisalignedFetchPc = 0x3002;

export const p7ProbeHiSentinel = 0x13579bdf;
export const p7ProbeLoSentinel = 0x2468ace0;
export const p7ProbeTimerPresetSentinel = 0x13579bdf;

type TimerRegister = 'ctrl' | 'preset' | 'count';
const timerRegisters: readonly Record<TimerRegister, number>[] = [
  { ctrl: p7Timer0Ctrl, preset: p7Timer0Preset, count: p7Timer0Count },
  { ctrl: p7Timer1Ctrl, preset: p7Timer1Preset, count: p7Timer1Count }
];

export type P7ProbeTimerObservation =
  | 'timer0-ctrl'
  | 'timer0-preset'
  | 'timer0-count'
  | 'timer1-ctrl'
  | 'timer1-preset'
  | 'timer1-count';

export interface InternalExceptionVictim {
  epc: number;
  expectedBd: boolean;
  victimPc: number;
}

export interface InternalExceptionVictimPlan {
  instructions: string[];
  expectedBd: boolean;
  epcInstructionIndex?: number;
  victimInstructionIndex?: number;
  exceptionPc?: number;
  recordHiLo?: boolean;
  timerObservation?: P7ProbeTimerObservation;
  allowedAuxPairs?: Array<[number, number]>;
  auxPairDescription?: string;
  requireEqualAuxPair?: boolean;
}

export function planInternalExceptionVictim(
  kind: P7ProbeScenarioKind,
  variant: string | undefined,
  rng: Random,
  doneLabel: string
): InternalExceptionVictimPlan {
  switch (kind) {
    case 'adel':
      return planAdelVictim(variant, rng, doneLabel);
    case 'ades':
      return planAdesVictim(variant, rng, doneLabel);
    case 'syscall':
      if (variant?.startsWith('young-')) {
        return planYoungerMduVictim(variant);
      }
      if (variant === 'post-eret-status') {
        return directVictimPlan(['syscall']);
      }
      return {
        instructions: [`beq $0, $0, ${doneLabel}`, 'syscall'],
        expectedBd: true,
        epcInstructionIndex: 0,
        victimInstructionIndex: 1
      };
    case 'ri': {
      const entry = p7RiWordEntry(variant);
      if (!entry) {
        throw new BuiltinAsmGeneratorError(`Internal generator error: unsupported P7 RI probe variant ${String(variant)}.`);
      }
      return {
        instructions: [`bne $0, $0, ${doneLabel}`, p7RiWordDirective(entry)],
        expectedBd: true,
        epcInstructionIndex: 0,
        victimInstructionIndex: 1
      };
    }
    case 'ov':
      return planOverflowVictim(variant, doneLabel);
    case 'internal':
      return directVictimPlan([
        ...loadImmediateInstructions('$1', 0x80000000),
        'addi $2, $1, -1'
      ]);
    default:
      throw new BuiltinAsmGeneratorError(`Internal generator error: unsupported P7 probe internal scenario ${kind}.`);
  }
}

export function resolveInternalExceptionVictim(
  plan: InternalExceptionVictimPlan,
  sequencePc: number
): InternalExceptionVictim {
  if (plan.exceptionPc !== undefined) {
    return {
      epc: plan.exceptionPc,
      expectedBd: plan.expectedBd,
      victimPc: plan.exceptionPc
    };
  }
  if (plan.epcInstructionIndex === undefined || plan.victimInstructionIndex === undefined) {
    throw new BuiltinAsmGeneratorError('Internal generator error: incomplete P7 probe victim plan.');
  }
  return {
    epc: sequencePc + plan.epcInstructionIndex * 4,
    expectedBd: plan.expectedBd,
    victimPc: sequencePc + plan.victimInstructionIndex * 4
  };
}

function planAdelVictim(variant: string | undefined, rng: Random, doneLabel: string): InternalExceptionVictimPlan {
  const target = rng.pick(probeUserScratchRegisters);
  switch (variant) {
    case 'misaligned-load-delay-taken':
      return delaySlotVictimPlan([], `lw ${target}, 1($0)`, doneLabel, true);
    case 'misaligned-load-delay-not-taken':
      return delaySlotVictimPlan([], `lw ${target}, 1($0)`, doneLabel, false);
    case 'misaligned-half-load-delay-taken':
      return delaySlotVictimPlan([], `lh ${target}, 1($0)`, doneLabel, true);
    case 'misaligned-half-load-delay-not-taken':
      return delaySlotVictimPlan([], `lh ${target}, 1($0)`, doneLabel, false);
    case 'ea-overflow-load':
      return directVictimPlan([
        ...loadImmediateInstructions('$20', 0x7fffffff),
        `lw ${target}, 1($20)`
      ]);
    case 'dm-out-of-range-load':
      return directVictimPlan([`lw ${target}, ${hex(p7DmEndExclusive)}($0)`]);
    case 'timer-byte-load':
      return planTimerLoadVictim(0, 'ctrl', 'lb', target);
    case 'timer-half-load':
      return planTimerLoadVictim(0, 'ctrl', 'lh', target);
    case 'timer0-preset-byte-load':
      return planTimerLoadVictim(0, 'preset', 'lb', target);
    case 'timer0-preset-half-load':
      return planTimerLoadVictim(0, 'preset', 'lh', target);
    case 'timer0-count-byte-load':
      return planTimerLoadVictim(0, 'count', 'lb', target);
    case 'timer0-count-half-load':
      return planTimerLoadVictim(0, 'count', 'lh', target);
    case 'timer1-ctrl-byte-load':
      return planTimerLoadVictim(1, 'ctrl', 'lb', target);
    case 'timer1-ctrl-half-load':
      return planTimerLoadVictim(1, 'ctrl', 'lh', target);
    case 'timer1-preset-byte-load':
      return planTimerLoadVictim(1, 'preset', 'lb', target);
    case 'timer1-preset-half-load':
      return planTimerLoadVictim(1, 'preset', 'lh', target);
    case 'timer1-count-byte-load':
      return planTimerLoadVictim(1, 'count', 'lb', target);
    case 'timer1-count-half-load':
      return planTimerLoadVictim(1, 'count', 'lh', target);
    case 'invalid-fetch':
      return {
        instructions: [...loadImmediateInstructions('$20', p7InvalidFetchPc), 'jr $20', 'nop'],
        expectedBd: false,
        exceptionPc: p7InvalidFetchPc
      };
    case 'misaligned-fetch':
      return {
        instructions: [...loadImmediateInstructions('$20', p7MisalignedFetchPc), 'jr $20', 'nop'],
        expectedBd: false,
        exceptionPc: p7MisalignedFetchPc
      };
    default:
      throw new BuiltinAsmGeneratorError(`Internal generator error: unsupported P7 AdEL probe variant ${String(variant)}.`);
  }
}

function planAdesVictim(variant: string | undefined, rng: Random, doneLabel: string): InternalExceptionVictimPlan {
  const source = rng.pick(probeUserScratchRegisters);
  switch (variant) {
    case 'misaligned-store-delay-taken':
      return delaySlotVictimPlan([], `sw ${source}, 1($0)`, doneLabel, true);
    case 'misaligned-store-delay-not-taken':
      return delaySlotVictimPlan([], `sw ${source}, 1($0)`, doneLabel, false);
    case 'misaligned-half-store-delay-taken':
      return delaySlotVictimPlan([], `sh ${source}, 1($0)`, doneLabel, true);
    case 'misaligned-half-store-delay-not-taken':
      return delaySlotVictimPlan([], `sh ${source}, 1($0)`, doneLabel, false);
    case 'ea-overflow-store':
      return directVictimPlan([
        ...loadImmediateInstructions('$20', 0x7fffffff),
        `sw ${source}, 1($20)`
      ]);
    case 'dm-out-of-range-store':
      return directVictimPlan([`sw ${source}, ${hex(p7DmEndExclusive)}($0)`]);
    case 'timer0-ctrl-byte-store':
      return planTimerStoreVictim(0, 'ctrl', 'sb');
    case 'timer1-ctrl-byte-store':
      return planTimerStoreVictim(1, 'ctrl', 'sb');
    case 'timer0-ctrl-half-store':
      return planTimerStoreVictim(0, 'ctrl', 'sh');
    case 'timer1-ctrl-half-store':
      return planTimerStoreVictim(1, 'ctrl', 'sh');
    case 'timer0-preset-byte-store':
      return planTimerStoreVictim(0, 'preset', 'sb');
    case 'timer1-preset-byte-store':
      return planTimerStoreVictim(1, 'preset', 'sb');
    case 'timer0-preset-half-store':
      return planTimerStoreVictim(0, 'preset', 'sh');
    case 'timer1-preset-half-store':
      return planTimerStoreVictim(1, 'preset', 'sh');
    case 'timer0-count-store':
      return planTimerStoreVictim(0, 'count', 'sw');
    case 'timer1-count-store':
      return planTimerStoreVictim(1, 'count', 'sw');
    case 'timer0-count-byte-store':
      return planTimerStoreVictim(0, 'count', 'sb');
    case 'timer1-count-byte-store':
      return planTimerStoreVictim(1, 'count', 'sb');
    case 'timer0-count-half-store':
      return planTimerStoreVictim(0, 'count', 'sh');
    case 'timer1-count-half-store':
      return planTimerStoreVictim(1, 'count', 'sh');
    default:
      throw new BuiltinAsmGeneratorError(`Internal generator error: unsupported P7 AdES probe variant ${String(variant)}.`);
  }
}

function planTimerLoadVictim(
  timer: 0 | 1,
  register: TimerRegister,
  mnemonic: 'lb' | 'lh',
  target: string
): InternalExceptionVictimPlan {
  return directVictimPlan([`${mnemonic} ${target}, ${hex(timerRegisters[timer][register])}($0)`]);
}

function planTimerStoreVictim(
  timer: 0 | 1,
  register: TimerRegister,
  mnemonic: 'sb' | 'sh' | 'sw'
): InternalExceptionVictimPlan {
  const registers = timerRegisters[timer];
  const address = registers[register];
  const observation = `timer${timer}-${register}` as P7ProbeTimerObservation;
  const setup = [`sw $0, ${hex(registers.ctrl)}($0)`];
  let expectedValue: number | undefined;
  if (register === 'ctrl') {
    expectedValue = 0;
  } else if (register === 'preset') {
    expectedValue = p7ProbeTimerPresetSentinel;
    setup.push(
      ...loadImmediateInstructions('$20', expectedValue),
      `sw $20, ${hex(address)}($0)`
    );
  } else {
    // A stopped official timer may still be in LOAD; let LOAD -> CNT -> IDLE
    // settle before taking the baseline, regardless of the prior scenario.
    setup.push('nop', 'nop');
  }

  // Low nibble 0b0110 keeps a wrongly-written CTRL stopped and IRQ-disabled, while
  // remaining distinct from the zero sentinel. COUNT/PRESET use the full word.
  const attemptedValue = 0x2468ace6;
  const instructions = [
    ...setup,
    ...loadImmediateInstructions('$20', attemptedValue),
    `lw $21, ${hex(address)}($0)`,
    `${mnemonic} $20, ${hex(address)}($0)`
  ];
  return {
    ...directVictimPlan(instructions),
    timerObservation: observation,
    auxPairDescription: `Timer${timer} ${register.toUpperCase()} before/after invalid store`,
    requireEqualAuxPair: true,
    ...(expectedValue === undefined ? {} : { allowedAuxPairs: [[expectedValue, expectedValue]] })
  };
}

function planOverflowVictim(variant: string | undefined, doneLabel: string): InternalExceptionVictimPlan {
  switch (variant) {
    case 'add-overflow-delay-taken':
    case 'add-overflow-delay-not-taken':
      return delaySlotVictimPlan([
        ...loadImmediateInstructions('$20', 0x7fffffff),
        ...loadImmediateInstructions('$21', 1)
      ], 'add $22, $20, $21', doneLabel, variant.endsWith('delay-taken'));
    case 'addi-overflow-delay-taken':
    case 'addi-overflow-delay-not-taken':
      return delaySlotVictimPlan(
        loadImmediateInstructions('$20', 0x7fffffff),
        'addi $22, $20, 1',
        doneLabel,
        variant.endsWith('delay-taken')
      );
    case 'sub-overflow-delay-taken':
    case 'sub-overflow-delay-not-taken':
      return delaySlotVictimPlan([
        ...loadImmediateInstructions('$20', 0x80000000),
        ...loadImmediateInstructions('$21', 1)
      ], 'sub $22, $20, $21', doneLabel, variant.endsWith('delay-taken'));
    default:
      throw new BuiltinAsmGeneratorError(`Internal generator error: unsupported P7 Ov probe variant ${String(variant)}.`);
  }
}

function planYoungerMduVictim(variant: string): InternalExceptionVictimPlan {
  const instructions = [
    ...loadImmediateInstructions('$18', p7ProbeHiSentinel),
    'mthi $18',
    ...loadImmediateInstructions('$19', p7ProbeLoSentinel),
    'mtlo $19',
    ...loadImmediateInstructions('$20', variant === 'young-div' ? 100 : 7),
    ...loadImmediateInstructions('$21', variant === 'young-div' ? 7 : 9),
    'nop',
    'syscall'
  ];
  const victimInstructionIndex = instructions.length - 1;
  let completedPair: [number, number];
  switch (variant) {
    case 'young-mult':
      instructions.push('mult $20, $21');
      completedPair = [0, 63];
      break;
    case 'young-div':
      instructions.push('div $20, $21');
      completedPair = [2, 14];
      break;
    case 'young-mthi':
      instructions.push('mthi $20');
      completedPair = [7, p7ProbeLoSentinel];
      break;
    case 'young-mtlo':
      instructions.push('mtlo $21');
      completedPair = [p7ProbeHiSentinel, 9];
      break;
    default:
      throw new BuiltinAsmGeneratorError(`Internal generator error: unsupported younger MDU probe variant ${variant}.`);
  }
  return {
    instructions,
    expectedBd: false,
    epcInstructionIndex: victimInstructionIndex,
    victimInstructionIndex,
    recordHiLo: true,
    // P7 permits already-started younger MDU operations to finish when the
    // exception is taken. Public reads establish complete results, not the
    // internal stage at which the operation started. Reject torn/corrupt pairs
    // and require mthi/mtlo to preserve the half they do not modify.
    allowedAuxPairs: [[p7ProbeHiSentinel, p7ProbeLoSentinel], completedPair],
    auxPairDescription: `${variant.slice(6)} younger HI/LO (unchanged or already started)`
  };
}

function directVictimPlan(instructions: string[]): InternalExceptionVictimPlan {
  const victimInstructionIndex = instructions.length - 1;
  return {
    instructions,
    expectedBd: false,
    epcInstructionIndex: victimInstructionIndex,
    victimInstructionIndex
  };
}

function delaySlotVictimPlan(
  setup: string[],
  victimInstruction: string,
  doneLabel: string,
  taken: boolean
): InternalExceptionVictimPlan {
  const epcInstructionIndex = setup.length;
  return {
    instructions: [
      ...setup,
      `${taken ? 'beq' : 'bne'} $0, $0, ${doneLabel}`,
      victimInstruction
    ],
    expectedBd: true,
    epcInstructionIndex,
    victimInstructionIndex: epcInstructionIndex + 1
  };
}

function hex(value: number): string {
  return `0x${(value >>> 0).toString(16)}`;
}
