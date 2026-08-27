import { describe, expect, it } from 'vitest';
import { InstructionLayer } from '../../mips/core/generated/isaCatalog';
import {
  byteMaskToBits,
  defaultByteMask,
  MemoryAccessRequest,
  MemoryBus,
  MemoryFault,
  PreparedMemoryAccess
} from '../../mips/core/machine/memoryBus';
import { resolveCourseProfile } from '../../mips/core/profiles/courseProfiles';
import { AccessWidth } from '../../mips/core/profiles/profile';
import {
  committedEvents,
  haltSequence,
  gprWrites,
  makeSession,
  memoryWrites,
  op,
  RunTrace,
  runToCompletion
} from './programFixtures';

/**
 * The little-endian data-memory model: `src/mips/core/machine/memoryBus.ts` plus
 * the load/store paths of `src/mips/core/machine/transition.ts`.
 *
 * Every expected number below is hand-computed from the course contract, never
 * read back from the executor:
 *
 * - Byte enables per width and per `地址[1:0]`, and which `m_data_wdata` slice
 *   lands in which DM byte lane: `cscore/markdown/P6/P6-4.md` 第 10-47 行
 *   (`m_data_byteen[3]` ↔ `m_data_wdata[31:24]` ↔ byte3, down to
 *   `m_data_byteen[0]` ↔ `m_data_wdata[7:0]` ↔ byte0; `sw` = 1111,
 *   `sh` = 0011/1100, `sb` = 0001/0010/0100/1000).
 * - Load extension: `cscore/markdown/P6/P6-4.md` 第 56-69 行 数据扩展模块 —
 *   the module takes the addressed lane out of the 32-bit DM word and, for `lb`,
 *   sign-extends it from that byte's top bit (Op 001 无符号字节 / 010 符号字节 /
 *   011 无符号半字 / 100 符号半字).
 * - Store events are logged against the aligned word address together with the
 *   byte-enable merged word: `TraceProjectionPolicy.wordAlignedStores`
 *   (`courseProfiles.ts`), mirroring the official DM testbench.
 * - Address space: DM `0x0000_0000..0x0000_2fff`, IM `0x0000_3000..0x0000_6fff`
 *   (`cscore/markdown/P5/testcases/P5-4-5.md` 第 22 行 地址约束,
 *   `cscore/markdown/P6/P6-1.md` 第 35-36 行 容量).
 * - Which data accesses are illegal at all: `cscore/markdown/P7/implement/P7-2-3.md`
 *   异常表 AdEL/AdES rows — `lw/sw` 未 4 字节对齐, `lh/sh` 未 2 字节对齐,
 *   计算地址时加法溢出, 地址超出 DM/Timer0/Timer1/中断发生器的范围. `lb/sb` carry
 *   no alignment row, so a byte access at any address is legal. P6 has no
 *   architectural exceptions (`cscore/markdown/P6/P6-1.md`), so the same rejects
 *   leave the comparable domain instead (COURSE-P56-DOMAIN-001).
 * - `lwl/lwr/swl/swr` are the MIPS32 unaligned-transfer family in the
 *   MARS-compatibility layer; the merged values are derived from the MIPS32
 *   pseudocode with `BigEndianCPU = 0` (see the per-case derivations below).
 */

const hex = (value: number): string => `0x${(value >>> 0).toString(16).padStart(8, '0')}`;

/** `lbu/lhu/lwl/lwr/swl/swr` are MARS-layer encodings; `lb/lh/sb/sh/lw/sw` are not. */
const allLayers: readonly InstructionLayer[] = ['required', 'commonExtensions', 'marsCompatibility'];

/** Source operand of every store below: four distinct, non-zero byte lanes. */
const storeSource = 0xa1b2_c3d4;

/** `$2 = 0xa1b2c3d4` — the two instructions and the two GPR writes they log. */
const storeSourceProgram: readonly number[] = [
  op('lui', { rt: 2, immediate: 0xa1b2 }),
  op('ori', { rs: 2, rt: 2, immediate: 0xc3d4 })
];
const storeSourceWrites: ReadonlyArray<readonly [number, number]> = [
  [2, 0xa1b2_0000],
  [2, 0xa1b2_c3d4]
];

/** Preloaded DM word: the lanes a partial store does not enable must survive it. */
const initialWord = 0x1122_3344;

// ── shared runners ───────────────────────────────────────────────────────────

/** One store of `$2 = 0xa1b2c3d4` against a DM word preloaded with `initialWord`. */
function runSingleStore(
  mnemonic: string,
  address: number,
  layers?: readonly InstructionLayer[]
): RunTrace {
  const wordAddress = (address & ~3) >>> 0;
  return runToCompletion(makeSession('P6', [
    ...storeSourceProgram,
    op(mnemonic, { rs: 0, rt: 2, immediate: address }),
    ...haltSequence
  ], {
    dataBase: wordAddress,
    dataWords: [initialWord],
    ...(layers ? { layers } : {})
  }));
}

/** One load/store with `$0` as base and `$1` as the other operand, nothing else. */
function runSingleAccess(mnemonic: string, address: number): RunTrace {
  return runToCompletion(makeSession('P6', [
    op(mnemonic, { rs: 0, rt: 1, immediate: address }),
    ...haltSequence
  ]));
}

/** The single memory write of a run, or a failure if the run logged another shape. */
function singleWrite(trace: RunTrace, mnemonic: string) {
  const event = committedEvents(trace).find((item) => item.mnemonic === mnemonic);
  if (!event || event.memoryWrites.length !== 1) {
    throw new Error(`run did not log exactly one ${mnemonic} write`);
  }
  return event.memoryWrites[0];
}

function preparedAccess(bus: MemoryBus, request: MemoryAccessRequest): PreparedMemoryAccess {
  const result = bus.prepare(request);
  if ('reason' in result) {
    throw new Error(`unexpected memory fault at ${hex(request.address)}: ${result.message}`);
  }
  return result;
}

