import { describe, expect, it } from 'vitest';
import { CommitEvent } from '../../mips/core/events/commitEvent';
import { CoverageBin, ExecutionCoverageCollector } from '../../mips/core/events/coverage';
import {
  ArchitecturalWriteRecord,
  formatArchitecturalWrite,
  formatArchitecturalWrites,
  projectCommitEvent,
  projectCommitEvents
} from '../../mips/core/events/traceProjection';
import { CourseProfile } from '../../mips/core/generated/isaCatalog';
import { runCourseProgram } from '../../mips/core/machine/execution';
import { CourseSystemSession, DeviceSchedule } from '../../mips/core/machine/system';
import { resolveCourseProfile } from '../../mips/core/profiles/courseProfiles';
import { CpuTraceEvent, parseCpuTraceLine } from '../../language/mips/traceParser';
import {
  committedEvents,
  FixtureOptions,
  haltSequence,
  makeSession,
  op,
  RunTrace,
  runToCompletion
} from './programFixtures';

/**
 * Course architectural write trace, execution coverage bins and the bounded
 * execution driver.
 *
 * The trace format is the one the course GRF/DM modules print ([P4-7], [P5-5-2]):
 *
 * ```
 * P3/P4  $display("@%h: $%d <= %h",   WPC,   Waddr, WData)
 *        $display("@%h: *%h <= %h",   pc,    addr,  din)
 * P5-P7  $display("%d@%h: $%d <= %h", $time, WPC,   Waddr, WData)
 *        $display("%d@%h: *%h <= %h", $time, pc,    addr,  din)
 * ```
 *
 * Every expected value below is derived from that contract, never read back from
 * the projector:
 *
 * - The official P7 testbench logs a GRF write only when `w_grf_we && w_grf_addr != 0`,
 *   so `$0` never appears; HI/LO and CP0 writes are not wired to that trace at all
 *   (P7-2-6 "写入时无需 display").
 * - The same testbench logs `m_data_addr & ~3` together with the byte-enable merged
 *   word, so `sb`/`sh` project to the ALIGNED word address and the MERGED word, not
 *   to the raw effective address and the raw source value.
 * - Timer0/Timer1 (0x7F00.., 0x7F10..) and the interrupt generator (0x7F20..) hang
 *   off the system bridge's device ports, not the DM port (P7-2-2 地址表), so their
 *   stores are device events and produce no DM trace line.
 * - The oracle has no cycle domain, so it never fabricates the `$time` prefix; the
 *   `<n>@` form only exists to reproduce a DUT-side line.
 * - An exception/interrupt victim commits nothing (P7-2-6), so its commit event
 *   yields no trace line at all.
 *
 * Round-tripping goes through the repo's own DUT-side parser
 * `src/language/mips/traceParser.ts`, which normalises to UPPERCASE 8-hex `pc`/`value`,
 * decimal `target` for `grf` and 8-hex `target` for `dm`. Oracle and DUT sides must
 * agree on exactly that normalisation or a comparison lane would diff on formatting.
 *
 * Instruction availability per profile follows the frozen ISA catalog: `sb`/`sh`,
 * `mult`/`mflo` exist from P6 on, `mtc0` only on P7.
 */

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Timer transactions are only in the comparable domain when a schedule exists. */
const timersEnabled: DeviceSchedule = { kind: 'timeline', entries: [] };

interface ProjectedRun {
  readonly session: CourseSystemSession;
  readonly trace: RunTrace;
  readonly records: readonly ArchitecturalWriteRecord[];
}

/** Run to the course halt loop and project the architectural write trace. */
function project(
  profileId: CourseProfile,
  words: readonly number[],
  options: FixtureOptions = {}
): ProjectedRun {
  const session = makeSession(profileId, words, options);
  const trace = runToCompletion(session);
  if (trace.last.status !== 'halted') {
    throw new Error(
      `fixture for ${profileId} did not reach the course halt loop: ${trace.last.status}`
    );
  }
  return {
    session,
    trace,
    records: projectCommitEvents(trace.events, resolveCourseProfile(profileId))
  };
}

/** Parse one oracle line back with the repo's DUT-side trace parser. */
function reparse(record: ArchitecturalWriteRecord, cycle?: number): CpuTraceEvent {
  const line = formatArchitecturalWrite(record, cycle);
  const parsed = parseCpuTraceLine(line);
  if (!parsed) {
    throw new Error(`the course trace parser rejected the oracle line "${line}"`);
  }
  return parsed;
}

/** The four comparable fields; `raw`/`lineNumber` are parser bookkeeping. */
function comparable(event: CpuTraceEvent): ArchitecturalWriteRecord {
  return { pc: event.pc, kind: event.kind, target: event.target, value: event.value };
}

