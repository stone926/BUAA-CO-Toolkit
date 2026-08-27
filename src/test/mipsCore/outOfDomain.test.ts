import { describe, expect, it } from 'vitest';
import {
  ExecutionDiagnostic,
  OutOfDomainReason,
  executionDiagnosticPrefix
} from '../../mips/core/events/commitEvent';
import { CourseProfile, InstructionLayer } from '../../mips/core/generated/isaCatalog';
import { CourseSystemSession } from '../../mips/core/machine/system';
import {
  FixtureOptions,
  RunTrace,
  committedEvents,
  gprWrites,
  haltSequence,
  makeSession,
  memoryWrites,
  op,
  runToCompletion,
  textBase
} from './programFixtures';

/**
 * Comparable-domain classification: which inputs make the executor stop instead of
 * inventing a result, and which stable diagnostic it stops with.
 *
 * Every expected value below is transcribed from the frozen course contract /
 * decision ledger, never from the executor:
 *
 * - COURSE-P56-DOMAIN-001 (`conformance/mips/contract/contracts.json`, quoting
 *   `cscore/markdown/P5/testcases/P5-4-5.md` lines 10-77): the P5/P6 comparable
 *   domain forbids AdEL/AdES/RI in the corpus and puts `div/divu` by zero, `jalr`
 *   with the same two registers, and a second branch/jump inside a delay slot in
 *   the *undefined* domain — "执行器可确定化以便诊断，但不得作为严格 expected".
 *   The same clause pins IM to `0x3000..0x6fff` and DM to `0x0000..0x2fff`.
 * - COURSE-P7-UNLOADED-IM-001 (`conformance/mips/contract/decisions.json`, frozen
 *   product policy, plus its directed vectors in
 *   `conformance/mips/decision-vectors/COURSE-P7-UNLOADED-IM-001.json`): a word-
 *   aligned PC inside `0x3000..0x6ffc` that the ProgramImage does not provide stops
 *   the case with reason `unloaded-instruction`; it must NOT become AdEL and must
 *   NOT be zero-filled. Vector `strict-jump-to-missing-word` expects
 *   `{status: out-of-domain, reason: unloaded-instruction, instruction: null,
 *   synthetic: false, exception: null}`; `exploratory-zero-fill-is-marked` is the
 *   only way to keep running, and `outside-im-remains-adel` /
 *   `misaligned-im-remains-adel` keep the two fetch faults distinct.
 * - COURSE-P7-TIMER-MODE-001 (frozen decision): a Timer transaction the course has
 *   not defined must produce "明确的 undefined/unsupported 事件（带 contract ID）"
 *   rather than a guessed execution. The executor tags a Timer access made without
 *   a declared device cycle schedule with this id.
 * - P7-2-3 / COURSE-P7-EXC-012/013/017: on P7 the *same* inputs that leave the
 *   comparable domain on P3-P6 are architectural exceptions instead — AdEL = 4,
 *   AdES = 5, RI = 10 — so each split is asserted from both sides.
 * - The course defines no `Tr` exception code at all (`courseExceptionCodes` has
 *   only Int/AdEL/AdES/Syscall/RI/Ov), so a *taken* MIPS trap instruction has no
 *   course semantics on any profile, while a not-taken one is an ordinary no-op.
 *
 * The stable diagnostic surface itself is contractual: `ExecutionDiagnostic.code`
 * is documented as `mips-core.exec.<reason>`, so the last `describe` walks every
 * fixture in this file and checks the code against its reason mechanically.
 *
 * Where the executor attaches no `contractId` (the decode-level `unrecognized-` /
 * `unsupported-instruction` classifications) this file asserts the reason and the
 * code but deliberately does not assert that the id is *absent*: the id is an
 * optional diagnostic detail, and pinning its absence would freeze a gap.
 */

/** COURSE-P56-DOMAIN-001: the undefined-domain clause for P5/P6 inputs. */
const domainContract = 'COURSE-P56-DOMAIN-001';
/** COURSE-P7-UNLOADED-IM-001: the frozen unloaded-IM-word policy. */
const unloadedContract = 'COURSE-P7-UNLOADED-IM-001';
/** COURSE-P7-TIMER-MODE-001: undefined Timer input must be reported, not guessed. */
const timerModeContract = 'COURSE-P7-TIMER-MODE-001';

/** COURSE-P7-EXC-002 codes, needed only for the "not an exception" counterparts. */
const excCode = { adel: 4, ades: 5, ri: 10 } as const;

/** COURSE-P7-ADDR-004: the single exception/interrupt entry point. */
const handlerPc = 0x0000_4180;

/** `jalr`, `subu`, `teq`, `tne` live in the MARS layer, which is off by default. */
const marsLayers: readonly InstructionLayer[] = [
  'required', 'commonExtensions', 'marsCompatibility'
];