function busFault(bus: MemoryBus, request: MemoryAccessRequest): MemoryFault {
  const result = bus.prepare(request);
  if (!('reason' in result)) {
    throw new Error(`expected a memory fault at ${hex(request.address)}`);
  }
  return result;
}

// ── 1-3: store byte lanes ────────────────────────────────────────────────────

interface StoreLaneCase {
  readonly mnemonic: 'sb' | 'sh' | 'sw';
  readonly address: number;
  /** `m_data_byteen[3:0]` as a 4-bit value, bit `i` = byte lane `i`. */
  readonly byteMask: number;
  /** `initialWord` with only the enabled lanes replaced. */
  readonly valueAfter: number;
}

/**
 * P6-4.md byte-enable tables applied to `initialWord = 0x11223344`
 * (byte3 = 0x11, byte2 = 0x22, byte1 = 0x33, byte0 = 0x44) and
 * `storeSource = 0xa1b2c3d4` (low byte 0xd4, low half 0xc3d4).
 *
 * Each row is repeated inside word `0x0100` to prove the lane arithmetic uses
 * `地址[1:0]` and not the absolute address.
 */
const storeLaneCases: readonly StoreLaneCase[] = [
  // sb, 地址[1:0] = 00/01/10/11 -> byteen 0001/0010/0100/1000.
  { mnemonic: 'sb', address: 0x0000_0000, byteMask: 0b0001, valueAfter: 0x1122_33d4 },
  { mnemonic: 'sb', address: 0x0000_0001, byteMask: 0b0010, valueAfter: 0x1122_d444 },
  { mnemonic: 'sb', address: 0x0000_0002, byteMask: 0b0100, valueAfter: 0x11d4_3344 },
  { mnemonic: 'sb', address: 0x0000_0003, byteMask: 0b1000, valueAfter: 0xd422_3344 },
  { mnemonic: 'sb', address: 0x0000_0100, byteMask: 0b0001, valueAfter: 0x1122_33d4 },
  { mnemonic: 'sb', address: 0x0000_0101, byteMask: 0b0010, valueAfter: 0x1122_d444 },
  { mnemonic: 'sb', address: 0x0000_0102, byteMask: 0b0100, valueAfter: 0x11d4_3344 },
  { mnemonic: 'sb', address: 0x0000_0103, byteMask: 0b1000, valueAfter: 0xd422_3344 },

  // sh, 地址[1:0] = 0X -> byteen 0011 (wdata[15:0] into byte1/byte0);
  //     地址[1:0] = 1X -> byteen 1100 (wdata[31:16] into byte3/byte2), so the CPU
  //     positions the low half of `rt` into the high half of `m_data_wdata`.
  { mnemonic: 'sh', address: 0x0000_0000, byteMask: 0b0011, valueAfter: 0x1122_c3d4 },
  { mnemonic: 'sh', address: 0x0000_0002, byteMask: 0b1100, valueAfter: 0xc3d4_3344 },
  { mnemonic: 'sh', address: 0x0000_0100, byteMask: 0b0011, valueAfter: 0x1122_c3d4 },
  { mnemonic: 'sh', address: 0x0000_0102, byteMask: 0b1100, valueAfter: 0xc3d4_3344 },

  // sw, 地址[1:0] = XX -> byteen 1111: the whole word, nothing preserved.
  { mnemonic: 'sw', address: 0x0000_0000, byteMask: 0b1111, valueAfter: 0xa1b2_c3d4 },
  { mnemonic: 'sw', address: 0x0000_0100, byteMask: 0b1111, valueAfter: 0xa1b2_c3d4 }
];

describe('little-endian store byte lanes', () => {
  it('places each partial store in its own lane and preserves the others', () => {
    for (const testCase of storeLaneCases) {
      const label = `${testCase.mnemonic} ${hex(testCase.address)}`;
      const wordAddress = (testCase.address & ~3) >>> 0;
      const trace = runSingleStore(testCase.mnemonic, testCase.address);

      expect(trace.last.status, label).toBe('halted');
      // The DM module logs the aligned word address plus the merged word.
      expect(memoryWrites(trace), label).toEqual([[wordAddress, testCase.valueAfter]]);

      const write = singleWrite(trace, testCase.mnemonic);
      expect(write.byteMask, label).toBe(testCase.byteMask);
      expect(write.address, label).toBe(testCase.address);
      expect(write.wordAddress, label).toBe(wordAddress);
      expect(write.valueBefore, label).toBe(initialWord);
      expect(write.valueAfter, label).toBe(testCase.valueAfter);
      // `rawValue` is the source register before byte-lane selection.
      expect(write.rawValue, label).toBe(storeSource);
      expect(write.region, label).toBe('data');
    }
  });

  it('logs the register writes that built the source operand and nothing else', () => {
    const trace = runSingleStore('sb', 0x0000_0002);
    expect(gprWrites(trace)).toEqual([...storeSourceWrites]);
  });

  it('rewrites only the enabled lanes when two partial stores hit one word', () => {
    //  word 0x0000 starts at 0x11223344.
    //  sb  0x0000 <- 0xd4              -> 0x112233d4  (byteen 0001)
    //  sh  0x0002 <- 0xc3d4 into 31:16 -> 0xc3d433d4  (byteen 1100)
    //  sb  0x0001 <- 0xd4              -> 0xc3d4d4d4  (byteen 0010)
    const trace = runToCompletion(makeSession('P6', [
      ...storeSourceProgram,
      op('sb', { rs: 0, rt: 2, immediate: 0x0000 }),
      op('sh', { rs: 0, rt: 2, immediate: 0x0002 }),
      op('sb', { rs: 0, rt: 2, immediate: 0x0001 }),
      ...haltSequence
    ], { dataWords: [initialWord] }));

    expect(memoryWrites(trace)).toEqual([
      [0x0000_0000, 0x1122_33d4],
      [0x0000_0000, 0xc3d4_33d4],
      [0x0000_0000, 0xc3d4_d4d4]
    ]);
    expect(trace.last.status).toBe('halted');
  });
});