function coverageOf(profileId: CourseProfile, trace: RunTrace): ExecutionCoverageCollector {
  const collector = new ExecutionCoverageCollector(resolveCourseProfile(profileId));
  for (const event of trace.events) {
    collector.observe(event);
  }
  return collector;
}

function eventFor(trace: RunTrace, mnemonic: string): CommitEvent {
  const event = committedEvents(trace).find((candidate) => candidate.mnemonic === mnemonic);
  if (!event) {
    throw new Error(`fixture never committed a ${mnemonic}`);
  }
  return event;
}

/**
 * P3 program with only P3-legal instructions. `add` wraps on P3 (P6-1 "所有运算类
 * 指令均暂不考虑因溢出而产生的异常"), so `0xAABBCCDD + 0xAABBCCDD = 0x1_557799BA`
 * truncates to `0x557799BA`.
 */
const p3Program = [
  op('lui', { rt: 1, immediate: 0xaabb }), //      0x3000 $1 = 0xAABB0000
  op('ori', { rs: 1, rt: 1, immediate: 0xccdd }), // 0x3004 $1 = 0xAABBCCDD
  op('sw', { rs: 0, rt: 1, immediate: 0 }), //      0x3008 DM[0x0] = 0xAABBCCDD
  op('lw', { rs: 0, rt: 2, immediate: 0 }), //      0x300c $2 = 0xAABBCCDD
  op('add', { rd: 3, rs: 1, rt: 2 }), //            0x3010 $3 = 0x557799BA (wraps)
  op('sw', { rs: 0, rt: 3, immediate: 4 }), //      0x3014 DM[0x4] = 0x557799BA
  op('ori', { rs: 0, rt: 0, immediate: 0x1234 }), // 0x3018 writes $0: never logged
  ...haltSequence //                                0x301c halt (P3 has no delay slot)
];

const p3Expected: readonly ArchitecturalWriteRecord[] = [
  { pc: '00003000', kind: 'grf', target: '1', value: 'AABB0000' },
  { pc: '00003004', kind: 'grf', target: '1', value: 'AABBCCDD' },
  { pc: '00003008', kind: 'dm', target: '00000000', value: 'AABBCCDD' },
  { pc: '0000300C', kind: 'grf', target: '2', value: 'AABBCCDD' },
  { pc: '00003010', kind: 'grf', target: '3', value: '557799BA' },
  { pc: '00003014', kind: 'dm', target: '00000004', value: '557799BA' }
];

/**
 * P6 partial-word stores over a known word. Little endian: byte address `1` is bits
 * 15:8 and half-word address `2` is bits 31:16.
 *
 *   DM[0] = 0xAABBCCDD -> sb 0x11 @1 -> 0xAABB11DD -> sh 0x2233 @2 -> 0x223311DD
 */
const partialStoreProgram = [
  op('lui', { rt: 1, immediate: 0xaabb }), //        0x3000
  op('ori', { rs: 1, rt: 1, immediate: 0xccdd }), // 0x3004 $1 = 0xAABBCCDD
  op('sw', { rs: 0, rt: 1, immediate: 0 }), //       0x3008 DM[0x0] = 0xAABBCCDD
  op('ori', { rs: 0, rt: 2, immediate: 0x0011 }), // 0x300c $2 = 0x00000011
  op('sb', { rs: 0, rt: 2, immediate: 1 }), //       0x3010 byte lane 1
  op('ori', { rs: 0, rt: 3, immediate: 0x2233 }), // 0x3014 $3 = 0x00002233
  op('sh', { rs: 0, rt: 3, immediate: 2 }), //       0x3018 byte lanes 2 and 3
  ...haltSequence //                                 0x301c / 0x3020
];

/**
 * P6 coverage program. The taken branch at `0x301c` skips `0x3024`, so the sentinel
 * `ori $3` there must never contribute an instruction bin.
 */
const coverageProgram = [
  op('ori', { rs: 0, rt: 1, immediate: 1 }), //      0x3000 $1 = 1
  op('beq', { rs: 1, rt: 0, immediate: 2 }), //      0x3004 not taken (1 != 0)
  op('nop'), //                                     0x3008 delay slot
  op('sw', { rs: 0, rt: 1, immediate: 0 }), //       0x300c DM[0x0]    = 0x00000001
  op('sb', { rs: 0, rt: 1, immediate: 1 }), //       0x3010 DM[0x0]    = 0x00000101
  op('lw', { rs: 0, rt: 2, immediate: 0 }), //       0x3014 $2 = 0x00000101
  op('sw', { rs: 0, rt: 2, immediate: 0x2ffc }), //  0x3018 DM[0x2FFC] = last DM word
  op('beq', { rs: 0, rt: 0, immediate: 2 }), //      0x301c taken -> 0x3028
  op('nop'), //                                     0x3020 delay slot
  op('ori', { rs: 0, rt: 3, immediate: 0x0dea }), // 0x3024 skipped sentinel
  ...haltSequence //                                 0x3028 / 0x302c
];

