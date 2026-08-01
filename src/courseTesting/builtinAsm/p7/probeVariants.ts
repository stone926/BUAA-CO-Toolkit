// @index p7-probe-variants — P7 probe 异常变体轮换目录与最小覆盖计数
import { P7ProbeScenarioKind } from '../types';

const variantsByKind: Partial<Record<P7ProbeScenarioKind, readonly string[]>> = {
  external: [
    'priority-syscall',
    'wait-loop',
    'retry-store',
    'retry-load-dependency',
    'retry-jal',
    'retry-delay-slot-store'
  ],
  adel: [
    'misaligned-load',
    'misaligned-half-load',
    'ea-overflow-load',
    'dm-out-of-range-load',
    'timer-byte-load',
    'timer-half-load',
    'invalid-fetch',
    'misaligned-fetch'
  ],
  ades: [
    'misaligned-store',
    'misaligned-half-store',
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
  syscall: ['delay-slot', 'young-mult', 'young-div', 'young-mthi', 'young-mtlo'],
  ov: ['add-overflow', 'addi-overflow', 'sub-overflow']
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