// ── 4-5: load extension and lw ───────────────────────────────────────────────

interface LoadCase {
  readonly mnemonic: string;
  readonly address: number;
  readonly width: AccessWidth;
  /** Value delivered to `$1` after the data-extension module. */
  readonly value: number;
}

/**
 * DM words `0x0000` and `0x0004`, chosen so that every byte lane and every
 * halfword lane appears once with its top bit set and once clear:
 *
 *   0x0000 = 0x80817f01 -> byte3 0x80, byte2 0x81, byte1 0x7f, byte0 0x01
 *   0x0004 = 0x010280ff -> byte3 0x01, byte2 0x02, byte1 0x80, byte0 0xff
 */
const extensionData: readonly number[] = [0x8081_7f01, 0x0102_80ff];

const loadCases: readonly LoadCase[] = [
  // lb: take the lane, sign-extend from its bit 7.
  { mnemonic: 'lb', address: 0x0000, width: 1, value: 0x0000_0001 },
  { mnemonic: 'lb', address: 0x0001, width: 1, value: 0x0000_007f },
  { mnemonic: 'lb', address: 0x0002, width: 1, value: 0xffff_ff81 },
  { mnemonic: 'lb', address: 0x0003, width: 1, value: 0xffff_ff80 },
  { mnemonic: 'lb', address: 0x0004, width: 1, value: 0xffff_ffff },
  { mnemonic: 'lb', address: 0x0005, width: 1, value: 0xffff_ff80 },
  { mnemonic: 'lb', address: 0x0006, width: 1, value: 0x0000_0002 },
  { mnemonic: 'lb', address: 0x0007, width: 1, value: 0x0000_0001 },

  // lbu: the same lane, zero-extended — differs on 0x81/0x80/0xff.
  { mnemonic: 'lbu', address: 0x0000, width: 1, value: 0x0000_0001 },
  { mnemonic: 'lbu', address: 0x0001, width: 1, value: 0x0000_007f },
  { mnemonic: 'lbu', address: 0x0002, width: 1, value: 0x0000_0081 },
  { mnemonic: 'lbu', address: 0x0003, width: 1, value: 0x0000_0080 },
  { mnemonic: 'lbu', address: 0x0004, width: 1, value: 0x0000_00ff },
  { mnemonic: 'lbu', address: 0x0005, width: 1, value: 0x0000_0080 },
  { mnemonic: 'lbu', address: 0x0006, width: 1, value: 0x0000_0002 },
  { mnemonic: 'lbu', address: 0x0007, width: 1, value: 0x0000_0001 },

  // lh: halfword lane 0 is bytes 1:0, lane 1 is bytes 3:2; sign bit is bit 15.
  { mnemonic: 'lh', address: 0x0000, width: 2, value: 0x0000_7f01 },
  { mnemonic: 'lh', address: 0x0002, width: 2, value: 0xffff_8081 },
  { mnemonic: 'lh', address: 0x0004, width: 2, value: 0xffff_80ff },
  { mnemonic: 'lh', address: 0x0006, width: 2, value: 0x0000_0102 },

  // lhu: the same halves, zero-extended.
  { mnemonic: 'lhu', address: 0x0000, width: 2, value: 0x0000_7f01 },
  { mnemonic: 'lhu', address: 0x0002, width: 2, value: 0x0000_8081 },
  { mnemonic: 'lhu', address: 0x0004, width: 2, value: 0x0000_80ff },
  { mnemonic: 'lhu', address: 0x0006, width: 2, value: 0x0000_0102 },

  // lw: the whole aligned word, no extension at all.
  { mnemonic: 'lw', address: 0x0000, width: 4, value: 0x8081_7f01 },
  { mnemonic: 'lw', address: 0x0004, width: 4, value: 0x0102_80ff }
];

describe('little-endian load extension', () => {
  it('extends every byte and halfword lane of both preloaded DM words', () => {
    const trace = runToCompletion(makeSession('P6', [
      ...loadCases.map((testCase) => op(testCase.mnemonic, {
        rs: 0, rt: 1, immediate: testCase.address
      })),
      ...haltSequence
    ], { layers: allLayers, dataWords: extensionData }));

    expect(trace.last.status).toBe('halted');
    expect(gprWrites(trace)).toEqual(loadCases.map((testCase) => [1, testCase.value]));

    const reads = committedEvents(trace).filter((event) => event.memoryReads !== undefined);
    expect(reads).toHaveLength(loadCases.length);
    for (let index = 0; index < loadCases.length; index++) {
      const testCase = loadCases[index];
      const label = `${testCase.mnemonic} ${hex(testCase.address)}`;
      const record = reads[index].memoryReads![0];
      expect(record.address, label).toBe(testCase.address);
      expect(record.wordAddress, label).toBe((testCase.address & ~3) >>> 0);
      expect(record.width, label).toBe(testCase.width);
      // The lane is selected out of the whole aligned word the DM returns.
      expect(record.wordValue, label).toBe(extensionData[(testCase.address & ~3) / 4]);
      expect(record.value, label).toBe(testCase.value);
      expect(record.region, label).toBe('data');
    }
  });

  it('splits the signed and unsigned form on the same address', () => {
    // The single most mutation-prone pair in the data-extension module: identical
    // address and width, opposite Op code (P6-4.md 010/001 and 100/011).
    const pairs = [
      { signed: 'lb', unsigned: 'lbu', address: 0x0002, signedValue: 0xffff_ff81, unsignedValue: 0x0000_0081 },
      { signed: 'lb', unsigned: 'lbu', address: 0x0004, signedValue: 0xffff_ffff, unsignedValue: 0x0000_00ff },
      { signed: 'lh', unsigned: 'lhu', address: 0x0002, signedValue: 0xffff_8081, unsignedValue: 0x0000_8081 },
      { signed: 'lh', unsigned: 'lhu', address: 0x0004, signedValue: 0xffff_80ff, unsignedValue: 0x0000_80ff }
    ];
    for (const pair of pairs) {
      const label = `${pair.signed}/${pair.unsigned} ${hex(pair.address)}`;
      const trace = runToCompletion(makeSession('P6', [
        op(pair.signed, { rs: 0, rt: 1, immediate: pair.address }),
        op(pair.unsigned, { rs: 0, rt: 2, immediate: pair.address }),
        ...haltSequence
      ], { layers: allLayers, dataWords: extensionData }));
      expect(gprWrites(trace), label)
        .toEqual([[1, pair.signedValue], [2, pair.unsignedValue]]);
    }
  });
});