const coverageExpectedTrace: readonly ArchitecturalWriteRecord[] = [
  { pc: '00003000', kind: 'grf', target: '1', value: '00000001' },
  { pc: '0000300C', kind: 'dm', target: '00000000', value: '00000001' },
  { pc: '00003010', kind: 'dm', target: '00000000', value: '00000101' },
  { pc: '00003014', kind: 'grf', target: '2', value: '00000101' },
  { pc: '00003018', kind: 'dm', target: '00002FFC', value: '00000101' }
];

/** Committed instructions of `coverageProgram`, counted by hand from the listing. */
const coverageInstructionCount = 11;

/**
 * P7 SR value installing `IE = 1` (bit 0) and unmasking HWInt line 2, the interrupt
 * generator (SR.IM is bits 15:10, so line 2 is SR bit 12).
 */
const srIeWithExternalUnmasked = 0x0000_1001;

// ── 1. round-trip through the DUT-side parser ────────────────────────────────

describe('course architectural write trace', () => {
  it('projects a P3 program into the course GRF/DM lines', () => {
    const { records } = project('P3', p3Program);
    expect(records).toEqual(p3Expected);
  });

  it('round-trips every projected record through the course trace parser', () => {
    const { records } = project('P3', p3Program);
    expect(records.length).toBe(p3Expected.length);
    for (const record of records) {
      const label = formatArchitecturalWrite(record);
      expect(comparable(reparse(record)), label).toEqual(record);
    }
  });

  it('renders the exact P3 text the course GRF/DM modules print', () => {
    const { records } = project('P3', p3Program);
    // $display("@%h: $%d <= %h") / $display("@%h: *%h <= %h") — [P4-7].
    expect(formatArchitecturalWrites(records).split('\n')).toEqual([
      '@00003000: $1 <= AABB0000',
      '@00003004: $1 <= AABBCCDD',
      '@00003008: *00000000 <= AABBCCDD',
      '@0000300C: $2 <= AABBCCDD',
      '@00003010: $3 <= 557799BA',
      '@00003014: *00000004 <= 557799BA'
    ]);
  });
});

// ── 2/3. suppressed write classes ────────────────────────────────────────────

describe('trace projection write filter', () => {
  it('suppresses $0, HI/LO and CP0 writes from one commit event', () => {
    // The course GRF logs only `w_grf_we && w_grf_addr != 0`; HI/LO and CP0 are not
    // wired to the trace at all (P7-2-6 "写入时无需 display").
    const event: CommitEvent = {
      sequence: 0,
      kind: 'instruction',
      pcBefore: 0x0000_3000,
      pcAfter: 0x0000_3004,
      gprWrites: [
        { register: 0, value: 0x0000_1234 },
        { register: 5, value: 0x0000_0007 }
      ],
      hiLoWrites: [
        { register: 'hi', value: 0x0000_00aa },
        { register: 'lo', value: 0x0000_00bb }
      ],
      cp0Writes: [{ register: 12, valueBefore: 0, value: 0x0000_0003 }],
      memoryWrites: [],
      deviceEvents: []
    };
    expect(projectCommitEvent(event, resolveCourseProfile('P3'))).toEqual([
      { pc: '00003000', kind: 'grf', target: '5', value: '00000007' }
    ]);
  });

  it('never emits a $0 line for an executed write to $0', () => {
    const { trace, records } = project('P3', p3Program);
    // The filter keys on the destination register, not on the mnemonic: the `ori`
    // at 0x3004 writes $1 and is logged, the `ori` at 0x3018 writes $0 and is not.
    expect(records.some((record) => record.pc === '00003004')).toBe(true);
    const suppressed = committedEvents(trace).find((event) => event.pcBefore === 0x0000_3018)!;
    expect(suppressed.mnemonic).toBe('ori');
    expect(suppressed.gprWrites).toEqual([]);
    expect(records.some((record) => record.kind === 'grf' && record.target === '0')).toBe(false);
    expect(records.some((record) => record.pc === '00003018')).toBe(false);
  });

  it('drops the HI/LO writes of mult and keeps only the mflo GPR write', () => {
    const program = [
      op('ori', { rs: 0, rt: 1, immediate: 6 }), // 0x3000
      op('ori', { rs: 0, rt: 2, immediate: 7 }), // 0x3004
      op('mult', { rs: 1, rt: 2 }), //             0x3008 HI = 0, LO = 42
      op('mflo', { rd: 3 }), //                    0x300c $3 = 42 = 0x2A
      ...haltSequence
    ];
    const { trace, records } = project('P6', program);
    const mult = eventFor(trace, 'mult');
    expect(mult.hiLoWrites).toEqual([
      { register: 'hi', value: 0 },
      { register: 'lo', value: 42 }
    ]);
    expect(mult.gprWrites).toEqual([]);
    expect(projectCommitEvent(mult, resolveCourseProfile('P6'))).toEqual([]);
    expect(records).toEqual([
      { pc: '00003000', kind: 'grf', target: '1', value: '00000006' },
      { pc: '00003004', kind: 'grf', target: '2', value: '00000007' },
      { pc: '0000300C', kind: 'grf', target: '3', value: '0000002A' }
    ]);
  });

  it('drops the CP0 write of mtc0', () => {
    const program = [
      op('ori', { rs: 0, rt: 1, immediate: srIeWithExternalUnmasked }), // 0x3000
      op('mtc0', { rt: 1, rd: 12 }), //                                   0x3004 SR = 0x1001
      ...haltSequence
    ];
    const { trace, records } = project('P7', program);
    const mtc0 = eventFor(trace, 'mtc0');
    expect(mtc0.cp0Writes).toEqual([
      { register: 12, valueBefore: 0, value: srIeWithExternalUnmasked }
    ]);
    expect(projectCommitEvent(mtc0, resolveCourseProfile('P7'))).toEqual([]);
    expect(records).toEqual([
      { pc: '00003000', kind: 'grf', target: '1', value: '00001001' }
    ]);
  });
});

