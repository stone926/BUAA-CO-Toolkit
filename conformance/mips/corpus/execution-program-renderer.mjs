/**
 * Independent deterministic renderer for the phase-6 execution corpus.
 *
 * Unlike the assembly seeds, these programs contain no indirect/absolute
 * jumps, exceptions, syscalls, CP0 or devices. Every control transfer is a
 * bounded forward branch followed by one final self-branch halt, so every case
 * is safe to execute under both the fixed legacy executor and the TS core.
 */
import * as crypto from 'node:crypto';

export const executionRendererRevision = 1;
export const executionProfiles = Object.freeze(['P3', 'P4', 'P5', 'P6', 'P7']);
export const executionCasesPerProfile = 50;

const profileSet = new Set(executionProfiles);
const rFunct = Object.freeze({ add: 0x20, sub: 0x22, mult: 0x18, mflo: 0x12 });
const iOpcode = Object.freeze({ ori: 0x0d, lw: 0x23, sw: 0x2b, lb: 0x20, sb: 0x28, beq: 0x04 });

function invariant(condition, message) {
  if (!condition) throw new Error(`execution renderer: ${message}`);
}

function hexWord(value) {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

function rWord(rs, rt, rd, funct) {
  return hexWord(((rs & 31) << 21) | ((rt & 31) << 16) | ((rd & 31) << 11) | (funct & 63));
}

function iWord(opcode, rs, rt, immediate) {
  return hexWord(((opcode & 63) << 26) | ((rs & 31) << 21) | ((rt & 31) << 16) | (immediate & 0xffff));
}

function xorshift(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function sourceSha256(source) {
  return crypto.createHash('sha256').update(source, 'utf8').digest('hex');
}

function instruction(asm, word, labels = []) {
  return { asm, word, labels };
}

export function renderExecutionProgram(seedCase) {
  invariant(seedCase && typeof seedCase === 'object', 'seed case must be an object');
  invariant(profileSet.has(seedCase.profile), `unsupported profile ${seedCase.profile}`);
  invariant(/^EXEC-P[3-7]-\d{4}$/.test(seedCase.id), `invalid case id ${seedCase.id}`);
  invariant(/^0x[0-9a-f]{8}$/.test(seedCase.seedHashU32), `${seedCase.id} seedHashU32 is invalid`);

  const next = xorshift(Number.parseInt(seedCase.seedHashU32.slice(2), 16));
  const first = 1 + (next() % 95);
  const second = 101 + (next() % 95);
  const slotValue = 1 + (next() % 0x7f);
  const afterValue = 1 + (next() % 0xff);
  const wordOffset = (next() % 64) * 4;
  const byteOffset = 0x200 + (next() % 128);
  const byteValue = 1 + (next() % 0x7f);
  const multiplier = 2 + (next() % 7);
  const labelPrefix = seedCase.id.toLowerCase().replaceAll('-', '_');
  const takenLabel = `${labelPrefix}_taken`;
  const falseTargetLabel = `${labelPrefix}_false_target`;
  const haltLabel = `${labelPrefix}_halt`;

  const words = [
    instruction(`ori $1, $0, ${first}`, iWord(iOpcode.ori, 0, 1, first)),
    instruction(`ori $2, $0, ${second}`, iWord(iOpcode.ori, 0, 2, second)),
    instruction('add $3, $1, $2', rWord(1, 2, 3, rFunct.add)),
    instruction(`sw $3, ${wordOffset}($0)`, iWord(iOpcode.sw, 0, 3, wordOffset)),
    instruction(`lw $4, ${wordOffset}($0)`, iWord(iOpcode.lw, 0, 4, wordOffset)),
    // Target index 8: immediate = 8 - (5 + 1) = 2.
    instruction(`beq $4, $3, ${takenLabel}`, iWord(iOpcode.beq, 4, 3, 2)),
    instruction(`ori $5, $0, ${slotValue}`, iWord(iOpcode.ori, 0, 5, slotValue)),
    instruction('ori $6, $0, 0x7fff', iWord(iOpcode.ori, 0, 6, 0x7fff)),
    instruction('sub $7, $4, $1', rWord(4, 1, 7, rFunct.sub), [takenLabel]),
    // This branch is deterministically not taken; its forward target remains bounded.
    instruction(`beq $1, $2, ${falseTargetLabel}`, iWord(iOpcode.beq, 1, 2, 2)),
    instruction(`ori $8, $0, ${afterValue}`, iWord(iOpcode.ori, 0, 8, afterValue)),
    instruction('ori $9, $0, 0x55aa', iWord(iOpcode.ori, 0, 9, 0x55aa))
  ];

  if (seedCase.profile === 'P6' || seedCase.profile === 'P7') {
    words.push(
      instruction(`ori $10, $0, ${byteValue}`, iWord(iOpcode.ori, 0, 10, byteValue), [falseTargetLabel]),
      instruction(`sb $10, ${byteOffset}($0)`, iWord(iOpcode.sb, 0, 10, byteOffset)),
      instruction(`lb $11, ${byteOffset}($0)`, iWord(iOpcode.lb, 0, 11, byteOffset)),
      instruction(`ori $12, $0, ${multiplier}`, iWord(iOpcode.ori, 0, 12, multiplier)),
      instruction('mult $1, $12', rWord(1, 12, 0, rFunct.mult)),
      instruction('mflo $13', rWord(0, 0, 13, rFunct.mflo))
    );
  } else {
    // Keep the false branch target valid without introducing profile-specific opcodes.
    words.push(instruction('nop', '0x00000000', [falseTargetLabel]));
  }

  const haltIndex = words.length;
  words.push(
    instruction(`beq $0, $0, ${haltLabel}`, '0x1000ffff', [haltLabel]),
    instruction('nop', '0x00000000')
  );

  const sourceLines = [
    `# ${seedCase.id}; phase-6 execution renderer v${executionRendererRevision}; seed=${seedCase.seed}`,
    '.text 0x00003000'
  ];
  for (const item of words) {
    for (const label of item.labels) sourceLines.push(`${label}:`);
    sourceLines.push(`    ${item.asm}`);
  }
  const source = `${sourceLines.join('\n')}\n`;
  const imageText = `${words.map((item) => item.word.slice(2)).join('\n')}\n`;
  const haltPc = 0x3000 + haltIndex * 4;

  invariant(words.length <= 64, `${seedCase.id} unexpectedly exceeds the bounded image budget`);
  invariant(!/\b(?:j|jal|jr|jalr|syscall|break|eret|mfc0|mtc0)\b/i.test(source), `${seedCase.id} contains a forbidden execution-corpus operation`);
  return Object.freeze({
    caseId: seedCase.id,
    profile: seedCase.profile,
    rendererRevision: executionRendererRevision,
    source,
    sourceSha256: sourceSha256(source),
    imageText,
    imageSha256: sourceSha256(imageText),
    words: Object.freeze(words.map((item) => item.word)),
    haltPc: hexWord(haltPc),
    haltWord: '0x1000ffff',
    maxSteps: 128,
    features: Object.freeze(['control-flow', 'memory', 'delay-slot-contract']),
    expectedDifferenceContractId: null
  });
}
