#!/usr/bin/env node
/**
 * Generate src/mips/core/generated/isaCatalog.ts from resources/mips/isa.json.
 *
 * Mirrors the check/sync pattern of scripts/generate-manifest-config.mjs:
 *   - plain run writes the generated file when content changed;
 *   - --check fails (exit 1) when the checked-in file is not current.
 *
 * The generated catalog is pure data (no fs/vscode imports) so the worker does
 * not need to read JSON at runtime.
 */
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const sourceFile = path.join(root, 'resources', 'mips', 'isa.json');
const targetFile = path.join(root, 'src', 'mips', 'core', 'generated', 'isaCatalog.ts');
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');

const ROLE_REGISTERS = new Set(['rd', 'rs', 'rt', 'shamt']);
const NAMED_REGISTERS = new Map([['ra', 31]]);
const COURSE_PROFILES = ['P3', 'P4', 'P5', 'P6', 'P7'];
const FORMAT_KINDS = new Set(['r', 'regimm', 'j', 'branch', 'imm', 'cop0', 'eret', 'load', 'store', 'special2']);
const CONTROL_KINDS = new Set(['none', 'branch', 'jump', 'jump-register', 'eret', 'trap', 'syscall']);
const INSTRUCTION_LAYERS = new Set(['required', 'commonExtensions', 'marsCompatibility']);
const EXCEPTION_KINDS = new Set(['ov', 'adel', 'ades', 'syscall', 'trap']);
const HILO_NAMES = new Set(['hi', 'lo']);
const CP0_ROLES = new Set(['rd', 'epc']);
const MEMORY_KINDS = new Set(['load', 'store', 'partial-load', 'partial-store']);