// ── 4. partial-word stores ───────────────────────────────────────────────────

describe('partial-word store projection', () => {
  it('projects sb and sh onto the aligned word address and the merged word', () => {
    const { records } = project('P6', partialStoreProgram);
    expect(records).toEqual([
      { pc: '00003000', kind: 'grf', target: '1', value: 'AABB0000' },
      { pc: '00003004', kind: 'grf', target: '1', value: 'AABBCCDD' },
      { pc: '00003008', kind: 'dm', target: '00000000', value: 'AABBCCDD' },
      { pc: '0000300C', kind: 'grf', target: '2', value: '00000011' },
      // `sb $2, 1($0)`: the official tb logs `m_data_addr & ~3` and the byte-enable
      // merged word, so the address is 0x00000000 and the value 0xAABB11DD.
      { pc: '00003010', kind: 'dm', target: '00000000', value: 'AABB11DD' },
      { pc: '00003014', kind: 'grf', target: '3', value: '00002233' },
      { pc: '00003018', kind: 'dm', target: '00000000', value: '223311DD' }
    ]);
  });

  it('keeps the raw address and raw value out of the projected line', () => {
    const { trace } = project('P6', partialStoreProgram);
    const store = eventFor(trace, 'sb').memoryWrites[0];
    // Little endian: byte address 1 is bits 15:8, so the byte enable is 0b0010.
    expect(store.address).toBe(0x0000_0001);
    expect(store.rawValue).toBe(0x0000_0011);
    expect(store.byteMask).toBe(0b0010);
    expect(store.wordAddress).toBe(0x0000_0000);
    expect(store.valueBefore).toBe(0xaabb_ccdd);
    expect(store.valueAfter).toBe(0xaabb_11dd);

    const half = eventFor(trace, 'sh').memoryWrites[0];
    // Half-word address 2 is bits 31:16, so the byte enable is 0b1100.
    expect(half.address).toBe(0x0000_0002);
    expect(half.rawValue).toBe(0x0000_2233);
    expect(half.byteMask).toBe(0b1100);
    expect(half.wordAddress).toBe(0x0000_0000);
    expect(half.valueAfter).toBe(0x2233_11dd);
  });
});

// ── 5. device stores are not DM lines ────────────────────────────────────────

describe('device transaction exclusion', () => {
  it('keeps Timer and interrupt-generator stores out of the DM trace', () => {
    const program = [
      op('ori', { rs: 0, rt: 1, immediate: 5 }), //            0x3000 $1 = 5
      op('sw', { rs: 0, rt: 1, immediate: 0x7f04 }), //        0x3004 Timer0 PRESET
      op('sb', { rs: 0, rt: 0, immediate: 0x7f20 }), //        0x3008 IG acknowledge
      op('sw', { rs: 0, rt: 1, immediate: 0 }), //             0x300c DM[0x0] = 5
      ...haltSequence
    ];
    const { trace, records } = project('P7', program, { deviceSchedule: timersEnabled });

    // The stores really happened: they are memory writes tagged with a device region.
    const regions = committedEvents(trace)
      .flatMap((event) => event.memoryWrites.map((write) => write.region));
    expect(regions).toEqual(['timer0', 'interrupt-generator', 'data']);

    // Only the DM port feeds the course DM trace (P7-2-2 系统桥地址表).
    expect(records).toEqual([
      { pc: '00003000', kind: 'grf', target: '1', value: '00000005' },
      { pc: '0000300C', kind: 'dm', target: '00000000', value: '00000005' }
    ]);
    expect(records.some((record) => record.target === '00007F04')).toBe(false);
    expect(records.some((record) => record.target === '00007F20')).toBe(false);
  });
});