describe('store-load round trip through DM', () => {
  it('returns exactly what was stored for every width and lane', () => {
    //  DM is zero at reset, so each merged word below is just the stored lane.
    //  0x20 sb lane0 | 0x25 sb lane1 | 0x2a sb lane2 | 0x2f sb lane3
    //  0x30 sh lanes 1:0 | 0x36 sh lanes 3:2 | 0x38 sw whole word
    const session = makeSession('P6', [
      ...storeSourceProgram,
      op('sb', { rs: 0, rt: 2, immediate: 0x0020 }),
      op('lbu', { rs: 0, rt: 1, immediate: 0x0020 }),
      op('lb', { rs: 0, rt: 3, immediate: 0x0020 }),
      op('sb', { rs: 0, rt: 2, immediate: 0x0025 }),
      op('lbu', { rs: 0, rt: 1, immediate: 0x0025 }),
      op('sb', { rs: 0, rt: 2, immediate: 0x002a }),
      op('lbu', { rs: 0, rt: 1, immediate: 0x002a }),
      op('sb', { rs: 0, rt: 2, immediate: 0x002f }),
      op('lbu', { rs: 0, rt: 1, immediate: 0x002f }),
      op('sh', { rs: 0, rt: 2, immediate: 0x0030 }),
      op('lhu', { rs: 0, rt: 1, immediate: 0x0030 }),
      op('lh', { rs: 0, rt: 3, immediate: 0x0030 }),
      op('sh', { rs: 0, rt: 2, immediate: 0x0036 }),
      op('lhu', { rs: 0, rt: 1, immediate: 0x0036 }),
      op('sw', { rs: 0, rt: 2, immediate: 0x0038 }),
      op('lw', { rs: 0, rt: 1, immediate: 0x0038 }),
      ...haltSequence
    ], { layers: allLayers });
    const trace = runToCompletion(session);

    expect(trace.last.status).toBe('halted');
    expect(memoryWrites(trace)).toEqual([
      [0x0000_0020, 0x0000_00d4],
      [0x0000_0024, 0x0000_d400],
      [0x0000_0028, 0x00d4_0000],
      [0x0000_002c, 0xd400_0000],
      [0x0000_0030, 0x0000_c3d4],
      [0x0000_0034, 0xc3d4_0000],
      [0x0000_0038, 0xa1b2_c3d4]
    ]);
    expect(gprWrites(trace)).toEqual([
      ...storeSourceWrites,
      [1, 0x0000_00d4],   // lbu of the byte just stored
      [3, 0xffff_ffd4],   // lb of the same byte: 0xd4 has bit 7 set
      [1, 0x0000_00d4],
      [1, 0x0000_00d4],
      [1, 0x0000_00d4],
      [1, 0x0000_c3d4],   // lhu of the half just stored
      [3, 0xffff_c3d4],   // lh of the same half: 0xc3d4 has bit 15 set
      [1, 0x0000_c3d4],
      [1, 0xa1b2_c3d4]
    ]);
    // No word outside the seven the program targeted may have changed.
    expect(session.snapshot('full').dataWords).toEqual([
      { address: 0x0000_0020, value: 0x0000_00d4 },
      { address: 0x0000_0024, value: 0x0000_d400 },
      { address: 0x0000_0028, value: 0x00d4_0000 },
      { address: 0x0000_002c, value: 0xd400_0000 },
      { address: 0x0000_0030, value: 0x0000_c3d4 },
      { address: 0x0000_0034, value: 0xc3d4_0000 },
      { address: 0x0000_0038, value: 0xa1b2_c3d4 }
    ]);
  });
});

// ── 6: alignment ─────────────────────────────────────────────────────────────

interface RejectedCase {
  readonly mnemonic: string;
  readonly address: number;
}

/** P7-2-3 异常表: `lw/sw` require 4-byte alignment, `lh/sh` require 2 bytes. */
const misalignedCases: readonly RejectedCase[] = [
  { mnemonic: 'lw', address: 0x0000_0001 },
  { mnemonic: 'lw', address: 0x0000_0002 },
  { mnemonic: 'lw', address: 0x0000_0003 },
  { mnemonic: 'lw', address: 0x0000_2ffd },
  { mnemonic: 'sw', address: 0x0000_0001 },
  { mnemonic: 'sw', address: 0x0000_0002 },
  { mnemonic: 'sw', address: 0x0000_0003 },
  { mnemonic: 'sw', address: 0x0000_2ffd },
  { mnemonic: 'lh', address: 0x0000_0001 },
  { mnemonic: 'lh', address: 0x0000_0003 },
  { mnemonic: 'lh', address: 0x0000_2fff },
  { mnemonic: 'sh', address: 0x0000_0001 },
  { mnemonic: 'sh', address: 0x0000_0003 },
  { mnemonic: 'sh', address: 0x0000_2fff }
];

/** `lb/sb` at every lane of word 0x0000; DM starts zeroed. */
const byteLaneCases: readonly { readonly address: number; readonly valueAfter: number }[] = [
  { address: 0x0000_0000, valueAfter: 0x0000_00d4 },
  { address: 0x0000_0001, valueAfter: 0x0000_d400 },
  { address: 0x0000_0002, valueAfter: 0x00d4_0000 },
  { address: 0x0000_0003, valueAfter: 0xd400_0000 }
];