function fail(message) {
  console.error(`generate-mips-isa: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function hexNumber(text) {
  if (typeof text !== 'string' || !/^0x[0-9a-f]{1,8}$/i.test(text)) {
    fail(`invalid hex literal ${String(text)}`);
  }
  const value = Number.parseInt(text.replace(/^0x/i, ''), 16);
  if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) {
    fail(`invalid hex literal ${text}`);
  }
  return value >>> 0;
}

function validateCatalog(catalog) {
  if (!isObject(catalog) || catalog.schemaRevision !== 1 || typeof catalog.description !== 'string') {
    fail('catalog must have schemaRevision 1 and a description');
  }
  validateProfilePolicies(catalog.profilePolicies);
  if (!Array.isArray(catalog.instructions) || catalog.instructions.length === 0) {
    fail('catalog.instructions must be a non-empty array');
  }
  const seen = new Set();
  const validated = [];
  for (const instruction of catalog.instructions) {
    if (!isObject(instruction)) {
      fail('every instruction must be an object');
    }
    const mnemonic = instruction.mnemonic;
    if (typeof mnemonic !== 'string' || !/^[a-z][a-z0-9]*$/.test(mnemonic)) {
      fail('every instruction needs a mnemonic');
    }
    if (seen.has(mnemonic)) {
      fail(`duplicate mnemonic ${mnemonic}`);
    }
    seen.add(mnemonic);
    if (typeof instruction.semanticHandlerId !== 'string' || !/^[a-z][a-z0-9-]*$/.test(instruction.semanticHandlerId)) {
      fail(`${mnemonic}: invalid semanticHandlerId`);
    }
    if (!isObject(instruction.format) || !FORMAT_KINDS.has(instruction.format.kind)) {
      fail(`${mnemonic}: invalid format`);
    }
    validateInteger(instruction.format.opcode, 0, 0x3f, `${mnemonic}: opcode`);
    if (instruction.format.kind === 'r' || instruction.format.kind === 'special2') {
      validateInteger(instruction.format.funct, 0, 0x3f, `${mnemonic}: funct`);
    } else if (instruction.format.funct !== undefined) {
      fail(`${mnemonic}: funct is only valid for r/special2 formats`);
    }
    if (instruction.format.kind === 'regimm') {
      validateInteger(instruction.format.rt, 0, 0x1f, `${mnemonic}: REGIMM rt`);
    } else if (instruction.format.rt !== undefined) {
      fail(`${mnemonic}: format.rt is only valid for REGIMM`);
    }
    if (instruction.format.kind === 'cop0') {
      validateInteger(instruction.format.rs, 0, 0x1f, `${mnemonic}: COP0 rs`);
    } else if (instruction.format.rs !== undefined) {
      fail(`${mnemonic}: format.rs is only valid for COP0`);
    }
    if (!isObject(instruction.runtimeMatch)) {
      fail(`${mnemonic}: runtimeMatch must be an object`);
    }
    const mask = hexNumber(instruction.runtimeMatch.mask);
    const value = hexNumber(instruction.runtimeMatch.value);
    if (((value & (~mask >>> 0)) >>> 0) !== 0) {
      fail(`${mnemonic}: runtimeMatch value has bits outside its mask`);
    }
    const funct = instruction.format.funct;
    if (funct !== undefined && (value & 0x3f) !== funct) {
      fail(`${mnemonic}: funct ${funct} does not match runtimeMatch value 0x${value.toString(16)}`);
    }
    const opcode = instruction.format.opcode;
    if (opcode !== undefined && ((value >>> 26) & 0x3f) !== opcode) {
      fail(`${mnemonic}: opcode ${opcode} does not match runtimeMatch value 0x${value.toString(16)}`);
    }
    if (!isObject(instruction.canonicalEncodingConstraints)
      || !Array.isArray(instruction.canonicalEncodingConstraints.fixedZeroBits)) {
      fail(`${mnemonic}: canonicalEncodingConstraints.fixedZeroBits must be an array`);
    }
    let fixedMask = 0;
    for (const bit of instruction.canonicalEncodingConstraints.fixedZeroBits) {
      if (!isObject(bit) || typeof bit.label !== 'string' || !bit.label) {
        fail(`${mnemonic}: invalid canonical fixed-zero constraint`);
      }
      const bitMask = hexNumber(bit.mask);
      if (bitMask === 0 || ((fixedMask & bitMask) >>> 0) !== 0) {
        fail(`${mnemonic}: canonical fixed-zero masks must be non-zero and disjoint`);
      }
      fixedMask = (fixedMask | bitMask) >>> 0;
    }
    validateEffects(mnemonic, instruction.effects);
    if (!isObject(instruction.control) || !CONTROL_KINDS.has(instruction.control.kind)) {
      fail(`${mnemonic}: invalid control kind`);
    }
    if (typeof instruction.delaySlot !== 'boolean' || typeof instruction.link !== 'boolean') {
      fail(`${mnemonic}: delaySlot and link must be booleans`);
    }
    validateStringArray(instruction.possibleExceptions, EXCEPTION_KINDS, `${mnemonic}: possibleExceptions`);
    validateMemoryAccess(mnemonic, instruction.format.kind, instruction.memoryAccess);
    if (!isObject(instruction.availability) || !INSTRUCTION_LAYERS.has(instruction.availability.layer)) {
      fail(`${mnemonic}: invalid availability layer ${String(instruction.availability?.layer)}`);
    }
    validateStringArray(instruction.availability.profiles, new Set(COURSE_PROFILES), `${mnemonic}: profiles`, true);
    validated.push({ instruction, mask, value });
  }
  validateRuntimeOverlaps(validated);
}

function validateProfilePolicies(policies) {
  if (!isObject(policies) || Object.keys(policies).sort().join(',') !== [...COURSE_PROFILES].sort().join(',')) {
    fail(`profilePolicies must define exactly ${COURSE_PROFILES.join(', ')}`);
  }
  for (const profile of COURSE_PROFILES) {
    const policy = policies[profile];
    if (!isObject(policy)
      || typeof policy.controlTransferDelaySlot !== 'boolean'
      || typeof policy.architecturalExceptions !== 'boolean'
      || Object.keys(policy).some((key) => !['controlTransferDelaySlot', 'architecturalExceptions'].includes(key))) {
      fail(`${profile}: invalid profile policy`);
    }
  }
}

function validateEffects(mnemonic, effects) {
  if (!isObject(effects)) {
    fail(`${mnemonic}: effects must be an object`);
  }
  const requiredKeys = ['gprWrites', 'gprReads', 'hiloReads', 'hiloWrites', 'cp0Reads', 'cp0Writes'];
  if (Object.keys(effects).sort().join(',') !== [...requiredKeys].sort().join(',')) {
    fail(`${mnemonic}: effects must define exactly ${requiredKeys.join(', ')}`);
  }
  for (const key of ['gprWrites', 'gprReads']) {
    if (!Array.isArray(effects[key])) {
      fail(`${mnemonic}: effects.${key} must be an array`);
    }
    const normalized = effects[key].map((operand) => serializeOperand(operand));
    if (new Set(normalized).size !== normalized.length) {
      fail(`${mnemonic}: effects.${key} contains duplicates`);
    }
  }
  validateStringArray(effects.hiloReads, HILO_NAMES, `${mnemonic}: hiloReads`);
  validateStringArray(effects.hiloWrites, HILO_NAMES, `${mnemonic}: hiloWrites`);
  validateStringArray(effects.cp0Reads, CP0_ROLES, `${mnemonic}: cp0Reads`);
  validateStringArray(effects.cp0Writes, CP0_ROLES, `${mnemonic}: cp0Writes`);
}

function validateMemoryAccess(mnemonic, formatKind, memoryAccess) {
  if (memoryAccess === undefined) {
    if (formatKind === 'load' || formatKind === 'store') {
      fail(`${mnemonic}: load/store format requires memoryAccess`);
    }
    return;
  }
  if (!isObject(memoryAccess)
    || !MEMORY_KINDS.has(memoryAccess.kind)
    || ![1, 2, 4].includes(memoryAccess.width)
    || typeof memoryAccess.signExtend !== 'boolean') {
    fail(`${mnemonic}: invalid memoryAccess`);
  }
  if (!['load', 'store'].includes(formatKind)) {
    fail(`${mnemonic}: memoryAccess is only valid for load/store formats`);
  }
  if (formatKind === 'load' && !['load', 'partial-load'].includes(memoryAccess.kind)) {
    fail(`${mnemonic}: load format has non-load memoryAccess kind`);
  }
  if (formatKind === 'store' && !['store', 'partial-store'].includes(memoryAccess.kind)) {
    fail(`${mnemonic}: store format has non-store memoryAccess kind`);
  }
}

function validateRuntimeOverlaps(entries) {
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex++) {
      const left = entries[leftIndex];
      const right = entries[rightIndex];
      const commonMask = (left.mask & right.mask) >>> 0;
      if ((((left.value ^ right.value) & commonMask) >>> 0) !== 0) {
        continue;
      }
      const leftInstruction = left.instruction;
      const rightInstruction = right.instruction;
      // A single exact word may intentionally specialize a broader opcode/funct
      // family (nop/sll, eret/COP0). Two exact entries for the same word are a
      // genuine ambiguity and must not pass this exception.
      const exactSpecialization = (left.mask === 0xffffffff) !== (right.mask === 0xffffffff);
      const sharedRegimm = left.mask === right.mask
        && left.value === right.value
        && leftInstruction.format.kind === 'regimm'
        && rightInstruction.format.kind === 'regimm'
        && leftInstruction.format.rt !== rightInstruction.format.rt;
      const sharedCop0 = left.mask === right.mask
        && left.value === right.value
        && leftInstruction.format.kind === 'cop0'
        && rightInstruction.format.kind === 'cop0'
        && leftInstruction.format.rs !== rightInstruction.format.rs;
      if (!exactSpecialization && !sharedRegimm && !sharedCop0) {
        fail(`${leftInstruction.mnemonic}/${rightInstruction.mnemonic}: ambiguous runtime recognition masks`);
      }
    }
  }
}

function validateInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer in ${minimum}..${maximum}`);
  }
}