// ── 6. cycle prefix ──────────────────────────────────────────────────────────

describe('trace cycle prefix', () => {
  const p5Program = [
    op('ori', { rs: 0, rt: 1, immediate: 3 }), // 0x3000
    op('sw', { rs: 0, rt: 1, immediate: 4 }), //  0x3004 DM[0x4] = 3
    ...haltSequence //                            0x3008 / 0x300c
  ];

  it('omits the $time prefix even for a profile whose DUT emits one', () => {
    // P5-5-2 prints `%d@%h: ...`, but the oracle has no cycle domain and must not
    // fabricate one; the comparison side ignores the prefix instead.
    for (const id of ['P5', 'P6', 'P7'] as const) {
      expect(resolveCourseProfile(id).trace.dutCyclePrefix, id).toBe(true);
    }
    const { records } = project('P5', p5Program);
    expect(records).toEqual([
      { pc: '00003000', kind: 'grf', target: '1', value: '00000003' },
      { pc: '00003004', kind: 'dm', target: '00000004', value: '00000003' }
    ]);
    for (const record of records) {
      const line = formatArchitecturalWrite(record);
      expect(line.startsWith('@'), line).toBe(true);
      expect(reparse(record).cycle, line).toBeUndefined();
    }
    // The record shape itself carries no cycle field.
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(['kind', 'pc', 'target', 'value']);
    }
  });

  it('produces the <n>@ form only when a DUT cycle is supplied', () => {
    const { records } = project('P5', p5Program);
    const [grf, dm] = records;
    expect(formatArchitecturalWrite(grf, 17)).toBe('17@00003000: $1 <= 00000003');
    expect(formatArchitecturalWrite(dm, 42)).toBe('42@00003004: *00000004 <= 00000003');
    // Cycle 0 is a real DUT cycle, not "no cycle".
    expect(formatArchitecturalWrite(grf, 0)).toBe('0@00003000: $1 <= 00000003');
    for (const [record, cycle] of [[grf, 17], [dm, 42], [grf, 0]] as const) {
      const parsed = reparse(record, cycle);
      expect(parsed.cycle, `cycle ${cycle}`).toBe(cycle);
      expect(comparable(parsed), `cycle ${cycle}`).toEqual(record);
    }
  });
});

// ── 7. traps commit nothing ──────────────────────────────────────────────────

describe('trap victim projection', () => {
  it('emits no line for an overflow victim', () => {
    // P7 `add` raises Ov (ExcCode 12) instead of writing $2, so the destination
    // register write never reaches the GRF trace.
    const program = [
      op('lui', { rt: 1, immediate: 0x7fff }), //        0x3000
      op('ori', { rs: 1, rt: 1, immediate: 0xffff }), // 0x3004 $1 = 0x7FFFFFFF
      op('add', { rd: 2, rs: 1, rt: 1 }) //              0x3008 Ov
    ];
    const { trace, records } = project('P7', program, { kernelWords: haltSequence });
    const victim = trace.events.find((event) => event.trap !== undefined)!;
    expect(victim.trap!.name).toBe('ov');
    expect(victim.mnemonic).toBe('add');
    expect(victim.gprWrites).toEqual([]);
    expect(projectCommitEvent(victim, resolveCourseProfile('P7'))).toEqual([]);
    expect(records).toEqual([
      { pc: '00003000', kind: 'grf', target: '1', value: '7FFF0000' },
      { pc: '00003004', kind: 'grf', target: '1', value: '7FFFFFFF' }
    ]);
  });

  it('emits no line for a delay-slot store interrupted before commit', () => {
    // The interrupt generator drives HWInt line 2; the victim is the delay-slot
    // `sw`, so Cause.BD = 1 and EPC = victimPc - 4 (P7-2-6).
    const program = [
      op('ori', { rs: 0, rt: 1, immediate: srIeWithExternalUnmasked }), // 0x3000
      op('mtc0', { rt: 1, rd: 12 }), //                                   0x3004
      op('beq', { rs: 0, rt: 0, immediate: 2 }), //                       0x3008 taken
      op('sw', { rs: 0, rt: 1, immediate: 0 }) //                         0x300c victim
    ];
    const { session, trace, records } = project('P7', program, {
      kernelWords: haltSequence,
      externalInterrupts: [{ victimPc: 0x0000_300c, occurrence: 1 }]
    });
    const victim = trace.events.find((event) => event.trap !== undefined)!;
    expect(victim.trap!.kind).toBe('interrupt');
    expect(victim.trap!.branchDelay).toBe(true);
    expect(victim.trap!.epc).toBe(0x0000_3008);
    expect(victim.mnemonic).toBe('sw');
    expect(victim.memoryWrites).toEqual([]);
    expect(projectCommitEvent(victim, resolveCourseProfile('P7'))).toEqual([]);
    // Only the SR staging write survives; the suppressed store leaves DM at reset.
    expect(records).toEqual([
      { pc: '00003000', kind: 'grf', target: '1', value: '00001001' }
    ]);
    expect(session.snapshot('full').dataWords).toEqual([]);
  });
});