/** COURSE-P7-ADDR-002: IM is 0x3000..0x6fff, so the last instruction word is 0x6ffc. */
const lastImWord = 0x0000_6ffc;

/** Inside IM, word aligned, and past the end of the fixture image below. */
const unloadedPc = 0x0000_3100;

/**
 * The COURSE-P7-UNLOADED-IM-001 vector program: a tiny image that transfers control
 * to `unloadedPc`. The vector writes the transfer as `j 0x3100` (`0x08000c40`);
 * `j` sits in the marsCompatibility layer of this catalog, so the same transfer is
 * expressed with the required-layer `jr` to keep the default layer set in play.
 */
function jumpTo(target: number): readonly number[] {
  return [
    op('ori', { rs: 0, rt: 1, immediate: target }), // 0x3000
    op('jr', { rs: 1 }), // 0x3004
    op('nop') // 0x3008: the P5+ delay slot; unreachable on P3/P4
  ];
}

/** Raw words whose classification is the subject of a case, named once. */
const rawWords = {
  /** `subu $3, $1, $2`: a real encoding whose layer is off by default. */
  subu: op('subu', { rd: 3, rs: 1, rt: 2 }),
  /** opcode 0b111111 is used by no course instruction, in any layer. */
  unusedOpcode: 0xfc00_0000,
  /** COP0 opcode with rs = 7; the course only defines rs = 0 (mfc0) and 4 (mtc0). */
  cop0Selector: 0x40e0_0000,
  /** `div $1, $2` with `$2 = 0` — the COURSE-P56-DOMAIN-001 DivZero input. */
  divByZero: op('div', { rs: 1, rt: 2 }),
  /** `jalr $1, $1` — the COURSE-P56-DOMAIN-001 JalrSame input. */
  jalrSame: op('jalr', { rd: 1, rs: 1 }),
  /** `jal 0x3010`, whose delay slot then holds a second control transfer. */
  jal: op('jal', { index: 0x0000_3010 >>> 2 }),
  /** `beq $0, $0, +1` — the COURSE-P56-DOMAIN-001 DoubleDelay input. */
  delaySlotBranch: op('beq', { rs: 0, rt: 0, immediate: 1 }),
  /** `mfhi $1` before any mult/div/mthi defines HI. */
  mfhi: op('mfhi', { rd: 1 }),
  /** `lw` at a 1-byte offset: 4-byte alignment is required. */
  misalignedLoad: op('lw', { rs: 0, rt: 1, immediate: 1 }),
  /** `sw` aimed at IM, which never accepts a data access. */
  storeIntoIm: op('sw', { rs: 0, rt: 0, immediate: 0x3000 }),
  /** `lw` at the Timer0 CTRL port, which is not a region at all on P3-P6. */
  loadTimer0Ctrl: op('lw', { rs: 0, rt: 1, immediate: 0x7f00 }),
  /** `sw` at the Timer1 CTRL port. */
  storeTimer1Ctrl: op('sw', { rs: 0, rt: 0, immediate: 0x7f10 }),
  /** `sw` at the read-only Timer0 COUNT port. */
  storeTimer0Count: op('sw', { rs: 0, rt: 0, immediate: 0x7f08 }),
  /** `teq`/`tne` on two registers holding 5: teq traps, tne does not. */
  teq: op('teq', { rs: 1, rt: 2 }),
  tne: op('tne', { rs: 1, rt: 2 })
} as const;

/** `$1 = $2 = 5`, so a `teq $1, $2` traps and a `tne $1, $2` does not. */
const equalOperands = [
  op('ori', { rs: 0, rt: 1, immediate: 5 }),
  op('ori', { rs: 0, rt: 2, immediate: 5 })
] as const;

interface DomainCase {
  readonly label: string;
  readonly profile: CourseProfile;
  readonly words: readonly number[];
  readonly options?: FixtureOptions;
  readonly reason: OutOfDomainReason;
  /** PC the run must stop on; the machine may not advance past it. */
  readonly pc: number;
  /** Instruction word of the halt event; absent when nothing was fetched. */
  readonly haltWord?: number;
  /** Effective address the diagnostic must name, for address-bearing faults. */
  readonly address?: number;
  /** Course contract id, when the executor cites one. */
  readonly contractId?: string;
  /** GPR writes the instructions *before* the stop are allowed to commit. */
  readonly gprWrites: readonly (readonly [number, number])[];
}

// ── 1. unloaded instruction word (COURSE-P7-UNLOADED-IM-001) ─────────────────

/**
 * COURSE-P7-UNLOADED-IM-001 vector `strict-jump-to-missing-word`. `haltWord` is
 * deliberately absent: the vector expects `instruction: null`, because the fetch
 * never produced a word.
 */