function validateStringArray(value, allowed, label, nonEmpty = false) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)
    || value.some((entry) => typeof entry !== 'string' || !allowed.has(entry))
    || new Set(value).size !== value.length) {
    fail(`${label} must be ${nonEmpty ? 'a non-empty ' : 'an '}array of unique known values`);
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Serialize an effects operand list: roles stay strings, named registers become numbers. */
function serializeOperands(operands) {
  return `[${(operands ?? []).map((operand) => serializeOperand(operand)).join(', ')}]`;
}

function serializeOperand(operand) {
  if (typeof operand === 'number') {
    return String(operand);
  }
  const named = NAMED_REGISTERS.get(operand);
  if (named !== undefined) {
    return String(named);
  }
  if (ROLE_REGISTERS.has(operand)) {
    return `'${operand}'`;
  }
  fail(`unknown operand role ${operand}`);
}

function serializeFixedZeroBits(bits) {
  return `[${(bits ?? []).map((bit) => `[${hexNumber(bit.mask)}, ${JSON.stringify(bit.label)}] as const`).join(', ')}]`;
}

function generateTs(catalog, sourceSha256) {
  const lines = [];
  lines.push('// @generated by scripts/generate-mips-isa.mjs from resources/mips/isa.json — DO NOT EDIT.');
  lines.push('// @index mips-core — 生成的课程 ISA catalog 结构事实（唯一数据源为 resources/mips/isa.json）');
  lines.push('');
  lines.push('export type CourseProfile = \'P3\' | \'P4\' | \'P5\' | \'P6\' | \'P7\';');
  lines.push('export type InstructionLayer = \'required\' | \'commonExtensions\' | \'marsCompatibility\';');
  lines.push('export type ControlKind = \'none\' | \'branch\' | \'jump\' | \'jump-register\' | \'eret\' | \'trap\' | \'syscall\';');
  lines.push('export type RegisterRole = \'rd\' | \'rs\' | \'rt\' | \'shamt\';');
  lines.push('export type ExceptionKind = \'ov\' | \'adel\' | \'ades\' | \'syscall\' | \'trap\';');
  lines.push('');
  lines.push(`export const isaCatalogSchemaRevision = ${catalog.schemaRevision} as const;`);
  lines.push(`export const isaCatalogSha256 = ${JSON.stringify(sourceSha256)} as const;`);
  lines.push('');
  lines.push('export interface IsaInstructionEntry {');
  lines.push('  readonly mnemonic: string;');
  lines.push('  readonly semanticHandlerId: string;');
  lines.push('  readonly formatKind: string;');
  lines.push('  readonly formatOpcode: number;');
  lines.push('  readonly formatFunct: number;');
  lines.push('  readonly formatRt: number;');
  lines.push('  readonly formatRs: number;');
  lines.push('  readonly runtimeMatchMask: number;');
  lines.push('  readonly runtimeMatchValue: number;');
  lines.push('  readonly canonicalFixedZeroBits: readonly (readonly [number, string])[];');
  lines.push('  readonly gprWrites: readonly (RegisterRole | number)[];');
  lines.push('  readonly gprReads: readonly (RegisterRole | number)[];');
  lines.push('  readonly hiloReads: readonly string[];');
  lines.push('  readonly hiloWrites: readonly string[];');
  lines.push('  readonly cp0Reads: readonly (RegisterRole | string)[];');
  lines.push('  readonly cp0Writes: readonly (RegisterRole | string)[];');
  lines.push('  readonly controlKind: ControlKind;');
  lines.push('  readonly delaySlotProfiles: readonly CourseProfile[];');
  lines.push('  readonly link: boolean;');
  lines.push('  readonly possibleExceptionsByProfile: Readonly<Partial<Record<CourseProfile, readonly ExceptionKind[]>>>;');
  lines.push('  readonly memoryAccess: { readonly kind: string; readonly width: number; readonly signExtend: boolean } | undefined;');
  lines.push('  readonly layer: InstructionLayer;');
  lines.push('  readonly profiles: readonly CourseProfile[];');
  lines.push('}');
  lines.push('');
  lines.push('export interface IsaProfilePolicy {');
  lines.push('  readonly controlTransferDelaySlot: boolean;');
  lines.push('  readonly architecturalExceptions: boolean;');
  lines.push('}');
  lines.push('');
  lines.push(`export const isaProfilePolicies: Readonly<Record<CourseProfile, IsaProfilePolicy>> = ${JSON.stringify(catalog.profilePolicies, null, 2)};`);
  lines.push('');
  lines.push('export const isaInstructions: readonly IsaInstructionEntry[] = [');
  for (const instruction of catalog.instructions) {
    const effects = instruction.effects;
    const memory = instruction.memoryAccess;
    const delaySlotProfiles = instruction.delaySlot
      ? instruction.availability.profiles.filter((profile) => catalog.profilePolicies[profile].controlTransferDelaySlot)
      : [];
    const possibleExceptionsByProfile = Object.fromEntries(
      instruction.availability.profiles
        .filter((profile) => catalog.profilePolicies[profile].architecturalExceptions && instruction.possibleExceptions.length)
        .map((profile) => [profile, instruction.possibleExceptions])
    );
    lines.push('  {');
    lines.push(`    mnemonic: ${JSON.stringify(instruction.mnemonic)},`);
    lines.push(`    semanticHandlerId: ${JSON.stringify(instruction.semanticHandlerId)},`);
    lines.push(`    formatKind: ${JSON.stringify(instruction.format.kind)},`);
    lines.push(`    formatOpcode: ${instruction.format.opcode ?? 0},`);
    lines.push(`    formatFunct: ${instruction.format.funct ?? 0},`);
    lines.push(`    formatRt: ${instruction.format.rt ?? 0},`);
    lines.push(`    formatRs: ${instruction.format.rs ?? 0},`);
    lines.push(`    runtimeMatchMask: ${hexNumber(instruction.runtimeMatch.mask)},`);
    lines.push(`    runtimeMatchValue: ${hexNumber(instruction.runtimeMatch.value)},`);
    lines.push(`    canonicalFixedZeroBits: ${serializeFixedZeroBits(instruction.canonicalEncodingConstraints?.fixedZeroBits)},`);
    lines.push(`    gprWrites: ${serializeOperands(effects.gprWrites)},`);
    lines.push(`    gprReads: ${serializeOperands(effects.gprReads)},`);
    lines.push(`    hiloReads: ${JSON.stringify(effects.hiloReads)},`);
    lines.push(`    hiloWrites: ${JSON.stringify(effects.hiloWrites)},`);
    lines.push(`    cp0Reads: ${JSON.stringify(effects.cp0Reads)},`);
    lines.push(`    cp0Writes: ${JSON.stringify(effects.cp0Writes)},`);
    lines.push(`    controlKind: ${JSON.stringify(instruction.control.kind)},`);
    lines.push(`    delaySlotProfiles: ${JSON.stringify(delaySlotProfiles)},`);
    lines.push(`    link: ${instruction.link === true},`);
    lines.push(`    possibleExceptionsByProfile: ${JSON.stringify(possibleExceptionsByProfile)},`);
    lines.push(`    memoryAccess: ${memory === undefined ? 'undefined' : JSON.stringify(memory)},`);
    lines.push(`    layer: ${JSON.stringify(instruction.availability.layer)},`);
    lines.push(`    profiles: ${JSON.stringify(instruction.availability.profiles)}`);
    lines.push('  },');
  }
  lines.push('];');
  lines.push('');
  lines.push('export const isaInstructionByMnemonic: ReadonlyMap<string, IsaInstructionEntry> =');
  lines.push('  new Map(isaInstructions.map((entry) => [entry.mnemonic, entry]));');
  lines.push('');
  lines.push('/** Instructions available for a profile, sorted by mnemonic. */');
  lines.push('export function isaMnemonicsForProfile(profile: CourseProfile): readonly string[] {');
  lines.push('  return isaInstructions');
  lines.push('    .filter((entry) => entry.profiles.includes(profile))');
  lines.push('    .map((entry) => entry.mnemonic)');
  lines.push('    .sort();');
  lines.push('}');
  lines.push('');
  lines.push('/** Tutorial-required instruction set for a profile, sorted by mnemonic. */');
  lines.push('export function requiredMnemonicsForProfile(profile: CourseProfile): readonly string[] {');
  lines.push('  return isaInstructions');
  lines.push('    .filter((entry) => entry.layer === \'required\' && entry.profiles.includes(profile))');
  lines.push('    .map((entry) => entry.mnemonic)');
  lines.push('    .sort();');
  lines.push('}');
  lines.push('');
  lines.push('/** Whether this instruction has one architectural delay slot in a profile. */');
  lines.push('export function instructionHasDelaySlot(entry: IsaInstructionEntry, profile: CourseProfile): boolean {');
  lines.push('  return entry.delaySlotProfiles.includes(profile);');
  lines.push('}');
  lines.push('');
  lines.push('/** Architectural exception kinds enabled for this instruction in a profile. */');
  lines.push('export function instructionExceptionsForProfile(');
  lines.push('  entry: IsaInstructionEntry,');
  lines.push('  profile: CourseProfile');
  lines.push('): readonly ExceptionKind[] {');
  lines.push('  return entry.possibleExceptionsByProfile[profile] ?? [];');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function main() {
  const sourceBytes = fs.readFileSync(sourceFile);
  const catalog = JSON.parse(sourceBytes.toString('utf8'));
  validateCatalog(catalog);
  const sourceSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  const generated = generateTs(catalog, sourceSha256);
  const current = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : undefined;
  if (current === generated) {
    console.log('isaCatalog.ts is up to date.');
    return;
  }
  if (checkOnly) {
    fail(`${path.relative(root, targetFile)} is not generated from current resources/mips/isa.json. Run "npm run generate:isa-catalog".`);
  }
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, generated, 'utf8');
  console.log(`generated ${path.relative(root, targetFile)}`);
}

try {
  main();
} catch {
  if (!process.exitCode) {
    process.exitCode = 1;
  }
}