describe('data-access alignment on P6', () => {
  it('leaves the comparable domain on a misaligned word or halfword access', () => {
    for (const testCase of misalignedCases) {
      const label = `${testCase.mnemonic} ${hex(testCase.address)}`;
      const trace = runSingleAccess(testCase.mnemonic, testCase.address);
      // P6 has no architectural exceptions, so the same address error that P7
      // reports as AdEL/AdES is an out-of-domain input here.
      expect(trace.last.status, label).toBe('out-of-domain');
      expect(trace.last.diagnostic?.reason, label).toBe('misaligned-access');
      expect(trace.last.diagnostic?.code, label).toBe('mips-core.exec.misaligned-access');
      expect(trace.last.diagnostic?.contractId, label).toBe('COURSE-P56-DOMAIN-001');
      expect(trace.last.diagnostic?.address, label).toBe(testCase.address);
      expect(trace.last.diagnostic?.pc, label).toBe(0x0000_3000);
      // The victim commits nothing at all.
      expect(memoryWrites(trace), label).toEqual([]);
      expect(gprWrites(trace), label).toEqual([]);
    }
  });

  it('accepts a byte access at every address without an alignment rule', () => {
    for (const testCase of byteLaneCases) {
      const label = hex(testCase.address);
      const trace = runToCompletion(makeSession('P6', [
        op('ori', { rs: 0, rt: 2, immediate: 0x00d4 }),
        op('sb', { rs: 0, rt: 2, immediate: testCase.address }),
        op('lb', { rs: 0, rt: 3, immediate: testCase.address }),
        ...haltSequence
      ]));
      expect(trace.last.status, label).toBe('halted');
      expect(memoryWrites(trace), label).toEqual([[0x0000_0000, testCase.valueAfter]]);
      // 0xd4 read back through `lb` sign-extends from bit 7.
      expect(gprWrites(trace), label).toEqual([[2, 0x0000_00d4], [3, 0xffff_ffd4]]);
    }
  });
});

// ── 7: DM boundaries ─────────────────────────────────────────────────────────

/**
 * P5-4-5 地址约束: DM is `0x0000..0x2fff`, IM is `0x3000..0x6fff`. A data access
 * to the instruction segment or past every declared region is illegal
 * (P7-2-3 异常表 "地址超出 DM、Timer0、Timer1、中断发生器的范围"). P6 declares no
 * device regions at all, so even the P7 Timer window is unmapped here.
 */
const outOfRegionCases: readonly RejectedCase[] = [
  { mnemonic: 'sw', address: 0x0000_3000 },
  { mnemonic: 'sw', address: 0x0000_3004 },
  { mnemonic: 'sb', address: 0x0000_3000 },
  { mnemonic: 'sh', address: 0x0000_3000 },
  { mnemonic: 'lw', address: 0x0000_3000 },
  { mnemonic: 'lb', address: 0x0000_3001 },
  { mnemonic: 'lh', address: 0x0000_3002 },
  { mnemonic: 'lw', address: 0x0000_6ffc },
  { mnemonic: 'sw', address: 0x0000_7000 },
  { mnemonic: 'sw', address: 0x0000_7f00 },
  { mnemonic: 'lw', address: 0x0000_7f00 }
];

describe('DM region boundaries on P6', () => {
  it('stores at both ends of DM, down to the last byte lane of the last word', () => {
    //  0x0000 sw            -> 0x00000000 becomes 0xa1b2c3d4
    //  0x2ffc sw            -> 0x00000000 becomes 0xa1b2c3d4  (last DM word)
    //  0x2ffe sh byteen 1100 -> 0xa1b2c3d4 becomes 0xc3d4c3d4
    //  0x2fff sb byteen 1000 -> 0xc3d4c3d4 becomes 0xd4d4c3d4  (last DM byte)
    const session = makeSession('P6', [
      ...storeSourceProgram,
      op('sw', { rs: 0, rt: 2, immediate: 0x0000 }),
      op('sw', { rs: 0, rt: 2, immediate: 0x2ffc }),
      op('sh', { rs: 0, rt: 2, immediate: 0x2ffe }),
      op('sb', { rs: 0, rt: 2, immediate: 0x2fff }),
      ...haltSequence
    ]);
    const trace = runToCompletion(session);

    expect(trace.last.status).toBe('halted');
    expect(memoryWrites(trace)).toEqual([
      [0x0000_0000, 0xa1b2_c3d4],
      [0x0000_2ffc, 0xa1b2_c3d4],
      [0x0000_2ffc, 0xc3d4_c3d4],
      [0x0000_2ffc, 0xd4d4_c3d4]
    ]);
    expect(session.snapshot('full').dataWords).toEqual([
      { address: 0x0000_0000, value: 0xa1b2_c3d4 },
      { address: 0x0000_2ffc, value: 0xd4d4_c3d4 }
    ]);
  });

  it('rejects every data access outside DM, including the instruction segment', () => {
    for (const testCase of outOfRegionCases) {
      const label = `${testCase.mnemonic} ${hex(testCase.address)}`;
      const trace = runSingleAccess(testCase.mnemonic, testCase.address);
      expect(trace.last.status, label).toBe('out-of-domain');
      expect(trace.last.diagnostic?.reason, label).toBe('address-out-of-region');
      expect(trace.last.diagnostic?.code, label).toBe('mips-core.exec.address-out-of-region');
      expect(trace.last.diagnostic?.address, label).toBe(testCase.address);
      expect(memoryWrites(trace), label).toEqual([]);
      expect(gprWrites(trace), label).toEqual([]);
    }
  });

  it('classifies each rejected data address at the bus level', () => {
    const bus = new MemoryBus(resolveCourseProfile('P6'));
    // The instruction segment is `instructionOnly`, so data never resolves there
    // even though the address is inside the declared address space.
    expect(busFault(bus, { kind: 'load', address: 0x0000_3000, width: 4 }).reason).toBe('unmapped');
    expect(busFault(bus, { kind: 'store', address: 0x0000_6ffc, width: 1 }).reason).toBe('unmapped');
    expect(busFault(bus, { kind: 'store', address: 0x0000_7000, width: 4 }).reason).toBe('unmapped');
    // Alignment is checked before the region, so 0x2ffd inside DM is misaligned
    // for `sw` rather than out of region.
    const misaligned = busFault(bus, { kind: 'store', address: 0x0000_2ffd, width: 4 });
    expect(misaligned.reason).toBe('misaligned');
    expect(misaligned.direction).toBe('store');
    // The same address is legal for a byte access.
    expect(preparedAccess(bus, { kind: 'store', address: 0x0000_2ffd, width: 1 }).wordAddress)
      .toBe(0x0000_2ffc);
    expect(preparedAccess(bus, { kind: 'store', address: 0x0000_2ffd, width: 1 }).byteMask)
      .toBe(0b0010);
    // Both ends of DM are addressable.
    expect(preparedAccess(bus, { kind: 'load', address: 0x0000_0000, width: 4 }).region).toBe('data');
    expect(preparedAccess(bus, { kind: 'load', address: 0x0000_2ffc, width: 4 }).region).toBe('data');
  });
});

