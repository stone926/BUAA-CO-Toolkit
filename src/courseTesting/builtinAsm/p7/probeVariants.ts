// @index p7-probe-variants — P7 probe 异常变体轮换目录与最小覆盖计数
import { P7ProbeScenarioKind, P7ProbeShard } from '../types';
import { p7RiWordCatalog } from '../../p7RiWords';
import { interruptMduVariants as mduVariants } from './probeMduOperations';

const timerPriorityVariants = [
  'priority-ri', 'priority-adel', 'priority-ades', 'priority-ov', 'priority-syscall',
  'priority-syscall-delay-taken', 'priority-syscall-delay-not-taken'
];
const timerVariants = ['mode0-min', 'mode0-max', 'mode1-repeat', 'disable-reload', 'write-priority',
  ...timerPriorityVariants, ...mduVariants];

const variantsByKind: Partial<Record<P7ProbeScenarioKind, readonly string[]>> = {
  external: [
    'priority-syscall',
    'priority-adel',
    'priority-ades',
    'priority-ov',
    'priority-ri',
    'masked-ie',
    'masked-im2',
    'wait-loop',
    'retry-store',
    'retry-load-dependency',
    'retry-jal',
    'retry-delay-slot-store-taken',
    'retry-delay-slot-store-not-taken',
    ...mduVariants
  ],
  timer0: timerVariants,
  timer1: timerVariants,
  adel: [
    'misaligned-load-delay-taken',
    'misaligned-load-delay-not-taken',
    'misaligned-half-load-delay-taken',
    'misaligned-half-load-delay-not-taken',
    'ea-overflow-load',
    'dm-out-of-range-load',
    'timer-byte-load',
    'timer-half-load',
    ...['timer0-preset', 'timer0-count', 'timer1-ctrl', 'timer1-preset', 'timer1-count']
      .flatMap((register) => [`${register}-byte-load`, `${register}-half-load`]),
    'invalid-fetch',
    'misaligned-fetch'
  ],
  ades: [
    'misaligned-store-delay-taken',
    'misaligned-store-delay-not-taken',
    'misaligned-half-store-delay-taken',
    'misaligned-half-store-delay-not-taken',
    'ea-overflow-store',
    'dm-out-of-range-store',
    'timer0-ctrl-byte-store',
    'timer1-ctrl-byte-store',
    'timer0-ctrl-half-store',
    'timer1-ctrl-half-store',
    'timer0-preset-byte-store',
    'timer1-preset-byte-store',
    'timer0-preset-half-store',
    'timer1-preset-half-store',
    'timer0-count-store',
    'timer1-count-store',
    ...['timer0-count', 'timer1-count'].flatMap((register) => [`${register}-byte-store`, `${register}-half-store`])
  ],
  syscall: ['delay-slot', 'post-eret-status', 'young-mult', 'young-div', 'young-mthi', 'young-mtlo'],
  ri: p7RiWordCatalog.map((entry) => entry.variant),
  ov: [
    'add-overflow-delay-taken',
    'add-overflow-delay-not-taken',
    'addi-overflow-delay-taken',
    'addi-overflow-delay-not-taken',
    'sub-overflow-delay-taken',
    'sub-overflow-delay-not-taken'
  ]
};

export const automaticProbeShards = ['core', 'mmio', 'timer', 'priority', 'mdu'] as const;

export function probeVariantsFor(kind: P7ProbeScenarioKind, shard: P7ProbeShard = 'all'): readonly string[] {
  const variants = variantsByKind[kind] ?? [];
  return shard === 'all' ? variants : variants.filter((variant) => probeVariantShard(kind, variant) === shard);
}

export function probeVariantCount(kind: P7ProbeScenarioKind, shard: P7ProbeShard = 'all'): number {
  return Math.max(shard === 'all' ? 1 : 0, probeVariantsFor(kind, shard).length);
}

export function probeVariantAt(kind: P7ProbeScenarioKind, occurrence: number, shard: P7ProbeShard = 'all'): string | undefined {
  const variants = probeVariantsFor(kind, shard);
  if (!variants.length) {
    return undefined;
  }
  const normalizedOccurrence = Math.max(0, Math.floor(occurrence));
  return variants[normalizedOccurrence % variants.length];
}

function probeVariantShard(kind: P7ProbeScenarioKind, variant: string): Exclude<P7ProbeShard, 'all'> {
  if (variant.startsWith('mdu-')) {
    return 'mdu';
  }
  if (kind === 'timer0' || kind === 'timer1') {
    return variant.startsWith('priority-') ? 'priority' : 'timer';
  }
  if ((kind === 'adel' || kind === 'ades') && variant.startsWith('timer')) {
    return 'mmio';
  }
  return 'core';
}