function unloadedCase(profile: CourseProfile): DomainCase {
  return {
    label: `${profile}: jump to an unloaded IM word`,
    profile,
    words: jumpTo(unloadedPc),
    reason: 'unloaded-instruction',
    pc: unloadedPc,
    contractId: unloadedContract,
    gprWrites: [[1, unloadedPc]]
  };
}

const unloadedCases: readonly DomainCase[] = [
  unloadedCase('P4'), // no delay slot: `jr` lands on the bad PC directly
  unloadedCase('P6'), // one delay slot: the `nop` commits first
  unloadedCase('P7') // must stay out-of-domain rather than becoming AdEL
];

// ── 2. unrecognized instruction (COURSE-P56-DOMAIN-001 instruction-set clause) ─

const unrecognizedCases: readonly DomainCase[] = [
  ...(['P3', 'P4', 'P5', 'P6'] as const).flatMap((profile): DomainCase[] => [
    {
      label: `${profile}: subu with its layer disabled`,
      profile,
      words: [rawWords.subu],
      reason: 'unrecognized-instruction',
      pc: textBase,
      haltWord: rawWords.subu,
      gprWrites: []
    },
    {
      label: `${profile}: an opcode outside the course encoding space`,
      profile,
      words: [rawWords.unusedOpcode],
      reason: 'unrecognized-instruction',
      pc: textBase,
      haltWord: rawWords.unusedOpcode,
      gprWrites: []
    }
  ]),
  {
    // The COP0 opcode itself *is* in the P7 set, so this is not RI: only the
    // secondary rs selector has no course semantics.
    label: 'P7: a COP0 word whose rs selector has no course semantics',
    profile: 'P7',
    words: [rawWords.cop0Selector],
    reason: 'unrecognized-instruction',
    pc: textBase,
    haltWord: rawWords.cop0Selector,
    gprWrites: []
  }
];

// ── 3. undefined-domain arithmetic and control inputs ─────────────────────────

const divideByZeroCase: DomainCase = {
  label: 'P6: div with a zero divisor register',
  profile: 'P6',
  // `$1 = 7` first, so only the divisor is zero and the dividend cannot be blamed.
  words: [op('ori', { rs: 0, rt: 1, immediate: 7 }), rawWords.divByZero],
  reason: 'divide-by-zero',
  pc: textBase + 0x4,
  haltWord: rawWords.divByZero,
  contractId: domainContract,
  gprWrites: [[1, 7]]
};

const jalrSameRegisterCase: DomainCase = {
  label: 'P6: jalr whose link and target register are both $1',
  profile: 'P6',
  words: [rawWords.jalrSame],
  options: { layers: marsLayers },
  reason: 'jalr-same-register',
  pc: textBase,
  haltWord: rawWords.jalrSame,
  contractId: domainContract,
  gprWrites: []
};

const doubleDelaySlotCase: DomainCase = {
  label: 'P6: beq inside the delay slot of a jal',
  profile: 'P6',
  words: [rawWords.jal, rawWords.delaySlotBranch],
  reason: 'double-delay-slot',
  pc: textBase + 0x4,
  haltWord: rawWords.delaySlotBranch,
  contractId: domainContract,
  // P5+ links to PC + 8: the jal itself commits before the delay slot is rejected.
  gprWrites: [[31, textBase + 0x8]]
};

const undefinedHiLoCase: DomainCase = {
  label: 'P6: mfhi before HI has been defined',
  profile: 'P6',
  words: [rawWords.mfhi],
  reason: 'undefined-hi-lo-read',
  pc: textBase,
  haltWord: rawWords.mfhi,
  contractId: domainContract,
  gprWrites: []
};

// ── 4. P5/P6 memory domain (P7 raises AdEL/AdES for the same words) ───────────

const memoryDomainCases: readonly DomainCase[] = [
  {
    label: 'P6: lw at a 1-byte offset',
    profile: 'P6',
    words: [rawWords.misalignedLoad],
    reason: 'misaligned-access',
    pc: textBase,
    haltWord: rawWords.misalignedLoad,
    address: 0x0000_0001,
    contractId: domainContract,
    gprWrites: []
  },
  {
    label: 'P6: sw aimed at the instruction segment',
    profile: 'P6',
    words: [rawWords.storeIntoIm],
    reason: 'address-out-of-region',
    pc: textBase,
    haltWord: rawWords.storeIntoIm,
    address: 0x0000_3000,
    contractId: domainContract,
    gprWrites: []
  },
  {
    // P3-P6 declare no device regions at all, so the Timer port is simply unmapped.
    label: 'P6: lw at the Timer0 CTRL address',
    profile: 'P6',
    words: [rawWords.loadTimer0Ctrl],
    reason: 'address-out-of-region',
    pc: textBase,
    haltWord: rawWords.loadTimer0Ctrl,
    address: 0x0000_7f00,
    contractId: domainContract,
    gprWrites: []
  }
];