// ── 8: effective-address overflow ────────────────────────────────────────────

describe('effective-address overflow', () => {
  it('rejects a load and a store whose address addition overflows', () => {
    // P7-2-3 异常表: "计算地址时加法溢出" is an address error for both directions.
    // 0x7fffffff + 1 leaves the signed 32-bit range; on P6 that is out of domain.
    for (const mnemonic of ['lw', 'sw']) {
      const trace = runToCompletion(makeSession('P6', [
        op('lui', { rt: 1, immediate: 0x7fff }),
        op('ori', { rs: 1, rt: 1, immediate: 0xffff }),
        op(mnemonic, { rs: 1, rt: 3, immediate: 1 }),
        ...haltSequence
      ]));
      expect(trace.last.status, mnemonic).toBe('out-of-domain');
      expect(trace.last.diagnostic?.reason, mnemonic).toBe('address-out-of-region');
      // The bus reports `address-overflow`, which `transition` folds into the
      // single non-exception reason; the message keeps the two apart.
      expect(trace.last.diagnostic?.message, mnemonic).toContain('32 位有符号加法溢出');
      expect(trace.last.diagnostic?.address, mnemonic).toBe(0x8000_0000);
      expect(memoryWrites(trace), mnemonic).toEqual([]);
      // Only the two constant-building writes committed.
      expect(gprWrites(trace), mnemonic).toEqual([[1, 0x7fff_0000], [1, 0x7fff_ffff]]);
    }
  });

  it('blames the region rather than the adder when the sum is representable', () => {
    // 0x7fffffff + (-3) = 0x7ffffffc is representable and word aligned, so the
    // reject must come from the region check and carry the range message.
    const trace = runToCompletion(makeSession('P6', [
      op('lui', { rt: 1, immediate: 0x7fff }),
      op('ori', { rs: 1, rt: 1, immediate: 0xffff }),
      op('sw', { rs: 1, rt: 3, immediate: -3 }),
      ...haltSequence
    ]));
    expect(trace.last.status).toBe('out-of-domain');
    expect(trace.last.diagnostic?.reason).toBe('address-out-of-region');
    expect(trace.last.diagnostic?.message).toContain('超出 DM');
    expect(trace.last.diagnostic?.message).not.toContain('加法溢出');
    expect(trace.last.diagnostic?.address).toBe(0x7fff_fffc);
  });

  it('separates the misaligned and out-of-region rejects on the same base', () => {
    // Alignment is checked before the region, so the unaligned sum 0x7ffffffe is
    // reported as misaligned even though it is also outside every region.
    const trace = runToCompletion(makeSession('P6', [
      op('lui', { rt: 1, immediate: 0x7fff }),
      op('ori', { rs: 1, rt: 1, immediate: 0xffff }),
      op('sw', { rs: 1, rt: 3, immediate: -1 }),
      ...haltSequence
    ]));
    expect(trace.last.status).toBe('out-of-domain');
    expect(trace.last.diagnostic?.reason).toBe('misaligned-access');
    expect(trace.last.diagnostic?.address).toBe(0x7fff_fffe);
  });

  it('reports address overflow ahead of alignment and region at the bus level', () => {
    const bus = new MemoryBus(resolveCourseProfile('P6'));
    const store = busFault(bus, {
      kind: 'store', address: 0x8000_0000, width: 4, addressOverflow: true
    });
    expect(store.reason).toBe('address-overflow');
    expect(store.direction).toBe('store');
    expect(store.address).toBe(0x8000_0000);
    // Even a perfectly legal DM address is rejected once the adder overflowed.
    const load = busFault(bus, {
      kind: 'load', address: 0x0000_0000, width: 4, addressOverflow: true
    });
    expect(load.reason).toBe('address-overflow');
    expect(load.direction).toBe('load');
  });
});

// ── 9: lwl / lwr / swl / swr ─────────────────────────────────────────────────

/** Aligned DM word behind every unaligned-transfer case. */
const unalignedMemoryWord = 0xaabb_ccdd;

/** Old `rt` merged into by `lwl/lwr`, and the writes that build it. */
const unalignedOldTarget = 0x1122_3344;
const unalignedOldTargetProgram: readonly number[] = [
  op('lui', { rt: 2, immediate: 0x1122 }),
  op('ori', { rs: 2, rt: 2, immediate: 0x3344 })
];
const unalignedOldTargetWrites: ReadonlyArray<readonly [number, number]> = [
  [2, 0x1122_0000],
  [2, 0x1122_3344]
];

interface PartialLoadCase {
  readonly mnemonic: 'lwl' | 'lwr';
  readonly address: number;
  readonly value: number;
}

