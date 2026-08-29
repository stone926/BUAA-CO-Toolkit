// @index p7-probe-variants — P7 probe 异常变体轮换目录与最小覆盖计数
import { P7ProbeScenarioKind } from '../types';
import { p7RiWordCatalog } from '../../p7RiWords';

const variantsByKind: Partial<Record<P7ProbeScenarioKind, readonly string[]>> = {
  external: [
    'priority-syscall',
    'priority-adel',
    'priority-ades',
    'priority-ov',
    'masked-ie',
    'masked-im2',
    'wait-loop',
    'retry-store',
    'retry-load-dependency',
    'retry-jal',
    'retry-delay-slot-store-taken',
    'retry-delay-slot-store-not-taken'
  ],
  timer0: ['mode0-min', 'mode0-max', 'mode1-repeat', 'disable-reload', 'write-priority'],
  timer1: ['mode0-min', 'mode0-max', 'mode1-repeat', 'disable-reload', 'write-priority'],
  adel: [
    'misaligned-load-delay-taken',
    'misaligned-load-delay-not-taken',
    'misaligned-half-load-delay-taken',
    'misaligned-half-load-delay-not-taken',
    'ea-overflow-load',
    'dm-out-of-range-load',
    'timer-byte-load',
    'timer-half-load',
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
    'timer1-count-store'
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

export function probeVariantsFor(kind: P7ProbeScenarioKind): readonly string[] {
  return variantsByKind[kind] ?? [];
}

export function probeVariantCount(kind: P7ProbeScenarioKind): number {
  return Math.max(1, probeVariantsFor(kind).length);
}

export function probeVariantAt(kind: P7ProbeScenarioKind, occurrence: number): string | undefined {
  const variants = probeVariantsFor(kind);
  if (!variants.length) {
    return undefined;
  }
  const normalizedOccurrence = Math.max(0, Math.floor(occurrence));
  return variants[normalizedOccurrence % variants.length];
}