// ── 5. taken trap instructions: the course has no Tr exception code ───────────

const trapCases: readonly DomainCase[] = (['P6', 'P7'] as const).map((profile) => ({
  label: `${profile}: teq with equal operands`,
  profile,
  words: [...equalOperands, rawWords.teq],
  options: { layers: marsLayers },
  reason: 'unsupported-instruction',
  pc: textBase + 0x8,
  haltWord: rawWords.teq,
  gprWrites: [[1, 5], [2, 5]]
}));

// ── 6. Timer transactions without a declared cycle schedule ──────────────────

const timerScheduleCases: readonly DomainCase[] = [
  {
    label: 'P7: lw at the Timer0 CTRL port',
    profile: 'P7',
    words: [rawWords.loadTimer0Ctrl],
    reason: 'device-schedule-missing',
    pc: textBase,
    haltWord: rawWords.loadTimer0Ctrl,
    address: 0x0000_7f00,
    contractId: timerModeContract,
    gprWrites: []
  },
  {
    label: 'P7: sw at the Timer1 CTRL port',
    profile: 'P7',
    words: [rawWords.storeTimer1Ctrl],
    reason: 'device-schedule-missing',
    pc: textBase,
    haltWord: rawWords.storeTimer1Ctrl,
    address: 0x0000_7f10,
    contractId: timerModeContract,
    gprWrites: []
  },
  {
    // Without a schedule the core may not even claim the AdES that a COUNT write
    // would earn once the Timer is in the comparable domain.
    label: 'P7: sw at the read-only Timer0 COUNT port',
    profile: 'P7',
    words: [rawWords.storeTimer0Count],
    reason: 'device-schedule-missing',
    pc: textBase,
    haltWord: rawWords.storeTimer0Count,
    address: 0x0000_7f08,
    contractId: timerModeContract,
    gprWrites: []
  }
];

const allCases: readonly DomainCase[] = [
  ...unloadedCases,
  ...unrecognizedCases,
  divideByZeroCase,
  jalrSameRegisterCase,
  doubleDelaySlotCase,
  undefinedHiLoCase,
  ...memoryDomainCases,
  ...trapCases,
  ...timerScheduleCases
];

interface DomainRun {
  readonly session: CourseSystemSession;
  readonly trace: RunTrace;
}

function runCase(entry: DomainCase): DomainRun {
  const session = makeSession(entry.profile, entry.words, entry.options ?? {});
  return { session, trace: runToCompletion(session) };
}

/** Assert the shared fail-closed contract and hand back the diagnostic. */
function expectOutOfDomain(entry: DomainCase, run: DomainRun): ExecutionDiagnostic {
  const label = entry.label;
  const { trace } = run;

  expect(trace.last.status, label).toBe('out-of-domain');
  expect(run.session.done, label).toBe(true);

  const diagnostic = trace.last.diagnostic;
  expect(diagnostic, label).toBeDefined();
  expect(diagnostic!.reason, label).toBe(entry.reason);
  expect(diagnostic!.code, label).toBe(`${executionDiagnosticPrefix}.${entry.reason}`);
  expect(diagnostic!.pc, label).toBe(entry.pc);
  if (entry.address !== undefined) {
    expect(diagnostic!.address, label).toBe(entry.address);
  }
  if (entry.contractId !== undefined) {
    expect(diagnostic!.contractId, label).toBe(entry.contractId);
  }

  const halt = trace.last.event;
  expect(halt, label).toBeDefined();
  expect(halt!.kind, label).toBe('halt');
  expect(halt!.haltReason, label).toBe('out-of-domain');
  expect(halt!.pcBefore, label).toBe(entry.pc);
  // Fail closed: the PC never moved past the offending instruction.
  expect(halt!.pcAfter, label).toBe(entry.pc);
  expect(halt!.instructionWord, label).toBe(entry.haltWord);

  return diagnostic!;
}

function trapEvents(trace: RunTrace): RunTrace['events'] {
  return trace.events.filter((event) => event.trap !== undefined);
}