/**
 * MIPS32 pseudocode with `BigEndianCPU = 0`, so `byte = vAddr[1:0]`:
 *
 *   LWL: temp = memword[7 + 8*byte .. 0] || rt[23 - 8*byte .. 0]
 *        i.e. (memword << (24 - 8*byte)) | (rt & ((1 << (24 - 8*byte)) - 1))
 *   LWR: temp = rt[31 .. 32 - 8*byte] || memword[31 .. 8*byte]
 *        i.e. (rt & ~((1 << (32 - 8*byte)) - 1)) | (memword >>> (8*byte))
 *
 * With memword = 0xaabbccdd and rt = 0x11223344.
 */
const partialLoadCases: readonly PartialLoadCase[] = [
  // LWL, shift 24/16/8/0.
  { mnemonic: 'lwl', address: 0x0000, value: 0xdd22_3344 },
  { mnemonic: 'lwl', address: 0x0001, value: 0xccdd_3344 },
  { mnemonic: 'lwl', address: 0x0002, value: 0xbbcc_dd44 },
  { mnemonic: 'lwl', address: 0x0003, value: 0xaabb_ccdd },
  // LWR, shift 0/8/16/24.
  { mnemonic: 'lwr', address: 0x0000, value: 0xaabb_ccdd },
  { mnemonic: 'lwr', address: 0x0001, value: 0x11aa_bbcc },
  { mnemonic: 'lwr', address: 0x0002, value: 0x1122_aabb },
  { mnemonic: 'lwr', address: 0x0003, value: 0x1122_33aa }
];

interface PartialStoreCase {
  readonly mnemonic: 'swl' | 'swr';
  readonly address: number;
  readonly byteMask: number;
  readonly valueAfter: number;
}

/**
 * MIPS32 pseudocode with `BigEndianCPU = 0`:
 *
 *   SWL: dataword = rt >>> (24 - 8*byte), byte lanes 0..byte enabled
 *   SWR: dataword = rt << (8*byte),       byte lanes byte..3 enabled
 *
 * With rt = 0xa1b2c3d4 merged into the preloaded word 0x11223344.
 */
const partialStoreCases: readonly PartialStoreCase[] = [
  // SWL: rt's high bytes fall into the low lanes.
  { mnemonic: 'swl', address: 0x0000, byteMask: 0b0001, valueAfter: 0x1122_33a1 },
  { mnemonic: 'swl', address: 0x0001, byteMask: 0b0011, valueAfter: 0x1122_a1b2 },
  { mnemonic: 'swl', address: 0x0002, byteMask: 0b0111, valueAfter: 0x11a1_b2c3 },
  { mnemonic: 'swl', address: 0x0003, byteMask: 0b1111, valueAfter: 0xa1b2_c3d4 },
  // SWR: rt's low bytes fall into the high lanes.
  { mnemonic: 'swr', address: 0x0000, byteMask: 0b1111, valueAfter: 0xa1b2_c3d4 },
  { mnemonic: 'swr', address: 0x0001, byteMask: 0b1110, valueAfter: 0xb2c3_d444 },
  { mnemonic: 'swr', address: 0x0002, byteMask: 0b1100, valueAfter: 0xc3d4_3344 },
  { mnemonic: 'swr', address: 0x0003, byteMask: 0b1000, valueAfter: 0xd422_3344 }
];

describe('unaligned word transfer instructions', () => {
  it('merges the memory word into rt for every lwl and lwr byte offset', () => {
    for (const testCase of partialLoadCases) {
      const label = `${testCase.mnemonic} ${hex(testCase.address)}`;
      const trace = runToCompletion(makeSession('P6', [
        ...unalignedOldTargetProgram,
        op(testCase.mnemonic, { rs: 0, rt: 2, immediate: testCase.address }),
        ...haltSequence
      ], { layers: allLayers, dataWords: [unalignedMemoryWord] }));

      expect(trace.last.status, label).toBe('halted');
      expect(gprWrites(trace), label)
        .toEqual([...unalignedOldTargetWrites, [2, testCase.value]]);

      const load = committedEvents(trace).find((event) => event.mnemonic === testCase.mnemonic)!;
      const record = load.memoryReads![0];
      // The access is word-wide with alignment relaxed to one byte.
      expect(record.width, label).toBe(4);
      expect(record.address, label).toBe(testCase.address);
      expect(record.wordAddress, label).toBe(0x0000_0000);
      expect(record.wordValue, label).toBe(unalignedMemoryWord);
      expect(record.value, label).toBe(testCase.value);
    }
  });

  it('enables the right lanes for every swl and swr byte offset', () => {
    for (const testCase of partialStoreCases) {
      const label = `${testCase.mnemonic} ${hex(testCase.address)}`;
      const trace = runSingleStore(testCase.mnemonic, testCase.address, allLayers);

      expect(trace.last.status, label).toBe('halted');
      expect(memoryWrites(trace), label).toEqual([[0x0000_0000, testCase.valueAfter]]);

      const write = singleWrite(trace, testCase.mnemonic);
      expect(write.byteMask, label).toBe(testCase.byteMask);
      expect(write.address, label).toBe(testCase.address);
      expect(write.wordAddress, label).toBe(0x0000_0000);
      expect(write.valueBefore, label).toBe(initialWord);
      expect(write.valueAfter, label).toBe(testCase.valueAfter);
    }
  });

  it('composes an unaligned word transfer out of one swr and one swl', () => {
    //  The canonical little-endian idiom for an unaligned word at address A:
    //  `swr A(0)` writes the bytes from A to the end of A's word, `swl A+3(0)`
    //  writes the bytes from the start of (A+3)'s word up to A+3. With A = 0x11:
    //  word 0x10 lanes 1..3 <- 0xd4, 0xc3, 0xb2 ; word 0x14 lane 0 <- 0xa1.
    const session = makeSession('P6', [
      ...storeSourceProgram,
      op('swr', { rs: 0, rt: 2, immediate: 0x0011 }),
      op('swl', { rs: 0, rt: 2, immediate: 0x0014 }),
      op('lw', { rs: 0, rt: 1, immediate: 0x0010 }),
      op('lw', { rs: 0, rt: 3, immediate: 0x0014 }),
      ...haltSequence
    ], { layers: allLayers });
    const trace = runToCompletion(session);

    expect(trace.last.status).toBe('halted');
    expect(memoryWrites(trace)).toEqual([
      [0x0000_0010, 0xb2c3_d400],
      [0x0000_0014, 0x0000_00a1]
    ]);
    expect(gprWrites(trace)).toEqual([
      ...storeSourceWrites,
      [1, 0xb2c3_d400],
      [3, 0x0000_00a1]
    ]);
    // Reading the same unaligned word back with lwr + lwl restores the source.
    const readBack = runToCompletion(makeSession('P6', [
      op('lwr', { rs: 0, rt: 4, immediate: 0x0011 }),
      op('lwl', { rs: 0, rt: 4, immediate: 0x0014 }),
      ...haltSequence
    ], {
      layers: allLayers,
      dataBase: 0x0000_0010,
      dataWords: [0xb2c3_d400, 0x0000_00a1]
    }));
    expect(gprWrites(readBack)).toEqual([
      [4, 0x00b2_c3d4],   // lwr @0x11: rt was 0, low 3 bytes come from memory
      [4, 0xa1b2_c3d4]    // lwl @0x14: lane 0 of word 0x14 becomes rt[31:24]
    ]);
  });
});

