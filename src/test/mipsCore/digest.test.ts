import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import { sha256Bytes, sha256Text, utf8Bytes } from '../../mips/core/digest';
import { canonicalSnapshotText } from '../../mips/core/machine/session';
import type { MachineSnapshot } from '../../mips/core/machine/session';
import { buildProgramImage, programImageContentFingerprint, sourceUnitFingerprint } from '../../mips/core/programImage';
import { programImageFingerprint } from '../../mips/replay/programImage';
import { haltSequence, makeMachine, makeSession, op, runToCompletion, textImage } from './programFixtures';

/**
 * Pins `src/mips/core/digest.ts` and the canonical snapshot digest in
 * `src/mips/core/machine/session.ts`.
 *
 * The module boundary (`scripts/check-module-boundaries.mjs`) forbids `node:crypto`
 * inside `src/mips/core`, so the core carries its own SHA-256. That makes an
 * independent oracle mandatory: every hash below is cross-checked against Node's
 * `crypto.createHash('sha256')`, and the two published FIPS 180-4 one-block /
 * two-block example digests are additionally pinned as literals so the suite still
 * detects a fault if Node itself were swapped out.
 *
 * Expected values come from:
 *  - FIPS PUB 180-4 / the NIST "SHA-256 Examples" document (literal digests below).
 *  - The course reset contract for the canonical snapshot text: all GPR = 0,
 *    DM = 0, CP0 = 0, initial PC 0x3000, HI/LO architecturally undefined
 *    (see `courseProfiles.test.ts` "freezes the course address space").
 *  - `session.ts` 计划第 5.4 节: only defined and observable fields participate in
 *    the digest, so an undefined HI/LO can never separate two otherwise equal runs.
 *  - `programImage.ts`: the canonical payload is owned by core, and replay reuses
 *    it, so both layers must fingerprint one image identically.
 */

/** Node's own SHA-256, used as the independent oracle for the pure-TS core hash. */
function nodeSha256(input: Uint8Array | string): string {
  return crypto.createHash('sha256').update(input as Buffer).digest('hex');
}

/** Deterministic filler; a fixed affine pattern, never `Math.random`. */
function patternedBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = (index * 37 + 11) & 0xff;
  }
  return bytes;
}

const emptyText = '';
const abcText = 'abc';
/** 55 bytes: the largest message that still pads into a single 64-byte block. */
const fiftyFiveByteText = `${'0123456789abcdef'.repeat(3)}0123456`;
/** 56 bytes: the FIPS 180-4 two-block example; padding no longer fits in block one. */
const fiftySixByteText = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
/** 64 bytes: exactly one full block, so padding occupies a whole second block. */
const sixtyFourByteText = '0123456789abcdef'.repeat(4);
/** 1000 bytes: many blocks, exercising the message-schedule carry across blocks. */
const thousandByteText = '0123456789'.repeat(100);
/** Chinese (3-byte) + emoji (4-byte, encoded as UTF-16 surrogate pairs) + ASCII. */
const multiByteText = 'P7 中断：溢出 Ov=12，延迟槽 🚀 计算机组成原理 🎯 结束';

const textVectors: ReadonlyArray<readonly [string, string]> = [
  ['empty', emptyText],
  ['abc', abcText],
  ['55-byte', fiftyFiveByteText],
  ['56-byte', fiftySixByteText],
  ['64-byte', sixtyFourByteText],
  ['1000-byte', thousandByteText],
  ['multi-byte utf-8', multiByteText]
];

/** Hard-coded byte vectors; the hex literal *is* the fixed input. */
const byteVectors: ReadonlyArray<readonly [string, string]> = [
  ['zero bytes', ''],
  ['single 0x00', '00'],
  ['single 0xff', 'ff'],
  ['eight zero bytes', '0000000000000000'],
  ['halt sequence little-endian', 'ffff0010' + '00000000'],
  ['16 fixed bytes', 'deadbeefcafebabe0123456789abcdef'],
  [
    '55 fixed bytes',
    '3f8a1d4e77b0c25916ae04d3fc6b28715d9e3a0c4b8677f21e05d9ca3b46'
    + '10827fd3e6b915c4a0d78e2f3b6c1904'
  ],
  [
    '56 fixed bytes',
    'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00'
    + '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
  ],
  [
    '64 fixed bytes',
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
    + '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f'
  ],
  [
    '65 fixed bytes',
    '7c1f9b3e5d02a648fe91b70c3a5d8e26491cb0f7d3a25e8619fc47b0d2e53a89'
    + 'b60d1f4c7e29a35081df6b2c94e07a15382bc6d9f0e41a7b53c8d2069fae1b34'
    + '5a'
  ]
];

function bytesOfHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

describe('pure-typescript sha-256 against node crypto', () => {
  it('reproduces the node digest for every pinned text vector', () => {
    for (const [label, text] of textVectors) {
      expect(sha256Text(text), label).toBe(nodeSha256(Buffer.from(text, 'utf8')));
    }
  });

  it('holds the declared byte lengths of the block-boundary text vectors', () => {
    // The 55/56/64 cases only mean anything if they really straddle the padding
    // boundary defined by FIPS 180-4 §5.1.1 (message + 0x80 + 8-byte length).
    expect(Buffer.byteLength(emptyText, 'utf8'), 'empty').toBe(0);
    expect(Buffer.byteLength(abcText, 'utf8'), 'abc').toBe(3);
    expect(Buffer.byteLength(fiftyFiveByteText, 'utf8'), '55-byte').toBe(55);
    expect(Buffer.byteLength(fiftySixByteText, 'utf8'), '56-byte').toBe(56);
    expect(Buffer.byteLength(sixtyFourByteText, 'utf8'), '64-byte').toBe(64);
    expect(Buffer.byteLength(thousandByteText, 'utf8'), '1000-byte').toBe(1000);
    // The multi-byte vector must actually contain non-BMP code points, otherwise
    // it would not exercise the surrogate-pair path of `utf8Bytes`.
    expect(Buffer.byteLength(multiByteText, 'utf8')).toBeGreaterThan(multiByteText.length);
    expect([...multiByteText].some((glyph) => glyph.codePointAt(0)! > 0xffff)).toBe(true);
  });

  it('reproduces the node digest for every fixed byte vector', () => {
    for (const [label, hex] of byteVectors) {
      const bytes = bytesOfHex(hex);
      expect(bytes.length, `${label} hex length`).toBe(hex.length / 2);
      expect(sha256Bytes(bytes), label).toBe(nodeSha256(bytes));
    }
  });

  it('reproduces the node digest across every padding length from 0 to 136 bytes', () => {
    // Sweeps both padding branches for three whole blocks: lengths 55/56 and
    // 119/120 are where the 0x80 + 64-bit length field stops fitting in the
    // current block, and 64/128 are the exact multiples.
    for (let length = 0; length <= 136; length++) {
      const bytes = patternedBytes(length);
      expect(sha256Bytes(bytes), `length ${length}`).toBe(nodeSha256(bytes));
    }
  });

  it('returns a lowercase 64-digit hex digest', () => {
    for (const [label, text] of textVectors) {
      expect(sha256Text(text), label).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('derives the text digest from the utf-8 bytes of the same text', () => {
    for (const [label, text] of textVectors) {
      expect(sha256Text(text), label).toBe(sha256Bytes(utf8Bytes(text)));
    }
  });
});

describe('fips 180-4 published sha-256 vectors', () => {
  it('matches the published one-block, two-block and empty-message digests', () => {
    // FIPS PUB 180-4 / NIST "SHA-256 Examples":
    //   "abc"                              (one-block message)
    //   "abcdbcde...nopq" (56 bytes)       (two-block message)
    //   ""                                 (empty message, NIST CAVP SHA256ShortMsg)
    expect(sha256Text('abc'))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(sha256Text(''))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Bytes(new Uint8Array(0)))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('core utf-8 encoder against node buffer', () => {
  it('encodes every pinned text exactly like Buffer.from(text, "utf8")', () => {
    for (const [label, text] of textVectors) {
      expect([...utf8Bytes(text)], label).toEqual([...Buffer.from(text, 'utf8')]);
    }
  });

  it('encodes each code-point width class with the canonical byte count', () => {
    // UTF-8 (RFC 3629): U+0000..7F -> 1 byte, U+0080..07FF -> 2, U+0800..FFFF -> 3,
    // U+10000..10FFFF -> 4 (one UTF-16 surrogate pair on the JavaScript side).
    expect([...utf8Bytes('A')]).toEqual([0x41]);
    expect([...utf8Bytes('é')]).toEqual([0xc3, 0xa9]);
    expect([...utf8Bytes('中')]).toEqual([0xe4, 0xb8, 0xad]);
    expect([...utf8Bytes('\u{1f680}')]).toEqual([0xf0, 0x9f, 0x9a, 0x80]);
    expect('\u{1f680}'.length, 'surrogate pair occupies two UTF-16 units').toBe(2);
    for (const text of ['A', 'é', '中', '\u{1f680}']) {
      expect([...utf8Bytes(text)], text).toEqual([...Buffer.from(text, 'utf8')]);
    }
  });

  it('substitutes U+FFFD for an unpaired surrogate exactly like node does', () => {
    // A lone surrogate has no UTF-8 encoding. `TextEncoder` and
    // `Buffer.from(text, 'utf8')` both emit U+FFFD (EF BF BD); the core encoder
    // must agree, or a core-side content hash could disagree with a host-side one
    // for the same JavaScript string.
    const replacement = [0xef, 0xbf, 0xbd];
    const cases: Array<[string, string]> = [
      ['lone high surrogate', '\ud83d'],
      ['lone low surrogate', '\udc00'],
      ['high surrogate before ascii', '\ud83dA'],
      ['reversed pair', '\udc00\ud83d'],
      ['lone surrogate inside text', 'a\ud800b']
    ];
    for (const [label, text] of cases) {
      expect([...utf8Bytes(text)], label).toEqual([...Buffer.from(text, 'utf8')]);
      expect(sha256Text(text), label).toBe(nodeSha256(Buffer.from(text, 'utf8')));
    }
    expect([...utf8Bytes('\ud83d')]).toEqual(replacement);
  });

  it('returns a Uint8Array whose length is the utf-8 byte length', () => {
    for (const [label, text] of textVectors) {
      const bytes = utf8Bytes(text);
      expect(bytes, label).toBeInstanceOf(Uint8Array);
      expect(bytes.length, label).toBe(Buffer.byteLength(text, 'utf8'));
    }
  });
});

/** Snapshot without its digest, i.e. exactly what `canonicalSnapshotText` consumes. */
function snapshotBody(snapshot: MachineSnapshot): Omit<MachineSnapshot, 'digest'> {
  const { digest, ...body } = snapshot;
  return body;
}

describe('canonical machine snapshot digest', () => {
  const storeProgram = [
    op('ori', { rs: 0, rt: 1, immediate: 5 }),
    op('ori', { rs: 0, rt: 2, immediate: 3 }),
    op('add', { rd: 3, rs: 1, rt: 2 }),
    op('sw', { rs: 0, rt: 3, immediate: 0 }),
    ...haltSequence
  ];

  it('renders the reset state exactly as the course contract describes it', () => {
    // Reset contract: every GPR is 0, PC is 0x3000, HI/LO are architecturally
    // undefined, and P4 has no CP0 and no pending delay slot.
    const machine = makeMachine('P4', [op('nop'), ...haltSequence]);
    const expected = [
      'profile=P4',
      'pc=00003000',
      ...Array.from({ length: 31 }, (_unused, index) => `r${index + 1}=00000000`),
      'hi=undefined',
      'lo=undefined'
    ].join('\n');
    const snapshot = machine.snapshot();
    expect(canonicalSnapshotText(snapshotBody(snapshot))).toBe(expected);
    expect(snapshot.digest).toBe(sha256Text(expected));
    expect(snapshot.digest).toBe(nodeSha256(Buffer.from(expected, 'utf8')));
    // `$0` is hard-wired to zero and therefore contributes no line of its own.
    expect(canonicalSnapshotText(snapshotBody(snapshot))).not.toContain('r0=');
  });

  it('renders the reset CP0 registers for the exception-capable profile', () => {
    // P7 owns SR(12)/Cause(13)/EPC(14); reset drives all three to zero.
    const machine = makeMachine('P7', [op('nop'), ...haltSequence]);
    const text = canonicalSnapshotText(snapshotBody(machine.snapshot()));
    expect(text.split('\n').slice(-3)).toEqual(['sr=00000000', 'cause=00000000', 'epc=00000000']);
    expect(machine.snapshot().digest).toBe(sha256Text(text));
  });

  it('derives every published digest from its own canonical text', () => {
    for (const profile of ['P3', 'P4', 'P5', 'P6', 'P7'] as const) {
      const session = makeSession(profile, storeProgram);
      runToCompletion(session);
      for (const level of ['registers', 'full'] as const) {
        const snapshot = session.snapshot(level);
        expect(snapshot.digest, `${profile}/${level}`)
          .toBe(sha256Text(canonicalSnapshotText(snapshotBody(snapshot))));
        expect(snapshot.digest, `${profile}/${level} vs node`)
          .toBe(nodeSha256(Buffer.from(canonicalSnapshotText(snapshotBody(snapshot)), 'utf8')));
      }
    }
  });

  it('gives two independent runs of the same program the same digest', () => {
    for (const profile of ['P4', 'P6'] as const) {
      const first = makeSession(profile, storeProgram);
      const second = makeSession(profile, storeProgram);
      expect(runToCompletion(first).last.status, profile).toBe('halted');
      expect(runToCompletion(second).last.status, profile).toBe('halted');
      expect(first.snapshot().digest, `${profile}/registers`).toBe(second.snapshot().digest);
      expect(first.snapshot('full').digest, `${profile}/full`).toBe(second.snapshot('full').digest);
    }
  });

  it('separates the register level from the full level of the same state', () => {
    // `full` adds the sparse DM words, so the digest must not collide with the
    // register-only digest of a run that actually wrote memory.
    const session = makeSession('P4', storeProgram);
    runToCompletion(session);
    const registers = session.snapshot('registers');
    const full = session.snapshot('full');
    expect(full.dataWords).toEqual([{ address: 0x0000_0000, value: 8 }]);
    expect(canonicalSnapshotText(snapshotBody(full)).split('\n').at(-1)).toBe('m00000000=00000008');
    expect(full.digest).not.toBe(registers.digest);
  });

  it('changes the digest when exactly one register value changes', () => {
    // 5 and 6 differ in one bit of one register; nothing else about the two runs
    // differs, so the digest must separate them.
    const withFive = makeSession('P4', [op('ori', { rs: 0, rt: 1, immediate: 5 }), ...haltSequence]);
    const withSix = makeSession('P4', [op('ori', { rs: 0, rt: 1, immediate: 6 }), ...haltSequence]);
    runToCompletion(withFive);
    runToCompletion(withSix);
    const five = withFive.snapshot();
    const six = withSix.snapshot();
    expect(five.gpr[1]).toBe(5);
    expect(six.gpr[1]).toBe(6);
    expect(five.pc).toBe(six.pc);
    expect(five.digest).not.toBe(six.digest);
  });

  it('changes the digest for every single register the snapshot claims to cover', () => {
    const base = makeMachine('P4', [op('nop'), ...haltSequence]).snapshot();
    const baseline = canonicalSnapshotText(snapshotBody(base));
    for (let register = 1; register < 32; register++) {
      const gpr = [...base.gpr];
      gpr[register] = 0xa5a5_5a5a;
      const mutated = canonicalSnapshotText({ ...snapshotBody(base), gpr });
      expect(mutated, `r${register}`).not.toBe(baseline);
      expect(sha256Text(mutated), `r${register}`).not.toBe(base.digest);
    }
    // `$0` is architecturally zero, so mutating it must not move the digest.
    const zeroMutated = [...base.gpr];
    zeroMutated[0] = 0xffff_ffff;
    expect(canonicalSnapshotText({ ...snapshotBody(base), gpr: zeroMutated })).toBe(baseline);
  });

  it('renders an undefined hi/lo as undefined instead of its residual bits', () => {
    const base = makeMachine('P4', [op('nop'), ...haltSequence]).snapshot();
    expect(base.hiDefined).toBe(false);
    expect(base.loDefined).toBe(false);
    const residual = { ...snapshotBody(base), hi: 0xdead_beef, lo: 0x1234_5678 };
    const text = canonicalSnapshotText(residual);
    expect(text).toContain('\nhi=undefined\n');
    expect(text.endsWith('\nlo=undefined')).toBe(true);
    expect(text).not.toContain('deadbeef');
    expect(text).not.toContain('12345678');
    // Same observable state, different residual bits: one digest, not two.
    expect(text).toBe(canonicalSnapshotText(snapshotBody(base)));
    expect(sha256Text(text)).toBe(base.digest);
  });

  it('renders a defined hi/lo as its hexadecimal value', () => {
    const base = makeMachine('P6', [op('nop'), ...haltSequence]).snapshot();
    const defined = {
      ...snapshotBody(base),
      hi: 0xdead_beef,
      lo: 0x1234_5678,
      hiDefined: true,
      loDefined: true
    };
    const text = canonicalSnapshotText(defined);
    expect(text).toContain('\nhi=deadbeef\n');
    expect(text.endsWith('\nlo=12345678')).toBe(true);
    expect(sha256Text(text)).not.toBe(base.digest);
  });

  it('keeps two runs equal when they differ only in undefined hi/lo bits', () => {
    // `mthi`/`mtlo` load a profile-visible HI/LO, then MIPS32 `mul` writes only its
    // GPR destination and leaves HI/LO UNPREDICTABLE (transition.ts 'mul'). The two
    // programs therefore end with identical architectural state and different
    // residual HI/LO bits — exactly the case the digest must not distinguish.
    function program(seed: number): number[] {
      return [
        op('lui', { rt: 1, immediate: seed }),
        op('mthi', { rs: 1 }),
        op('mtlo', { rs: 1 }),
        op('mul', { rd: 1, rs: 1, rt: 0 }),
        ...haltSequence
      ];
    }
    const layers = ['required', 'commonExtensions', 'marsCompatibility'] as const;
    const first = makeSession('P6', program(0x1234), { layers: [...layers] });
    const second = makeSession('P6', program(0x5678), { layers: [...layers] });
    expect(runToCompletion(first).last.status, 'first run').toBe('halted');
    expect(runToCompletion(second).last.status, 'second run').toBe('halted');

    const left = first.snapshot('full');
    const right = second.snapshot('full');
    // Guard against a vacuous pass: the residual bits really must differ.
    expect(left.hi).toBe(0x1234_0000);
    expect(right.hi).toBe(0x5678_0000);
    expect(left.lo).not.toBe(right.lo);
    expect(left.hiDefined, 'left hi').toBe(false);
    expect(left.loDefined, 'left lo').toBe(false);
    expect(right.hiDefined, 'right hi').toBe(false);
    expect(right.loDefined, 'right lo').toBe(false);
    // Every observable field agrees, so the canonical text and digest must agree.
    expect(left.gpr).toEqual(right.gpr);
    expect(left.pc).toBe(right.pc);
    expect(canonicalSnapshotText(snapshotBody(left)))
      .toBe(canonicalSnapshotText(snapshotBody(right)));
    expect(left.digest).toBe(right.digest);
  });

  it('separates two profiles that reach the same architectural state', () => {
    // The profile id is part of the canonical text: a P3 digest may never be
    // mistaken for a P4 digest of the same registers.
    const p3 = makeSession('P3', [op('ori', { rs: 0, rt: 1, immediate: 7 }), ...haltSequence]);
    const p4 = makeSession('P4', [op('ori', { rs: 0, rt: 1, immediate: 7 }), ...haltSequence]);
    runToCompletion(p3);
    runToCompletion(p4);
    expect(p3.snapshot().gpr).toEqual(p4.snapshot().gpr);
    expect(p3.snapshot().pc).toBe(p4.snapshot().pc);
    expect(p3.snapshot().digest).not.toBe(p4.snapshot().digest);
  });

  it('records a pending delay slot in the canonical text', () => {
    // P5/P6 have exactly one delay slot; a snapshot taken between the branch and
    // its delay slot is a different machine state and must digest differently.
    const session = makeSession('P6', [
      op('beq', { rs: 0, rt: 0, immediate: 1 }),
      op('nop'),
      op('nop'),
      ...haltSequence
    ]);
    expect(session.stepInstruction().status).toBe('committed');
    const inSlot = session.snapshot();
    expect(inSlot.pendingBranch).toEqual({ originPc: 0x0000_3000, targetPc: 0x0000_3008 });
    expect(canonicalSnapshotText(snapshotBody(inSlot)))
      .toContain('delay=0x00003000->0x00003008');
    expect(session.stepInstruction().status).toBe('committed');
    const afterSlot = session.snapshot();
    expect(afterSlot.pendingBranch).toBeUndefined();
    expect(afterSlot.digest).not.toBe(inSlot.digest);
  });
});

describe('program image fingerprint agreement between core and replay', () => {
  const textOnly = textImage([
    op('ori', { rs: 0, rt: 1, immediate: 5 }),
    op('add', { rd: 2, rs: 1, rt: 1 }),
    ...haltSequence
  ]);
  const multiSegment = textImage([op('nop'), ...haltSequence], {
    dataWords: [0x0000_0001, 0xffff_ffff],
    kernelWords: [op('eret')],
    kernelBase: 0x0000_4180
  });
  const annotated = buildProgramImage({
    entryPc: 0x0000_3000,
    segments: [{ name: 'text', baseAddress: 0x0000_3000, words: [...haltSequence] }],
    symbols: [
      { name: 'main', value: 0x0000_3000, kind: 'label', segment: 'text' },
      { name: 'LIMIT', value: 16, kind: 'eqv' }
    ],
    sourceMap: [
      { segmentIndex: 0, wordIndex: 0, sourceId: 'root', startOffset: 0, endOffset: 12 },
      { segmentIndex: 0, wordIndex: 1, sourceId: 'included' }
    ],
    inputGraph: [
      sourceUnitFingerprint({ id: 'root', uri: 'file:///c%3A/co/main.asm', text: 'main: beq $0, $0, -1\n' }),
      sourceUnitFingerprint({ id: 'included', text: 'nop\n' })
    ]
  });
  const images: ReadonlyArray<readonly [string, ReturnType<typeof textImage>]> = [
    ['text only', textOnly],
    ['text + ktext + data', multiSegment],
    ['symbols + source map', annotated]
  ];

  it('computes the same fingerprint in core and in replay', () => {
    for (const [label, image] of images) {
      expect(programImageContentFingerprint(image), label).toBe(programImageFingerprint(image));
    }
  });

  it('stores that same fingerprint on the built image', () => {
    for (const [label, image] of images) {
      expect(image.fingerprint, label).toBe(programImageContentFingerprint(image));
      expect(image.fingerprint, `${label} shape`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('separates images that differ in a single instruction word', () => {
    const left = textImage([op('ori', { rs: 0, rt: 1, immediate: 5 }), ...haltSequence]);
    const right = textImage([op('ori', { rs: 0, rt: 1, immediate: 6 }), ...haltSequence]);
    expect(left.fingerprint).not.toBe(right.fingerprint);
    expect(programImageFingerprint(left)).not.toBe(programImageFingerprint(right));
    // The two layers must disagree about nothing, including about the difference.
    expect(programImageContentFingerprint(left)).toBe(programImageFingerprint(left));
    expect(programImageContentFingerprint(right)).toBe(programImageFingerprint(right));
  });

  it('hashes a source unit with the same sha-256 node produces', () => {
    for (const text of ['', 'nop\n', 'main: beq $0, $0, -1\n', multiByteText]) {
      const unit = sourceUnitFingerprint({ id: 'unit', text });
      expect(unit.contentHash, JSON.stringify(text))
        .toBe(nodeSha256(Buffer.from(text, 'utf8')));
    }
  });
});