describe('unloaded instruction-word classification', () => {
  it('stops the run with unloaded-instruction on every profile', () => {
    expect(unloadedCases.map((entry) => entry.profile)).toEqual(['P4', 'P6', 'P7']);
    // The target must be legal-but-unloaded for the case to mean anything:
    // word aligned, inside IM (COURSE-P7-ADDR-002), and past the 3-word image.
    expect(unloadedPc % 4).toBe(0);
    expect(unloadedPc).toBeGreaterThan(textBase + 2 * 4);
    expect(unloadedPc).toBeLessThanOrEqual(lastImWord);

    for (const entry of unloadedCases) {
      const run = runCase(entry);
      expectOutOfDomain(entry, run);
      const label = entry.label;

      // Vector `strict-jump-to-missing-word`: `instruction: null`, `synthetic: false`.
      expect(run.trace.last.diagnostic!.instructionWord, label).toBeUndefined();
      expect(run.trace.last.event!.instructionWord, label).toBeUndefined();
      // ... and `exception: null` — this is never AdEL, not even on P7.
      expect(trapEvents(run.trace), label).toEqual([]);
      expect(run.trace.last.diagnostic!.contractId, label).toBe(unloadedContract);
      // The transfer itself committed; the missing word contributed nothing.
      expect(gprWrites(run.trace), label).toEqual([[1, unloadedPc]]);
      expect(run.session.snapshot().pc, label).toBe(unloadedPc);
    }
  });

  it('keeps the P7 unloaded-word stop distinct from a fetch address error', () => {
    // Vector `outside-im-remains-adel`: 0x7000 is past the last IM word, so it is
    // an ordinary AdEL and must not be reported as an unloaded word.
    const outsideIm = 0x0000_7000;
    expect(outsideIm).toBeGreaterThan(lastImWord);

    const session = makeSession('P7', jumpTo(outsideIm), { kernelWords: haltSequence });
    const trace = runToCompletion(session);
    const trap = trapEvents(trace)[0]?.trap;

    expect(trap, 'a PC outside IM is an architectural fetch error').toBeDefined();
    expect(trap!.name).toBe('adel');
    expect(trap!.code).toBe(excCode.adel);
    expect(trap!.stage).toBe('fetch');
    expect(trap!.victimPc).toBe(outsideIm);
    expect(trap!.epc).toBe(outsideIm);
    expect(trace.results.some((result) => result.status === 'out-of-domain')).toBe(false);
  });
});

describe('exploratory synthetic-zero fetch policy', () => {
  it('continues past the unloaded word and no longer stops out-of-domain', () => {
    // Vector `exploratory-zero-fill-is-marked`: the explicit escape hatch turns the
    // same program into `{status: execute, instruction: 0x00000000}`. It is the only
    // policy allowed to keep running (COURSE-P7-UNLOADED-IM-001).
    const session = makeSession('P6', jumpTo(unloadedPc), {
      unloadedInstruction: 'synthetic-zero',
      maxSteps: 12
    });
    const trace = runToCompletion(session);

    // ori, jr, delay-slot nop, then the synthesized word at the unloaded PC.
    const synthesized = trace.results[3];
    expect(synthesized.status).toBe('committed');
    expect(synthesized.event!.pcBefore).toBe(unloadedPc);
    expect(synthesized.event!.instructionWord).toBe(0x0000_0000);
    expect(synthesized.event!.mnemonic).toBe('nop');
    expect(synthesized.event!.gprWrites).toEqual([]);
    expect(synthesized.event!.pcAfter).toBe(unloadedPc + 4);

    // The run ends on its instruction budget, not on the domain classification.
    expect(trace.last.status).toBe('step-limit');
    expect(trace.results.some((result) => result.status === 'out-of-domain')).toBe(false);
    expect(trace.results.some((result) =>
      result.diagnostic?.reason === 'unloaded-instruction')).toBe(false);

    // Identical program, default policy: the strict lane still fails closed.
    expectOutOfDomain(unloadedCase('P6'), runCase(unloadedCase('P6')));
  });
});

describe('unrecognized-instruction classification outside P7', () => {
  it('stops the run on P3-P6 and raises RI for the same word on P7', () => {
    // Cross-check the raw words before relying on them.
    expect(rawWords.subu, 'subu $3, $1, $2').toBe(0x0022_1823);
    expect(rawWords.unusedOpcode >>> 26, 'unused opcode').toBe(0b111111);

    const beforeP7 = unrecognizedCases.filter((item) => item.profile !== 'P7');
    expect(beforeP7.map((item) => item.profile))
      .toEqual(['P3', 'P3', 'P4', 'P4', 'P5', 'P5', 'P6', 'P6']);

    for (const entry of beforeP7) {      const run = runCase(entry);
      expectOutOfDomain(entry, run);
      // P3-P6 model no architectural exceptions at all, so there is nothing to
      // raise: the input simply leaves the comparable domain.
      expect(trapEvents(run.trace), entry.label).toEqual([]);
      expect(run.session.snapshot().cp0, entry.label).toBeUndefined();
    }

    for (const word of [rawWords.subu, rawWords.unusedOpcode]) {
      const label = `P7 word 0x${word.toString(16)}`;
      const session = makeSession('P7', [word], { kernelWords: haltSequence });
      const trace = runToCompletion(session);
      const trap = trapEvents(trace)[0]?.trap;

      // COURSE-P7-EXC-017: on P7 the very same word is a decode-stage RI.
      expect(trap, label).toBeDefined();
      expect(trap!.name, label).toBe('ri');
      expect(trap!.code, label).toBe(excCode.ri);
      expect(trap!.stage, label).toBe('decode');
      expect(trap!.victimPc, label).toBe(textBase);
      expect(trap!.handlerPc, label).toBe(handlerPc);
      expect(trace.results.some((result) => result.status === 'out-of-domain'), label)
        .toBe(false);
    }
  });

  it('executes the same word normally once its layer is enabled', () => {
    // The classification is a statement about the enabled instruction set, not
    // about the encoding: `subu` is a perfectly ordinary word in the MARS layer.
    const program = [
      op('ori', { rs: 0, rt: 1, immediate: 9 }),
      op('ori', { rs: 0, rt: 2, immediate: 4 }),
      rawWords.subu, // $3 = 9 - 4
      ...haltSequence
    ];
    const trace = runToCompletion(makeSession('P6', program, { layers: marsLayers }));

    expect(trace.last.status).toBe('halted');
    expect(gprWrites(trace)).toEqual([[1, 9], [2, 4], [3, 5]]);
  });
});