// ── 8. coverage bins ─────────────────────────────────────────────────────────

describe('execution coverage bins', () => {
  it('bins instructions, both branch directions, store lanes and DM boundaries', () => {
    const { trace } = project('P6', coverageProgram);
    expect(trace.events.length).toBe(coverageInstructionCount);
    const bins: readonly CoverageBin[] = coverageOf('P6', trace).bins();
    // Hand-counted from the listing above; the sentinel `ori` at 0x3024 is skipped
    // by the taken branch, so `execution.instruction.P6.ori` stays at one.
    expect(bins).toEqual([
      { id: 'execution.address-boundary.data.first', hits: 3 },
      { id: 'execution.address-boundary.data.last', hits: 1 },
      { id: 'execution.branch.beq.not-taken', hits: 1 },
      { id: 'execution.branch.beq.taken', hits: 2 },
      { id: 'execution.delay-slot.committed', hits: 3 },
      { id: 'execution.instruction.P6.beq', hits: 3 },
      { id: 'execution.instruction.P6.lw', hits: 1 },
      { id: 'execution.instruction.P6.nop', hits: 3 },
      { id: 'execution.instruction.P6.ori', hits: 1 },
      { id: 'execution.instruction.P6.sb', hits: 1 },
      { id: 'execution.instruction.P6.sw', hits: 2 },
      { id: 'execution.load-lane.lw.0', hits: 1 },
      { id: 'execution.load-lane.lw.1', hits: 1 },
      { id: 'execution.load-lane.lw.2', hits: 1 },
      { id: 'execution.load-lane.lw.3', hits: 1 },
      { id: 'execution.store-lane.sb.1', hits: 1 },
      { id: 'execution.store-lane.sw.0', hits: 2 },
      { id: 'execution.store-lane.sw.1', hits: 2 },
      { id: 'execution.store-lane.sw.2', hits: 2 },
      { id: 'execution.store-lane.sw.3', hits: 2 }
    ]);
  });

  it('bins only the byte lane a partial store actually enables', () => {
    const { trace } = project('P6', partialStoreProgram);
    const coverage = coverageOf('P6', trace);
    // `sb` at byte address 1 touches lane 1 alone; `sh` at 2 touches lanes 2 and 3.
    expect(coverage.hits('execution.store-lane.sb.1')).toBe(1);
    for (const lane of [0, 2, 3]) {
      expect(coverage.hits(`execution.store-lane.sb.${lane}`), `sb lane ${lane}`).toBe(0);
    }
    expect(coverage.hits('execution.store-lane.sh.2')).toBe(1);
    expect(coverage.hits('execution.store-lane.sh.3')).toBe(1);
    for (const lane of [0, 1]) {
      expect(coverage.hits(`execution.store-lane.sh.${lane}`), `sh lane ${lane}`).toBe(0);
    }
    for (let lane = 0; lane < 4; lane++) {
      expect(coverage.hits(`execution.store-lane.sw.${lane}`), `sw lane ${lane}`).toBe(1);
    }
  });

  it('bins the first and last DM word by the frozen region bounds', () => {
    const coverage = coverageOf('P6', project('P6', coverageProgram).trace);
    // DM is 0x0000_0000..0x0000_2FFF, so the last aligned word is 0x0000_2FFC.
    expect(coverage.hits('execution.address-boundary.data.first')).toBe(3);
    expect(coverage.hits('execution.address-boundary.data.last')).toBe(1);
    // IM 0x3000..0x6FFF is never a data address, so its boundaries stay empty.
    expect(coverage.hits('execution.address-boundary.text.first')).toBe(0);
    expect(coverage.hits('execution.address-boundary.text.last')).toBe(0);
  });

  it('bins a P7 overflow exception with its detection stage and BD flag', () => {
    const program = [
      op('lui', { rt: 1, immediate: 0x7fff }), //        0x3000
      op('ori', { rs: 1, rt: 1, immediate: 0xffff }), // 0x3004 $1 = 0x7FFFFFFF
      op('add', { rd: 2, rs: 1, rt: 1 }) //              0x3008 Ov, detected in E
    ];
    const { trace } = project('P7', program, { kernelWords: haltSequence });
    const coverage = coverageOf('P7', trace);
    expect(coverage.hits('execution.exception.ov.execute')).toBe(1);
    expect(coverage.hits('execution.trap-bd.normal')).toBe(1);
    expect(coverage.hits('execution.trap-bd.delay-slot')).toBe(0);
    expect(coverage.hits('execution.interrupt.accepted')).toBe(0);
    // The victim still resolved a mnemonic, so its instruction bin is credited.
    expect(coverage.hits('execution.instruction.P7.add')).toBe(1);
    // A trap writes Cause(13), EPC(14) and SR(12); the course never writes Cause
    // from a test program, so these come from the Req itself.
    expect(coverage.hits('execution.cp0-write.12')).toBe(1);
    expect(coverage.hits('execution.cp0-write.13')).toBe(1);
    expect(coverage.hits('execution.cp0-write.14')).toBe(1);
  });

  it('bins an accepted external interrupt on a delay-slot victim', () => {
    const program = [
      op('ori', { rs: 0, rt: 1, immediate: srIeWithExternalUnmasked }), // 0x3000
      op('mtc0', { rt: 1, rd: 12 }), //                                   0x3004
      op('beq', { rs: 0, rt: 0, immediate: 2 }), //                       0x3008 taken
      op('sw', { rs: 0, rt: 1, immediate: 0 }) //                         0x300c victim
    ];
    const { trace } = project('P7', program, {
      kernelWords: haltSequence,
      externalInterrupts: [{ victimPc: 0x0000_300c, occurrence: 1 }]
    });
    const coverage = coverageOf('P7', trace);
    expect(coverage.hits('execution.interrupt.accepted')).toBe(1);
    // HWInt line 2 is the interrupt generator (P7-2-6 中断规范).
    expect(coverage.hits('execution.interrupt.external')).toBe(1);
    expect(coverage.hits('execution.interrupt.timer0')).toBe(0);
    expect(coverage.hits('execution.interrupt.timer1')).toBe(0);
    expect(coverage.hits('execution.trap-bd.delay-slot')).toBe(1);
    expect(coverage.hits('execution.trap-bd.normal')).toBe(0);
    // The victim is a delay-slot instruction that committed nothing.
    expect(coverage.hits('execution.delay-slot.victim')).toBe(1);
    expect(coverage.hits('execution.instruction.P7.sw')).toBe(1);
    for (let lane = 0; lane < 4; lane++) {
      expect(coverage.hits(`execution.store-lane.sw.${lane}`), `lane ${lane}`).toBe(0);
    }
    expect(coverage.hits('execution.address-boundary.data.first')).toBe(0);
    expect(coverage.hits('execution.device.interrupt-generator.external-interrupt-asserted'))
      .toBe(1);
    // `mtc0 $1, $12` plus the Req's own SR update.
    expect(coverage.hits('execution.cp0-write.12')).toBe(2);
  });
});

