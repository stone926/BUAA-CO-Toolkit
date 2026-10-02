// @index mips-core — Official MARS memory configurations shared by assembly and ordinary execution

import type { SectionLayout } from '../assembler/sections';

export const marsMemoryConfigurations = ['Default', 'CompactDataAtZero', 'CompactTextAtZero'] as const;
export type MarsMemoryConfiguration = typeof marsMemoryConfigurations[number];

export interface MarsMemoryLayout {
  readonly configuration: MarsMemoryConfiguration;
  readonly sectionLayout: SectionLayout;
  readonly dataSegmentBase: number;
  readonly externBase: number;
  readonly globalPointer: number;
  readonly heapBase: number;
  readonly stackPointer: number;
  readonly stackBase: number;
  readonly stackLimit: number;
  readonly exceptionHandler: number;
  readonly kernelDataBase: number;
  readonly kernelDataEndInclusive: number;
  readonly memoryMapBase: number;
  readonly memoryMapEndInclusive: number;
}

function layout(configuration: MarsMemoryConfiguration, values: Omit<MarsMemoryLayout, 'configuration'>): MarsMemoryLayout {
  return Object.freeze({
    configuration,
    ...values,
    sectionLayout: Object.freeze({
      text: Object.freeze(values.sectionLayout.text),
      ktext: Object.freeze(values.sectionLayout.ktext),
      data: Object.freeze(values.sectionLayout.data),
      ...(values.sectionLayout.kdata ? { kdata: Object.freeze(values.sectionLayout.kdata) } : {})
    })
  });
}

// MemoryConfigurations.java addresses, bounded by the actual 4 MiB backing
// regions in Memory.java for Default. Text ends are the last word start;
// data ends are the final byte. Compact configurations retain their own bounds.
const layouts: Readonly<Record<MarsMemoryConfiguration, MarsMemoryLayout>> = Object.freeze({
  Default: layout('Default', {
    sectionLayout: {
      text: { base: 0x0040_0000, endInclusive: 0x007f_fffc },
      ktext: { base: 0x8000_0000, endInclusive: 0x803f_fffc },
      data: { base: 0x1001_0000, minimumAddress: 0x1000_0000, endInclusive: 0x103f_ffff },
      kdata: { base: 0x9000_0000, endInclusive: 0x903f_ffff }
    },
    dataSegmentBase: 0x1000_0000,
    externBase: 0x1000_0000,
    globalPointer: 0x1000_8000,
    heapBase: 0x1004_0000,
    stackPointer: 0x7fff_effc,
    stackBase: 0x7fff_fffc,
    stackLimit: 0x7fc0_0000,
    exceptionHandler: 0x8000_0180,
    kernelDataBase: 0x9000_0000,
    kernelDataEndInclusive: 0x903f_ffff,
    memoryMapBase: 0xffff_0000,
    memoryMapEndInclusive: 0xffff_ffff
  }),
  CompactDataAtZero: layout('CompactDataAtZero', {
    sectionLayout: {
      text: { base: 0x3000, endInclusive: 0x3ffc },
      ktext: { base: 0x4000, endInclusive: 0x4ffc },
      data: { base: 0x0000, endInclusive: 0x2fff },
      kdata: { base: 0x5000, endInclusive: 0x7eff }
    },
    dataSegmentBase: 0x0000,
    externBase: 0x1000,
    globalPointer: 0x1800,
    heapBase: 0x2000,
    stackPointer: 0x2ffc,
    stackBase: 0x2ffc,
    stackLimit: 0x2000,
    exceptionHandler: 0x4180,
    kernelDataBase: 0x5000,
    kernelDataEndInclusive: 0x7eff,
    memoryMapBase: 0x7f00,
    memoryMapEndInclusive: 0x7fff
  }),
  CompactTextAtZero: layout('CompactTextAtZero', {
    sectionLayout: {
      text: { base: 0x0000, endInclusive: 0x0ffc },
      ktext: { base: 0x4000, endInclusive: 0x4ffc },
      data: { base: 0x2000, minimumAddress: 0x1000, endInclusive: 0x3fff },
      kdata: { base: 0x5000, endInclusive: 0x7eff }
    },
    dataSegmentBase: 0x1000,
    externBase: 0x1000,
    globalPointer: 0x1800,
    heapBase: 0x3000,
    stackPointer: 0x3ffc,
    stackBase: 0x3ffc,
    stackLimit: 0x3000,
    exceptionHandler: 0x4180,
    kernelDataBase: 0x5000,
    kernelDataEndInclusive: 0x7eff,
    memoryMapBase: 0x7f00,
    memoryMapEndInclusive: 0x7fff
  })
});

export function isMarsMemoryConfiguration(value: unknown): value is MarsMemoryConfiguration {
  return typeof value === 'string' && (marsMemoryConfigurations as readonly string[]).includes(value);
}

export function getMarsMemoryLayout(configuration: MarsMemoryConfiguration = 'Default'): MarsMemoryLayout {
  const result = layouts[configuration];
  if (!result) throw new Error(`Unknown MARS memory configuration: ${configuration}`);
  return result;
}