describe('COP0 secondary-selector classification on P7', () => {
  it('stops the run instead of raising RI when only the rs selector is unknown', () => {
    // The course defines exactly two COP0 selectors, and both share the opcode of
    // the rejected word, so the word cannot be RI by opcode recognition.
    expect(rawWords.cop0Selector >>> 26, 'COP0 opcode').toBe(0b010000);
    expect((rawWords.cop0Selector >>> 21) & 0x1f, 'rejected rs selector').toBe(7);
    expect(op('mfc0', { rt: 1, rd: 12 }) >>> 26, 'mfc0 opcode').toBe(0b010000);
    expect((op('mfc0', { rt: 1, rd: 12 }) >>> 21) & 0x1f, 'mfc0 rs').toBe(0);
    expect((op('mtc0', { rt: 1, rd: 12 }) >>> 21) & 0x1f, 'mtc0 rs').toBe(4);

    const entry = unrecognizedCases.find((item) => item.profile === 'P7')!;
    const run = runCase(entry);
    expectOutOfDomain(entry, run);
    expect(trapEvents(run.trace)).toEqual([]);
    expect(run.session.snapshot().cp0).toEqual({ status: 0, cause: 0, epc: 0 });

    // The opcode really is live on P7: only the selector was out of the domain.
    const legal = runToCompletion(makeSession('P7', [
      op('mfc0', { rt: 1, rd: 12 }),
      ...haltSequence
    ]));
    expect(legal.last.status).toBe('halted');
    expect(trapEvents(legal)).toEqual([]);
  });
});

describe('undefined-domain arithmetic and control inputs', () => {
  it('stops div by a zero register without defining HI or LO', () => {
    const run = runCase(divideByZeroCase);
    expectOutOfDomain(divideByZeroCase, run);

    const state = run.session.snapshot();
    // Fail closed means fail closed: no quotient, no remainder, no "0/0 = 0".
    expect(state.hiDefined).toBe(false);
    expect(state.loDefined).toBe(false);
    expect(committedEvents(run.trace).flatMap((event) => event.hiLoWrites)).toEqual([]);
  });

  it('stops jalr when its link and target register are the same', () => {
    const run = runCase(jalrSameRegisterCase);
    expectOutOfDomain(jalrSameRegisterCase, run);
    // Neither the link write nor the jump happened.
    expect(gprWrites(run.trace)).toEqual([]);
    expect(run.session.snapshot().gpr[1]).toBe(0);
  });

  it('stops a second control transfer inside a delay slot', () => {
    const run = runCase(doubleDelaySlotCase);
    expectOutOfDomain(doubleDelaySlotCase, run);

    // The jal committed its PC+8 link and armed the delay slot; the branch in the
    // slot was rejected before it could resolve a second target.
    const jal = committedEvents(run.trace)[0];
    expect(jal.mnemonic).toBe('jal');
    expect(jal.controlTarget).toBe(0x0000_3010);
    expect(gprWrites(run.trace)).toEqual([[31, textBase + 0x8]]);
    expect(run.session.snapshot().pendingBranch)
      .toEqual({ targetPc: 0x0000_3010, originPc: textBase });
  });

  it('stops mfhi while HI is still architecturally undefined', () => {
    const run = runCase(undefinedHiLoCase);
    expectOutOfDomain(undefinedHiLoCase, run);
    // The reset contract leaves HI/LO undefined, so no value may be handed out.
    expect(run.session.snapshot().hiDefined).toBe(false);
    expect(gprWrites(run.trace)).toEqual([]);
  });

  it('reads HI normally once a mult has defined it', () => {
    // The stop above is about definedness, not about mfhi being unsupported.
    const program = [
      op('mult', { rs: 0, rt: 0 }), // HI = LO = 0, now defined
      rawWords.mfhi,
      ...haltSequence
    ];
    const session = makeSession('P6', program);
    const trace = runToCompletion(session);

    expect(trace.last.status).toBe('halted');
    expect(gprWrites(trace)).toEqual([[1, 0]]);
    expect(session.snapshot().hiDefined).toBe(true);
  });
});

