/**
 * Independent deterministic source/image renderer for the frozen L1 seeds.
 *
 * This deliberately duplicates the small MIPS32 encodings needed by the
 * course. It never reads the production ISA catalog, parser, contracts, or
 * generator. The process-level seed runner compares every rendered word with
 * the production JSONL ISA boundary.
 */
import * as crypto from 'node:crypto';

export const seedRendererRevision = 1;
const profiles = Object.freeze(['P3', 'P4', 'P5', 'P6', 'P7']);
const profileSet = new Set(profiles);
const hexHash = /^0x[0-9a-f]{8}$/;

export const seedMnemonicsByProfile = Object.freeze({
  P3: Object.freeze(['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'nop']),
  P4: Object.freeze(['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'jal', 'jr', 'nop']),
  P5: Object.freeze(['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'jal', 'jr', 'nop']),
  P6: Object.freeze(['add', 'sub', 'and', 'or', 'slt', 'sltu', 'lui', 'addi', 'andi', 'ori', 'lb', 'lh', 'lw', 'sb', 'sh', 'sw', 'mult', 'multu', 'div', 'divu', 'mfhi', 'mflo', 'mthi', 'mtlo', 'beq', 'bne', 'jal', 'jr', 'nop']),
  P7: Object.freeze(['add', 'sub', 'and', 'or', 'slt', 'sltu', 'lui', 'addi', 'andi', 'ori', 'lb', 'lh', 'lw', 'sb', 'sh', 'sw', 'mult', 'multu', 'div', 'divu', 'mfhi', 'mflo', 'mthi', 'mtlo', 'beq', 'bne', 'jal', 'jr', 'mfc0', 'mtc0', 'eret', 'syscall', 'nop'])
});

const rFunct = Object.freeze({ add: 0x20, sub: 0x22, and: 0x24, or: 0x25, slt: 0x2a, sltu: 0x2b });
const iOpcode = Object.freeze({ addi: 0x08, andi: 0x0c, ori: 0x0d, lui: 0x0f, lb: 0x20, lh: 0x21, lw: 0x23, sb: 0x28, sh: 0x29, sw: 0x2b, beq: 0x04, bne: 0x05 });
const specialFunct = Object.freeze({ mult: 0x18, multu: 0x19, div: 0x1a, divu: 0x1b, mfhi: 0x10, mflo: 0x12, mthi: 0x11, mtlo: 0x13, jr: 0x08 });

function invariant(condition, message) {
  if (!condition) throw new Error(`seed renderer: ${message}`);
}

function h32(value) {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function rWord(rs, rt, rd, funct) {
  return h32(((rs & 31) << 21) | ((rt & 31) << 16) | ((rd & 31) << 11) | (funct & 63));
}

function iWord(opcode, rs, rt, immediate) {
  return h32(((opcode & 63) << 26) | ((rs & 31) << 21) | ((rt & 31) << 16) | (immediate & 0xffff));
}

function cp0Word(rs, rt, rd) {
  return h32((0x10 << 26) | ((rs & 31) << 21) | ((rt & 31) << 16) | ((rd & 31) << 11));
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

function chooseRegister(next) {
  return 1 + (next() % 26);
}

function signedImmediate(next) {
  return (next() & 0xffff) - 0x8000;
}

function unsignedImmediate(next) {
  return next() & 0xffff;
}

function memoryOffset(next, alignment) {
  const maximum = 0x3000 - alignment;
  return (next() % (maximum / alignment + 1)) * alignment;
}

function renderInstruction(mnemonic, next) {
  if (mnemonic === 'nop') return { mnemonic, operands: {}, asm: 'nop', word: '0x00000000' };
  if (Object.hasOwn(rFunct, mnemonic)) {
    const operands = { rd: chooseRegister(next), rs: chooseRegister(next), rt: chooseRegister(next) };
    return { mnemonic, operands, asm: `${mnemonic} $${operands.rd}, $${operands.rs}, $${operands.rt}`, word: rWord(operands.rs, operands.rt, operands.rd, rFunct[mnemonic]) };
  }
  if (mnemonic === 'lui') {
    const operands = { rt: chooseRegister(next), immediate: unsignedImmediate(next) };
    return { mnemonic, operands, asm: `lui $${operands.rt}, ${operands.immediate}`, word: iWord(iOpcode.lui, 0, operands.rt, operands.immediate) };
  }
  if (mnemonic === 'addi' || mnemonic === 'andi' || mnemonic === 'ori') {
    const operands = {
      rs: chooseRegister(next),
      rt: chooseRegister(next),
      immediate: mnemonic === 'addi' ? signedImmediate(next) : unsignedImmediate(next)
    };
    return { mnemonic, operands, asm: `${mnemonic} $${operands.rt}, $${operands.rs}, ${operands.immediate}`, word: iWord(iOpcode[mnemonic], operands.rs, operands.rt, operands.immediate) };
  }
  if (['lb', 'lh', 'lw', 'sb', 'sh', 'sw'].includes(mnemonic)) {
    const alignment = mnemonic.endsWith('w') ? 4 : mnemonic.endsWith('h') ? 2 : 1;
    const operands = { rs: 0, rt: chooseRegister(next), immediate: memoryOffset(next, alignment) };
    return { mnemonic, operands, asm: `${mnemonic} $${operands.rt}, ${operands.immediate}($${operands.rs})`, word: iWord(iOpcode[mnemonic], operands.rs, operands.rt, operands.immediate) };
  }
  if (mnemonic === 'beq' || mnemonic === 'bne') {
    const operands = { rs: chooseRegister(next), rt: chooseRegister(next), immediate: 1 };
    return { mnemonic, operands, asm: `${mnemonic} $${operands.rs}, $${operands.rt}, @TARGET@`, word: iWord(iOpcode[mnemonic], operands.rs, operands.rt, operands.immediate) };
  }
  if (mnemonic === 'jal') {
    const operands = { index: 0x00000c00 };
    return { mnemonic, operands, asm: 'jal _fixed_seed_jal_target', word: h32((0x03 << 26) | operands.index) };
  }
  if (mnemonic === 'jr') {
    const operands = { rs: chooseRegister(next) };
    return { mnemonic, operands, asm: `jr $${operands.rs}`, word: rWord(operands.rs, 0, 0, specialFunct.jr) };
  }
  if (['mult', 'multu', 'div', 'divu'].includes(mnemonic)) {
    const operands = { rs: chooseRegister(next), rt: chooseRegister(next) };
    return { mnemonic, operands, asm: `${mnemonic} $${operands.rs}, $${operands.rt}`, word: rWord(operands.rs, operands.rt, 0, specialFunct[mnemonic]) };
  }
  if (mnemonic === 'mfhi' || mnemonic === 'mflo') {
    const operands = { rd: chooseRegister(next) };
    return { mnemonic, operands, asm: `${mnemonic} $${operands.rd}`, word: rWord(0, 0, operands.rd, specialFunct[mnemonic]) };
  }
  if (mnemonic === 'mthi' || mnemonic === 'mtlo') {
    const operands = { rs: chooseRegister(next) };
    return { mnemonic, operands, asm: `${mnemonic} $${operands.rs}`, word: rWord(operands.rs, 0, 0, specialFunct[mnemonic]) };
  }
  if (mnemonic === 'mfc0' || mnemonic === 'mtc0') {
    const allowed = mnemonic === 'mfc0' ? [12, 13, 14] : [12, 14];
    const operands = { rt: chooseRegister(next), rd: allowed[next() % allowed.length] };
    return { mnemonic, operands, asm: `${mnemonic} $${operands.rt}, $${operands.rd}`, word: cp0Word(mnemonic === 'mfc0' ? 0 : 4, operands.rt, operands.rd) };
  }
  if (mnemonic === 'eret') return { mnemonic, operands: {}, asm: 'eret', word: '0x42000018' };
  if (mnemonic === 'syscall') return { mnemonic, operands: {}, asm: 'syscall', word: '0x0000000c' };
  throw new Error(`seed renderer: unsupported frozen mnemonic ${mnemonic}`);
}

export function renderSeedProgram(seedCase) {
  invariant(seedCase && typeof seedCase === 'object', 'seed case must be an object');
  invariant(profileSet.has(seedCase.profile), `unsupported profile ${seedCase.profile}`);
  invariant(typeof seedCase.id === 'string' && /^SEED-P[3-7]-\d{4}$/.test(seedCase.id), `invalid case ID ${seedCase.id}`);
  invariant(typeof seedCase.seedHashU32 === 'string' && hexHash.test(seedCase.seedHashU32), `${seedCase.id} seedHashU32 is invalid`);
  const next = xorshift(Number.parseInt(seedCase.seedHashU32.slice(2), 16));
  const haltLabel = `${seedCase.id.toLowerCase().replaceAll('-', '_')}_halt`;
  const instructions = seedMnemonicsByProfile[seedCase.profile].map((mnemonic) => renderInstruction(mnemonic, next));
  instructions.push({ mnemonic: 'beq', operands: { rs: 0, rt: 0, immediate: -1 }, asm: `beq $0, $0, ${haltLabel}`, word: '0x1000ffff', role: 'halt-loop' });
  instructions.push({ mnemonic: 'nop', operands: {}, asm: 'nop', word: '0x00000000', role: 'delay-slot' });

  const sourceLines = [
    `# ${seedCase.id}; deterministic renderer v${seedRendererRevision}; seed=${seedCase.seed}`,
    '.text 0x00003000',
    '_fixed_seed_jal_target:'
  ];
  const labelsAt = new Map();
  for (const [index, instruction] of instructions.entries()) {
    if ((instruction.mnemonic !== 'beq' && instruction.mnemonic !== 'bne') || instruction.role === 'halt-loop') continue;
    const targetIndex = index + 2;
    invariant(targetIndex < instructions.length, `${seedCase.id} branch target escapes the rendered image`);
    const label = `${seedCase.id.toLowerCase().replaceAll('-', '_')}_${instruction.mnemonic}_${index}_target`;
    instruction.asm = instruction.asm.replace('@TARGET@', label);
    const labels = labelsAt.get(targetIndex) ?? [];
    labels.push(label);
    labelsAt.set(targetIndex, labels);
  }
  const sourceMap = [];
  for (const [index, instruction] of instructions.entries()) {
    for (const label of labelsAt.get(index) ?? []) sourceLines.push(`${label}:`);
    if (instruction.role === 'halt-loop') sourceLines.push(`${haltLabel}:`);
    sourceLines.push(instruction.asm);
    sourceMap.push({ imageWord: index, sourceLine: sourceLines.length, mnemonic: instruction.mnemonic });
  }
  const source = `${sourceLines.join('\n')}\n`;
  const imageText = `${instructions.map((instruction) => instruction.word.slice(2)).join('\n')}\n`;
  invariant(instructions.length <= seedCase.sourceWordLimit, `${seedCase.id} exceeds sourceWordLimit`);
  return Object.freeze({
    caseId: seedCase.id,
    profile: seedCase.profile,
    rendererRevision: seedRendererRevision,
    evidenceCapabilityId: `assembly.${seedCase.profile.toLowerCase()}.source-image`,
    source,
    sourceSha256: sha256Text(source),
    imageText,
    imageSha256: sha256Text(imageText),
    words: Object.freeze(instructions.map((instruction) => instruction.word)),
    instructions: Object.freeze(instructions.map((instruction) => Object.freeze({ ...instruction, operands: Object.freeze({ ...instruction.operands }) }))),
    sourceMap: Object.freeze(sourceMap.map(Object.freeze))
  });
}