// ── 9. bounded execution driver ──────────────────────────────────────────────

describe('bounded execution driver', () => {
  function digestAfter(instructions: number, level: 'registers' | 'full'): string {
    const session = makeSession('P6', coverageProgram);
    for (let index = 0; index < instructions; index++) {
      const result = session.stepInstruction();
      const expected = index === coverageInstructionCount - 1 ? 'halted' : 'committed';
      expect(result.status, `step ${index + 1}`).toBe(expected);
    }
    return session.snapshot(level).digest;
  }

  it('collects the projected trace and the coverage bins on request', () => {
    const outcome = runCourseProgram(makeSession('P6', coverageProgram), {
      collectTrace: true,
      collectCoverage: true
    });
    expect(outcome.status).toBe('halted');
    expect(outcome.haltReason).toBe('course-halt-loop');
    expect(outcome.instructions).toBe(coverageInstructionCount);
    expect(outcome.eventCount).toBe(coverageInstructionCount);
    expect(outcome.trace).toEqual(coverageExpectedTrace);
    expect(outcome.coverage)
      .toEqual(coverageOf('P6', project('P6', coverageProgram).trace).bins());
  });

  it('omits trace and coverage when they were not requested', () => {
    const outcome = runCourseProgram(makeSession('P6', coverageProgram));
    expect(outcome.trace).toBeUndefined();
    expect(outcome.coverage).toBeUndefined();
    expect(outcome.retainedEvents).toEqual([]);
    expect(outcome.checkpoints).toEqual([]);
    expect(outcome.eventCount).toBe(coverageInstructionCount);
  });

  it('retains only a bounded tail of the event stream', () => {
    const outcome = runCourseProgram(makeSession('P6', coverageProgram), { retainEvents: 3 });
    expect(outcome.eventCount).toBe(coverageInstructionCount);
    expect(outcome.retainedEvents.length).toBe(3);
    // Oldest first: the last three committed PCs of the listing.
    expect(outcome.retainedEvents.map((event) => event.pcBefore))
      .toEqual([0x0000_3020, 0x0000_3028, 0x0000_302c]);

    const whole = runCourseProgram(makeSession('P6', coverageProgram), {
      retainEvents: coverageInstructionCount * 2
    });
    expect(whole.retainedEvents.length).toBe(coverageInstructionCount);
    expect(whole.retainedEvents[0].pcBefore).toBe(0x0000_3000);
  });

  it('records a checkpoint digest at every requested instruction interval', () => {
    const outcome = runCourseProgram(makeSession('P6', coverageProgram), {
      checkpointInterval: 3
    });
    // 11 instructions commit; the eleventh halts, so only 3, 6 and 9 checkpoint.
    expect(outcome.checkpoints.map((checkpoint) => checkpoint.instruction)).toEqual([3, 6, 9]);
    for (const checkpoint of outcome.checkpoints) {
      expect(checkpoint.digest, `checkpoint ${checkpoint.instruction}`)
        .toMatch(/^[0-9a-f]{64}$/);
      expect(checkpoint.digest, `checkpoint ${checkpoint.instruction}`)
        .toBe(digestAfter(checkpoint.instruction, 'registers'));
    }
  });

  it('reports the final state digest of the full snapshot', () => {
    const outcome = runCourseProgram(makeSession('P6', coverageProgram));
    expect(outcome.finalSnapshot.level).toBe('full');
    expect(outcome.finalStateDigest).toBe(outcome.finalSnapshot.digest);
    expect(outcome.finalStateDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.finalStateDigest).toBe(digestAfter(coverageInstructionCount, 'full'));
    // The digest covers observable DM, so the two stores are inside it.
    expect(outcome.finalSnapshot.dataWords).toEqual([
      { address: 0x0000_0000, value: 0x0000_0101 },
      { address: 0x0000_2ffc, value: 0x0000_0101 }
    ]);

    const registersOnly = runCourseProgram(makeSession('P6', coverageProgram), {
      finalSnapshotLevel: 'registers'
    });
    expect(registersOnly.finalSnapshot.dataWords).toBeUndefined();
    expect(registersOnly.finalStateDigest).not.toBe(outcome.finalStateDigest);
  });

  it('yields one slice at a time so the caller can observe progress', () => {
    const slices: number[][] = [];
    const outcome = runCourseProgram(makeSession('P6', coverageProgram), {
      sliceSize: 4,
      onEvents: (events) => slices.push(events.map((event) => event.pcBefore))
    });
    expect(slices.map((slice) => slice.length)).toEqual([4, 4, 3]);
    expect(slices.flat().length).toBe(outcome.eventCount);
    expect(slices[0][0]).toBe(0x0000_3000);
    expect(slices[2].at(-1)).toBe(0x0000_302c);
  });

  it('stops immediately when the cancellation token is already aborted', () => {
    const session = makeSession('P6', coverageProgram);
    const outcome = runCourseProgram(session, {
      cancellation: { aborted: true },
      collectTrace: true,
      collectCoverage: true,
      retainEvents: 4,
      checkpointInterval: 1
    });
    expect(outcome.status).toBe('halted');
    expect(outcome.haltReason).toBe('cancelled');
    expect(outcome.instructions).toBe(0);
    expect(outcome.eventCount).toBe(0);
    expect(outcome.trace).toEqual([]);
    expect(outcome.coverage).toEqual([]);
    expect(outcome.retainedEvents).toEqual([]);
    expect(outcome.checkpoints).toEqual([]);
    // No instruction ran, so the machine is still at the reset PC.
    expect(outcome.finalSnapshot.pc).toBe(0x0000_3000);
    expect(session.instructionsExecuted).toBe(0);
  });

  it('rejects a non-positive slice size instead of looping forever', () => {
    for (const sliceSize of [0, -1, 1.5]) {
      expect(() => runCourseProgram(makeSession('P6', coverageProgram), { sliceSize }),
        `sliceSize ${sliceSize}`).toThrow(/sliceSize/);
    }
  });

  it('reports the self-branch PC as the halt PC on every profile', () => {
    // COURSE-COMMON-HALT-001 names the 0x1000ffff self-branch as the completion
    // point; `MachineSessionOptions.haltPc` and `AssembleResult.courseHaltPc` use
    // the same convention. On P3 there is no delay slot ([P4-1] 不考虑延迟槽) so the
    // branch is also the last committed word; on P5-P7 the run only stops after the
    // delay-slot `nop`, and `haltPc` must still name the branch rather than the nop.
    const noDelaySlot = runCourseProgram(makeSession('P3', [op('nop'), ...haltSequence]));
    expect(noDelaySlot.haltReason).toBe('course-halt-loop');
    expect(noDelaySlot.haltPc).toBe(0x0000_3004);

    for (const profile of ['P5', 'P6', 'P7'] as const) {
      const outcome = runCourseProgram(makeSession(profile, [op('nop'), ...haltSequence]));
      expect(outcome.haltReason, profile).toBe('course-halt-loop');
      expect(outcome.haltPc, profile).toBe(0x0000_3004);
      // The event that finally stops the run is the delay-slot nop at 0x3008.
      expect(outcome.finalSnapshot.pc, profile).toBe(0x0000_3004);
    }
  });
});