describe('P5/P6 memory-domain classification', () => {
  it('stops misaligned and out-of-region data accesses with the naming address', () => {
    expect(memoryDomainCases.map((entry) => entry.reason))
      .toEqual(['misaligned-access', 'address-out-of-region', 'address-out-of-region']);

    for (const entry of memoryDomainCases) {
      const run = runCase(entry);
      const diagnostic = expectOutOfDomain(entry, run);

      expect(diagnostic.address, entry.label).toBe(entry.address);
      expect(trapEvents(run.trace), entry.label).toEqual([]);
      // Nothing was loaded and nothing was stored.
      expect(gprWrites(run.trace), entry.label).toEqual([]);
      expect(memoryWrites(run.trace), entry.label).toEqual([]);
      expect(run.session.snapshot('full').dataWords, entry.label).toEqual([]);
    }
  });

  it('raises AdEL and AdES on P7 for the same two words', () => {
    // COURSE-P7-EXC-012/013: the split is the whole point — P3-P6 have no
    // architectural exceptions, P7 has no out-of-domain classification here.
    const counterparts = [
      { label: 'misaligned lw', word: rawWords.misalignedLoad, name: 'adel', code: excCode.adel },
      { label: 'sw into IM', word: rawWords.storeIntoIm, name: 'ades', code: excCode.ades }
    ] as const;

    for (const counterpart of counterparts) {
      const session = makeSession('P7', [counterpart.word], { kernelWords: haltSequence });
      const trace = runToCompletion(session);
      const trap = trapEvents(trace)[0]?.trap;
      const label = counterpart.label;

      expect(trap, label).toBeDefined();
      expect(trap!.name, label).toBe(counterpart.name);
      expect(trap!.code, label).toBe(counterpart.code);
      expect(trap!.stage, label).toBe('memory');
      expect(trap!.victimPc, label).toBe(textBase);
      expect(trace.results.some((result) => result.status === 'out-of-domain'), label)
        .toBe(false);
    }
  });
});

describe('course-external trap instructions', () => {
  it('stops a taken trap because the course defines no Tr exception code', () => {
    expect(trapCases.map((entry) => entry.profile)).toEqual(['P6', 'P7']);

    for (const entry of trapCases) {
      const run = runCase(entry);
      expectOutOfDomain(entry, run);
      // Not an exception even on P7: `courseExceptionCodes` has no Tr entry.
      expect(trapEvents(run.trace), entry.label).toEqual([]);
      expect(gprWrites(run.trace), entry.label).toEqual([[1, 5], [2, 5]]);
    }
  });

  it('commits a not-taken trap as an ordinary no-op', () => {
    for (const profile of ['P6', 'P7'] as const) {
      const program = [...equalOperands, rawWords.tne, ...haltSequence];
      const session = makeSession(profile, program, { layers: marsLayers });
      const trace = runToCompletion(session);
      const trap = committedEvents(trace).find((event) => event.mnemonic === 'tne');

      expect(trace.last.status, profile).toBe('halted');
      expect(trap, profile).toBeDefined();
      // `tne $1, $2` with `$1 == $2` never traps, so it is a plain no-op: it falls
      // through, writes nothing, and is not even a control transfer.
      expect(trap!.pcBefore, profile).toBe(textBase + 0x8);
      expect(trap!.pcAfter, profile).toBe(textBase + 0xc);
      expect(trap!.gprWrites, profile).toEqual([]);
      expect(trap!.hiLoWrites, profile).toEqual([]);
      expect(trap!.cp0Writes, profile).toEqual([]);
      expect(trap!.memoryWrites, profile).toEqual([]);
      expect(trap!.branchTaken, profile).toBeUndefined();
      expect(trap!.controlTarget, profile).toBeUndefined();
      expect(gprWrites(trace), profile).toEqual([[1, 5], [2, 5]]);
    }
  });
});