// ── 10: byte-enable helpers ──────────────────────────────────────────────────

interface ByteMaskCase {
  readonly width: AccessWidth;
  readonly offset: number;
  readonly mask: number;
}

/** P6-4.md byte-enable tables, indexed by width and `地址[1:0]`. */
const byteMaskCases: readonly ByteMaskCase[] = [
  { width: 1, offset: 0, mask: 0b0001 },
  { width: 1, offset: 1, mask: 0b0010 },
  { width: 1, offset: 2, mask: 0b0100 },
  { width: 1, offset: 3, mask: 0b1000 },
  // `sh` reads only address bit 1: 0X -> 0011, 1X -> 1100.
  { width: 2, offset: 0, mask: 0b0011 },
  { width: 2, offset: 1, mask: 0b0011 },
  { width: 2, offset: 2, mask: 0b1100 },
  { width: 2, offset: 3, mask: 0b1100 },
  // `sw` ignores both low bits: XX -> 1111.
  { width: 4, offset: 0, mask: 0b1111 },
  { width: 4, offset: 1, mask: 0b1111 },
  { width: 4, offset: 2, mask: 0b1111 },
  { width: 4, offset: 3, mask: 0b1111 }
];

/** `m_data_byteen[i]` covers `m_data_wdata[8i+7 : 8i]` (P6-4.md 第 10-13 行). */
const laneMaskCases: ReadonlyArray<readonly [number, number]> = [
  [0b0000, 0x0000_0000],
  [0b0001, 0x0000_00ff],
  [0b0010, 0x0000_ff00],
  [0b0100, 0x00ff_0000],
  [0b1000, 0xff00_0000],
  [0b0011, 0x0000_ffff],
  [0b1100, 0xffff_0000],
  [0b0110, 0x00ff_ff00],
  [0b0111, 0x00ff_ffff],
  [0b1110, 0xffff_ff00],
  [0b1111, 0xffff_ffff]
];

describe('byte-enable helpers', () => {
  it('derives the byte enables from the width and the low two address bits only', () => {
    // Three unrelated word bases prove the mask depends on 地址[1:0] alone.
    for (const base of [0x0000_0000, 0x0000_2ffc, 0x0000_0100]) {
      for (const testCase of byteMaskCases) {
        const address = (base + testCase.offset) >>> 0;
        const label = `width ${testCase.width} @${hex(address)}`;
        expect(defaultByteMask(address, testCase.width), label).toBe(testCase.mask);
      }
    }
  });

  it('expands each byte enable into its 32-bit lane mask', () => {
    for (const [byteMask, bits] of laneMaskCases) {
      const label = `0b${byteMask.toString(2).padStart(4, '0')}`;
      expect(byteMaskToBits(byteMask), label).toBe(bits);
    }
  });

  it('merges only the enabled lanes into the aligned word', () => {
    const bus = new MemoryBus(resolveCourseProfile('P6'));
    const seed = preparedAccess(bus, {
      kind: 'store', address: 0x0000_0000, width: 4, value: initialWord
    });
    bus.commit(seed, initialWord);
    expect(bus.readDataWord(0x0000_0000)).toBe(initialWord);

    // The `swl/swr` shape: word width, alignment relaxed, explicit byte enables.
    const partial = preparedAccess(bus, {
      kind: 'store',
      address: 0x0000_0001,
      width: 4,
      alignment: 1,
      byteMask: 0b0110,
      value: storeSource
    });
    expect(partial.wordAddress).toBe(0x0000_0000);
    expect(partial.byteMask).toBe(0b0110);
    const preview = bus.storePreview(partial, storeSource);
    expect(preview.valueBefore).toBe(initialWord);
    // Lanes 1 and 2 come from 0xa1b2c3d4; lanes 0 and 3 keep 0x44 and 0x11.
    expect(preview.valueAfter).toBe(0x11b2_c344);
    // `storePreview` is side-effect free until `commit` runs.
    expect(bus.readDataWord(0x0000_0000)).toBe(initialWord);
    bus.commit(partial, storeSource);
    expect(bus.readDataWord(0x0000_0000)).toBe(0x11b2_c344);
  });

  it('accepts a word-wide access at every byte offset when alignment is relaxed', () => {
    const bus = new MemoryBus(resolveCourseProfile('P6'));
    for (const offset of [0, 1, 2, 3]) {
      const label = `offset ${offset}`;
      const access = preparedAccess(bus, {
        kind: 'load', address: (0x0000_0010 + offset) >>> 0, width: 4, alignment: 1
      });
      expect(access.wordAddress, label).toBe(0x0000_0010);
      expect(access.byteMask, label).toBe(0b1111);
      expect(access.width, label).toBe(4);
    }
  });
});