describe('Timer transactions without a declared cycle schedule', () => {
  it('stops a Timer access with device-schedule-missing instead of an address error', () => {
    expect(timerScheduleCases.map((entry) => entry.address))
      .toEqual([0x0000_7f00, 0x0000_7f10, 0x0000_7f08]);

    for (const entry of timerScheduleCases) {
      // The fixture deliberately passes no `deviceSchedule`, i.e. the default
      // `{kind: 'disabled'}` architectural anchor.
      expect(entry.options?.deviceSchedule, entry.label).toBeUndefined();

      const run = runCase(entry);
      const diagnostic = expectOutOfDomain(entry, run);

      expect(diagnostic.address, entry.label).toBe(entry.address);
      expect(diagnostic.contractId, entry.label).toBe(timerModeContract);
      // COURSE-P7-TIMER-MODE-001: report the undefined input, never guess — and
      // never dress it up as the AdEL/AdES a scheduled run could legitimately give.
      expect(trapEvents(run.trace), entry.label).toEqual([]);
      expect(run.session.snapshot().cp0, entry.label)
        .toEqual({ status: 0, cause: 0, epc: 0 });
      expect(gprWrites(run.trace), entry.label).toEqual([]);
      expect(memoryWrites(run.trace), entry.label).toEqual([]);
    }
  });

  it('still acknowledges the interrupt generator while the timers are disabled', () => {
    // The generator has no clock domain of its own (P7-2-6: no storage, reads are
    // zero, any store acknowledges), so disabling the Timer schedule must not take
    // 0x7f20 out of the comparable domain. The official acknowledge is a byte store.
    const program = [
      op('sb', { rs: 0, rt: 0, immediate: 0x7f20 }),
      ...haltSequence
    ];
    const session = makeSession('P7', program, {
      externalInterrupts: [{ victimPc: textBase, occurrence: 1 }]
    });
    const acknowledge = session.stepInstruction();

    expect(acknowledge.status).toBe('committed');
    expect(acknowledge.diagnostic).toBeUndefined();
    expect(acknowledge.event!.mnemonic).toBe('sb');
    expect(acknowledge.event!.deviceEvents).toEqual([
      {
        kind: 'external-interrupt-asserted',
        device: 'interrupt-generator',
        address: textBase,
        value: 1
      },
      {
        kind: 'interrupt-generator-ack',
        device: 'interrupt-generator',
        address: 0x0000_7f20,
        value: 1 // a request really was pending, so the ack really cleared one
      }
    ]);
    expect(session.devices!.snapshot().externalInterrupt).toBe(false);

    const trace = runToCompletion(session);
    expect(trace.last.status).toBe('halted');
  });
});

describe('execution diagnostic code contract', () => {
  it('derives every code from its reason under the mips-core.exec prefix', () => {
    expect(executionDiagnosticPrefix).toBe('mips-core.exec');
    // Guard against a silently emptied table making the loops below vacuous.
    expect(allCases).toHaveLength(24);

    for (const entry of allCases) {
      const diagnostic = expectOutOfDomain(entry, runCase(entry));
      expect(diagnostic.code.startsWith('mips-core.exec.'), entry.label).toBe(true);
      expect(diagnostic.code, entry.label).toBe(`mips-core.exec.${diagnostic.reason}`);
      expect(diagnostic.message.length > 0, entry.label).toBe(true);
      // A cited contract id must be one of the three this file pins.
      if (diagnostic.contractId !== undefined) {
        expect([domainContract, unloadedContract, timerModeContract], entry.label)
          .toContain(diagnostic.contractId);
      }
    }
  });

  it('fails closed on every case without committing a partial effect', () => {
    for (const entry of allCases) {
      const run = runCase(entry);
      expectOutOfDomain(entry, run);
      const label = entry.label;

      // No architectural exception or interrupt was invented anywhere in the run.
      expect(trapEvents(run.trace), label).toEqual([]);
      // Only the instructions ahead of the stop wrote anything at all.
      expect(gprWrites(run.trace), label).toEqual(entry.gprWrites);
      expect(memoryWrites(run.trace), label).toEqual([]);
      expect(run.session.snapshot('full').dataWords, label).toEqual([]);
      if (entry.profile === 'P7') {
        expect(run.session.snapshot().cp0, label).toEqual({ status: 0, cause: 0, epc: 0 });
      }
      // The offending instruction is the last thing the machine looked at.
      expect(run.session.snapshot().pc, label).toBe(entry.pc);
    }
  });

  it('covers every out-of-domain reason the CPU step can raise', () => {
    // `timer-mode-undefined` is raised inside the Timer device rather than by an
    // instruction step; it is pinned by `timerDevice.test.ts`.
    const expected: readonly OutOfDomainReason[] = [
      'address-out-of-region',
      'device-schedule-missing',
      'divide-by-zero',
      'double-delay-slot',
      'jalr-same-register',
      'misaligned-access',
      'undefined-hi-lo-read',
      'unloaded-instruction',
      'unrecognized-instruction',
      'unsupported-instruction'
    ];
    const covered = [...new Set(allCases.map((entry) => entry.reason))].sort();
    expect(covered).toEqual([...expected].sort());
  });
});
