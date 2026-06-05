import { ProjectProfile } from '../projectProfile';
import {
  instructions,
  MipsInstruction
} from '../language/mips/resources';

export interface BuiltinAsmGeneratorOptions {
  profile: ProjectProfile;
  instructionText: string;
  instructionCount: number;
  seed?: string;
  generatedAt?: Date;
}

export interface BuiltinInstructionSet {
  mnemonics: string[];
  defaulted: boolean;
  profile: CpuProfile;
}

export interface BuiltinAsmGeneratorResult {
  text: string;
  seed: string;
  profile: CpuProfile;
  instructionSet: string[];
  instructionCount: number;
  usedInstructions: string[];
}

type CpuProfile = 'P3' | 'P4' | 'P5' | 'P6' | 'P7';

type ControlMnemonic =
  | 'beq'
  | 'bne'
  | 'bgez'
  | 'bgtz'
  | 'blez'
  | 'bltz'
  | 'bgezal'
  | 'bltzal'
  | 'j'
  | 'jal'
  | 'jr'
  | 'jalr';

const cpuProfiles = new Set<ProjectProfile>(['P3', 'P4', 'P5', 'P6', 'P7']);

const defaultInstructionSets: Record<CpuProfile, string[]> = {
  P3: ['addu', 'subu', 'ori', 'lui', 'lw', 'sw', 'beq', 'j', 'jal', 'jr'],
  P4: ['addu', 'subu', 'ori', 'lui', 'lw', 'sw', 'beq', 'j', 'jal', 'jr'],
  P5: ['addu', 'subu', 'addiu', 'ori', 'lui', 'lw', 'sw', 'beq', 'bne', 'j', 'jal', 'jr', 'sll', 'srl', 'slt'],
  P6: [
    'addu', 'subu', 'addiu', 'ori', 'lui', 'lw', 'sw', 'lb', 'lbu', 'lh', 'lhu', 'sb', 'sh',
    'beq', 'bne', 'j', 'jal', 'jr', 'sll', 'srl', 'sra', 'slt', 'mult', 'multu', 'div', 'divu',
    'mfhi', 'mflo', 'mthi', 'mtlo'
  ],
  P7: [
    'addu', 'subu', 'addiu', 'ori', 'lui', 'lw', 'sw', 'lb', 'lbu', 'lh', 'lhu', 'sb', 'sh',
    'beq', 'bne', 'j', 'jal', 'jr', 'sll', 'srl', 'sra', 'slt', 'mult', 'multu', 'div', 'divu',
    'mfhi', 'mflo', 'mthi', 'mtlo', 'mfc0', 'mtc0', 'teqi', 'tnei', 'tgei', 'tlti'
  ]
};

const supportedMnemonics = new Set([
  'add', 'addu', 'addi', 'addiu', 'sub', 'subu',
  'and', 'andi', 'or', 'ori', 'xor', 'xori', 'nor',
  'slt', 'sltu', 'slti', 'sltiu',
  'sll', 'srl', 'sra', 'sllv', 'srlv', 'srav',
  'lui', 'clz', 'clo',
  'lw', 'lwl', 'lwr', 'sw', 'swl', 'swr', 'lb', 'lbu', 'lh', 'lhu', 'sb', 'sh',
  'beq', 'bne', 'bgez', 'bgtz', 'blez', 'bltz', 'bgezal', 'bltzal',
  'j', 'jal', 'jr', 'jalr',
  'movn', 'movz',
  'mul', 'madd', 'maddu', 'msub', 'msubu', 'mult', 'multu', 'div', 'divu', 'mfhi', 'mflo', 'mthi', 'mtlo',
  'mfc0', 'mtc0',
  'teq', 'tne', 'tge', 'tgeu', 'tlt', 'tltu',
  'teqi', 'tnei', 'tgei', 'tgeiu', 'tlti', 'tltiu',
  'nop'
]);

const controlMnemonics = new Set<string>([
  'beq', 'bne', 'bgez', 'bgtz', 'blez', 'bltz', 'bgezal', 'bltzal',
  'j', 'jal', 'jr', 'jalr'
]);

const branchMnemonics = new Set<string>([
  'beq', 'bne', 'bgez', 'bgtz', 'blez', 'bltz', 'bgezal', 'bltzal'
]);

const linkBranchMnemonics = new Set<string>(['bgezal', 'bltzal']);
const jumpLinkMnemonics = new Set<string>(['jal', 'jalr']);
const divideMnemonics = new Set<string>(['div', 'divu']);
const hiLoWriteMnemonics = new Set<string>(['mult', 'multu', 'div', 'divu', 'madd', 'maddu', 'msub', 'msubu', 'mthi', 'mtlo']);
const hiLoReadMnemonics = new Set<string>(['mfhi', 'mflo']);
const loadMnemonics = new Set<string>(['lw', 'lwl', 'lwr', 'lb', 'lbu', 'lh', 'lhu']);
const storeMnemonics = new Set<string>(['sw', 'swl', 'swr', 'sb', 'sh']);
const cp0Mnemonics = new Set<string>(['mfc0', 'mtc0']);

const generalRegisters = [
  '$1', '$2', '$3', '$4', '$5', '$6', '$7',
  '$8', '$9', '$10', '$11', '$12', '$13', '$14', '$15',
  '$16', '$17', '$18', '$19', '$20', '$21', '$22', '$23', '$24'
];

const writableRegisters = [...generalRegisters, '$25'];
const readRegisters = ['$0', ...writableRegisters];

const dataByteLength = 1024;
const dataWordCount = dataByteLength / 4;
const textBaseAddress = 0x3000;

export class BuiltinAsmGeneratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuiltinAsmGeneratorError';
  }
}

export function effectiveBuiltinGeneratorProfile(profile: ProjectProfile): CpuProfile {
  return cpuProfiles.has(profile) ? profile as CpuProfile : 'P5';
}

export function resolveBuiltinInstructionSet(profile: ProjectProfile, instructionText: string): BuiltinInstructionSet {
  const effectiveProfile = effectiveBuiltinGeneratorProfile(profile);
  const configured = instructionText.trim().length > 0;
  const rawTokens = configured
    ? instructionText.split(/[,\s]+/).map((token) => token.trim()).filter(Boolean)
    : defaultInstructionSets[effectiveProfile];

  const seen = new Set<string>();
  const mnemonics: string[] = [];
  const unknown: string[] = [];
  const pseudo: string[] = [];
  const unsupported: string[] = [];
  const profileMismatches: string[] = [];

  for (const raw of rawTokens) {
    const mnemonic = raw.toLowerCase();
    if (seen.has(mnemonic)) {
      continue;
    }
    seen.add(mnemonic);

    const instruction = instructions[mnemonic] as MipsInstruction | undefined;
    if (!instruction) {
      unknown.push(raw);
      continue;
    }
    if (instruction.pseudo) {
      pseudo.push(raw);
      continue;
    }
    if (!supportedMnemonics.has(mnemonic)) {
      unsupported.push(raw);
      continue;
    }
    if (instruction.projects && !instruction.projects.includes(effectiveProfile)) {
      profileMismatches.push(`${raw}(${instruction.projects.join('/')})`);
      continue;
    }
    mnemonics.push(mnemonic);
  }

  const messages: string[] = [];
  if (unknown.length) {
    messages.push(`unknown instruction name(s): ${unknown.join(', ')}`);
  }
  if (pseudo.length) {
    messages.push(`not accepted as real CPU instructions: ${pseudo.join(', ')}`);
  }
  if (unsupported.length) {
    messages.push(`not supported by the built-in generator: ${unsupported.join(', ')}`);
  }
  if (profileMismatches.length) {
    messages.push(`not valid for ${effectiveProfile}: ${profileMismatches.join(', ')}`);
  }
  if (messages.length) {
    throw new BuiltinAsmGeneratorError(`Invalid built-in ASM generator instruction set: ${messages.join('; ')}.`);
  }
  if (!mnemonics.length) {
    throw new BuiltinAsmGeneratorError('Invalid built-in ASM generator instruction set: no usable real instructions were provided.');
  }

  return {
    mnemonics,
    defaulted: !configured,
    profile: effectiveProfile
  };
}

export function generateBuiltinAsmTestCase(options: BuiltinAsmGeneratorOptions): BuiltinAsmGeneratorResult {
  const count = Math.floor(options.instructionCount);
  if (!Number.isFinite(count) || count <= 0) {
    throw new BuiltinAsmGeneratorError('Built-in ASM generator instruction count must be a positive integer.');
  }

  const instructionSet = resolveBuiltinInstructionSet(options.profile, options.instructionText);
  const seed = options.seed && options.seed.trim()
    ? options.seed.trim()
    : `${Date.now()}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
  const generator = new ProgramGenerator(instructionSet.profile, instructionSet.mnemonics, count, seed, options.generatedAt ?? new Date());
  return generator.generate();
}

class ProgramGenerator {
  private readonly rng: Random;
  private readonly allowed: Set<string>;
  private readonly profile: CpuProfile;
  private readonly targetCount: number;
  private readonly seed: string;
  private readonly generatedAt: Date;
  private readonly regs = new Map<string, number>();
  private readonly memory = new Map<number, number>();
  private readonly lines: string[] = [];
  private readonly used = new Set<string>();
  private readonly recentWrites: string[] = [];
  private labelIndex = 0;
  private emittedCount = 0;
  private hi = 0;
  private lo = 0;
  private pendingHiLoRead = false;

  constructor(profile: CpuProfile, mnemonics: string[], targetCount: number, seed: string, generatedAt: Date) {
    this.profile = profile;
    this.allowed = new Set(mnemonics);
    this.targetCount = targetCount;
    this.seed = seed;
    this.generatedAt = generatedAt;
    this.rng = new Random(hashSeed(`${profile}:${targetCount}:${seed}`));

    for (const register of ['$0', ...writableRegisters, '$26', '$27', '$28', '$29', '$30', '$31']) {
      this.regs.set(register, 0);
    }
    for (let i = 0; i < dataWordCount; i++) {
      this.memory.set(i * 4, 0);
    }
  }

  generate(): BuiltinAsmGeneratorResult {
    const coverageQueue = this.shuffle(Array.from(this.allowed));
    let guard = this.targetCount * 30 + 200;

    while (this.remaining() > 0 && guard-- > 0) {
      const fromCoverage = this.pickCoverageMnemonic(coverageQueue);
      if (fromCoverage) {
        this.emitMnemonic(fromCoverage);
        continue;
      }

      const biased = this.pickBiasedMnemonic();
      if (biased) {
        this.emitMnemonic(biased);
        continue;
      }

      const fallback = this.pickAnyMnemonic();
      if (!fallback) {
        throw new BuiltinAsmGeneratorError('Built-in ASM generator could not fill the requested instruction count with the configured instruction set. Add a safe value-producing instruction such as ori/addiu/addu, or reduce control/MDU-only instructions.');
      }
      this.emitMnemonic(fallback);
    }

    if (this.emittedCount !== this.targetCount) {
      throw new BuiltinAsmGeneratorError(`Built-in ASM generator emitted ${this.emittedCount} instruction(s), expected ${this.targetCount}.`);
    }

    return {
      text: this.render(),
      seed: this.seed,
      profile: this.profile,
      instructionSet: Array.from(this.allowed).sort(),
      instructionCount: this.emittedCount,
      usedInstructions: Array.from(this.used).sort()
    };
  }

  private render(): string {
    const instructionSet = Array.from(this.allowed).sort().join(' ');
    return [
      '# Built-in BUAA CO random ASM test',
      `# profile: ${this.profile}`,
      `# seed: ${this.seed}`,
      `# generated: ${this.generatedAt.toISOString()}`,
      `# instruction_count: ${this.targetCount}`,
      `# instruction_set: ${instructionSet}`,
      '.data',
      '.align 2',
      '_co_data:',
      `    .space ${dataByteLength}`,
      '.text',
      '.globl main',
      'main:',
      ...this.lines,
      ''
    ].join('\n');
  }

  private pickCoverageMnemonic(queue: string[]): string | undefined {
    for (let i = 0; i < queue.length; i++) {
      const mnemonic = queue[i];
      if (this.used.has(mnemonic)) {
        queue.splice(i, 1);
        i--;
        continue;
      }
      if (this.canEmit(mnemonic, this.remaining())) {
        queue.splice(i, 1);
        return mnemonic;
      }
    }
    return undefined;
  }

  private pickBiasedMnemonic(): string | undefined {
    if (this.pendingHiLoRead) {
      const readers = ['mflo', 'mfhi'].filter((mnemonic) => this.allowed.has(mnemonic) && this.canEmit(mnemonic, this.remaining()));
      if (readers.length && this.rng.chance(0.75)) {
        return this.rng.pick(readers);
      }
    }

    const candidates = Array.from(this.allowed).filter((mnemonic) => this.canEmit(mnemonic, this.remaining()));
    if (!candidates.length) {
      return undefined;
    }

    const weighted: string[] = [];
    for (const mnemonic of candidates) {
      const weight = this.weightFor(mnemonic);
      for (let i = 0; i < weight; i++) {
        weighted.push(mnemonic);
      }
    }
    return this.rng.pick(weighted);
  }

  private pickAnyMnemonic(): string | undefined {
    return this.rng.pick(Array.from(this.allowed).filter((mnemonic) => this.canEmit(mnemonic, this.remaining())));
  }

  private weightFor(mnemonic: string): number {
    if (this.profile === 'P5' || this.profile === 'P6' || this.profile === 'P7') {
      if (loadMnemonics.has(mnemonic) || storeMnemonics.has(mnemonic)) {
        return 5;
      }
      if (branchMnemonics.has(mnemonic)) {
        return 4;
      }
      if (hiLoReadMnemonics.has(mnemonic) && this.pendingHiLoRead) {
        return 8;
      }
      if (hiLoWriteMnemonics.has(mnemonic)) {
        return 4;
      }
    }
    if (controlMnemonics.has(mnemonic)) {
      return 2;
    }
    return 3;
  }

  private canEmit(mnemonic: string, remaining: number): boolean {
    if (remaining <= 0) {
      return false;
    }
    if (controlMnemonics.has(mnemonic)) {
      return this.canEmitControl(mnemonic as ControlMnemonic, remaining);
    }
    return this.canEmitSingle(mnemonic);
  }

  private canEmitSingle(mnemonic: string): boolean {
    if (divideMnemonics.has(mnemonic)) {
      return this.nonZeroRegisters(mnemonic === 'div').length > 0;
    }
    if (mnemonic === 'teq' || mnemonic === 'tge' || mnemonic === 'tgeu' || mnemonic === 'tlt' || mnemonic === 'tltu') {
      return this.falseTrapRegisterOperands(mnemonic) !== undefined;
    }
    if (cp0Mnemonics.has(mnemonic)) {
      return this.profile === 'P7';
    }
    return true;
  }

  private canEmitControl(mnemonic: ControlMnemonic, remaining: number): boolean {
    const delayCost = this.usesDelaySlot() ? 1 : 0;
    if (delayCost && !this.hasDelaySlotCandidate()) {
      return false;
    }
    if (mnemonic === 'jr' || mnemonic === 'jalr') {
      return remaining >= 2 + delayCost && this.addressLoaderMnemonic() !== undefined;
    }
    return remaining >= 1 + delayCost;
  }

  private hasDelaySlotCandidate(): boolean {
    return Array.from(this.allowed).some((mnemonic) => !controlMnemonics.has(mnemonic) && this.canEmitSingle(mnemonic));
  }

  private emitMnemonic(mnemonic: string): void {
    if (controlMnemonics.has(mnemonic)) {
      this.emitControl(mnemonic as ControlMnemonic);
      return;
    }
    this.emitSingle(mnemonic);
  }

  private emitSingle(mnemonic: string): void {
    switch (mnemonic) {
      case 'add':
      case 'addu':
      case 'sub':
      case 'subu':
      case 'and':
      case 'or':
      case 'xor':
      case 'nor':
      case 'slt':
      case 'sltu':
      case 'mul':
        this.emitThreeRegister(mnemonic);
        return;
      case 'addi':
      case 'addiu':
      case 'andi':
      case 'ori':
      case 'xori':
      case 'slti':
      case 'sltiu':
        this.emitImmediate(mnemonic);
        return;
      case 'sll':
      case 'srl':
      case 'sra':
        this.emitShift(mnemonic);
        return;
      case 'sllv':
      case 'srlv':
      case 'srav':
        this.emitVariableShift(mnemonic);
        return;
      case 'lui':
        this.emitLui();
        return;
      case 'lw':
      case 'lwl':
      case 'lwr':
      case 'lb':
      case 'lbu':
      case 'lh':
      case 'lhu':
        this.emitLoad(mnemonic);
        return;
      case 'sw':
      case 'swl':
      case 'swr':
      case 'sb':
      case 'sh':
        this.emitStore(mnemonic);
        return;
      case 'mult':
      case 'multu':
      case 'madd':
      case 'maddu':
      case 'msub':
      case 'msubu':
        this.emitHiLoMultiply(mnemonic);
        return;
      case 'div':
      case 'divu':
        this.emitDivide(mnemonic);
        return;
      case 'mfhi':
      case 'mflo':
        this.emitHiLoRead(mnemonic);
        return;
      case 'mthi':
      case 'mtlo':
        this.emitHiLoWrite(mnemonic);
        return;
      case 'movn':
      case 'movz':
        this.emitConditionalMove(mnemonic);
        return;
      case 'clz':
      case 'clo':
        this.emitCountBits(mnemonic);
        return;
      case 'mfc0':
      case 'mtc0':
        this.emitCp0(mnemonic);
        return;
      case 'teq':
      case 'tne':
      case 'tge':
      case 'tgeu':
      case 'tlt':
      case 'tltu':
        this.emitTrapRegister(mnemonic);
        return;
      case 'teqi':
      case 'tnei':
      case 'tgei':
      case 'tgeiu':
      case 'tlti':
      case 'tltiu':
        this.emitTrapImmediate(mnemonic);
        return;
      case 'nop':
        this.emitNop();
        return;
      default:
        throw new BuiltinAsmGeneratorError(`Built-in ASM generator does not know how to emit ${mnemonic}.`);
    }
  }

  private emitNop(): void {
    this.emit('nop', 'nop');
  }

  private emitThreeRegister(mnemonic: string): void {
    const rd = this.chooseWriteRegister();
    const rs = mnemonic === 'add' || mnemonic === 'sub'
      ? this.chooseSmallReadRegister()
      : this.chooseReadRegister();
    const rt = mnemonic === 'add' || mnemonic === 'sub'
      ? this.chooseSmallReadRegister()
      : this.chooseReadRegister();
    this.emit(mnemonic, `${mnemonic} ${rd}, ${rs}, ${rt}`);

    const left = this.regValue(rs);
    const right = this.regValue(rt);
    let value = 0;
    switch (mnemonic) {
      case 'add':
      case 'addu':
        value = left + right;
        break;
      case 'sub':
      case 'subu':
        value = left - right;
        break;
      case 'and':
        value = left & right;
        break;
      case 'or':
        value = left | right;
        break;
      case 'xor':
        value = left ^ right;
        break;
      case 'nor':
        value = ~(left | right);
        break;
      case 'slt':
        value = signed32(left) < signed32(right) ? 1 : 0;
        break;
      case 'sltu':
        value = unsigned32(left) < unsigned32(right) ? 1 : 0;
        break;
      case 'mul':
        value = Math.imul(left, right);
        break;
    }
    this.setRegister(rd, value);
  }

  private emitImmediate(mnemonic: string): void {
    const rt = this.chooseWriteRegister();
    const rs = mnemonic === 'addi'
      ? this.chooseSmallReadRegister()
      : this.chooseReadRegister();
    const imm = this.immediateFor(mnemonic);
    this.emit(mnemonic, `${mnemonic} ${rt}, ${rs}, ${formatImmediate(imm)}`);

    const left = this.regValue(rs);
    let value = 0;
    switch (mnemonic) {
      case 'addi':
      case 'addiu':
        value = left + signExtend16(imm);
        break;
      case 'andi':
        value = left & (imm & 0xffff);
        break;
      case 'ori':
        value = left | (imm & 0xffff);
        break;
      case 'xori':
        value = left ^ (imm & 0xffff);
        break;
      case 'slti':
        value = signed32(left) < signExtend16(imm) ? 1 : 0;
        break;
      case 'sltiu':
        value = unsigned32(left) < unsigned32(signExtend16(imm)) ? 1 : 0;
        break;
    }
    this.setRegister(rt, value);
  }

  private emitShift(mnemonic: string): void {
    const rd = this.chooseWriteRegister();
    const rt = this.chooseReadRegister();
    const shamt = this.rng.int(0, 31);
    this.emit(mnemonic, `${mnemonic} ${rd}, ${rt}, ${shamt}`);

    const value = this.regValue(rt);
    if (mnemonic === 'sll') {
      this.setRegister(rd, value << shamt);
    } else if (mnemonic === 'srl') {
      this.setRegister(rd, value >>> shamt);
    } else {
      this.setRegister(rd, value >> shamt);
    }
  }

  private emitVariableShift(mnemonic: string): void {
    const rd = this.chooseWriteRegister();
    const rt = this.chooseReadRegister();
    const rs = this.chooseReadRegister();
    this.emit(mnemonic, `${mnemonic} ${rd}, ${rt}, ${rs}`);

    const amount = this.regValue(rs) & 0x1f;
    const value = this.regValue(rt);
    if (mnemonic === 'sllv') {
      this.setRegister(rd, value << amount);
    } else if (mnemonic === 'srlv') {
      this.setRegister(rd, value >>> amount);
    } else {
      this.setRegister(rd, value >> amount);
    }
  }

  private emitLui(): void {
    const rt = this.chooseWriteRegister();
    const imm = this.rng.pick([0, 1, 0x7fff, 0x8000, 0xffff, this.rng.int(0, 0xffff)]);
    this.emit('lui', `lui ${rt}, ${formatUnsignedImmediate(imm)}`);
    this.setRegister(rt, imm << 16);
  }

  private emitLoad(mnemonic: string): void {
    const rt = this.chooseWriteRegister();
    const operand = this.memoryOperand(memoryAlignment(mnemonic));
    this.emit(mnemonic, `${mnemonic} ${rt}, ${operand.text}`);

    const address = operand.address;
    let value = 0;
    if (mnemonic === 'lb') {
      value = signExtend8(this.byteAt(address));
    } else if (mnemonic === 'lbu') {
      value = this.byteAt(address);
    } else if (mnemonic === 'lh') {
      value = signExtend16(this.halfAt(address));
    } else if (mnemonic === 'lhu') {
      value = this.halfAt(address);
    } else if (mnemonic === 'lwl' || mnemonic === 'lwr') {
      value = this.wordAt(address & ~3);
    } else {
      value = this.wordAt(address);
    }
    this.setRegister(rt, value);
  }

  private emitStore(mnemonic: string): void {
    const rt = this.chooseReadRegister();
    const operand = this.memoryOperand(memoryAlignment(mnemonic));
    this.emit(mnemonic, `${mnemonic} ${rt}, ${operand.text}`);

    const value = this.regValue(rt);
    const address = operand.address;
    if (mnemonic === 'sb') {
      this.writeByte(address, value & 0xff);
    } else if (mnemonic === 'sh') {
      this.writeByte(address, value & 0xff);
      this.writeByte(address + 1, (value >>> 8) & 0xff);
    } else {
      this.memory.set(address & ~3, value);
    }
  }

  private emitHiLoMultiply(mnemonic: string): void {
    const rs = this.chooseReadRegister();
    const rt = this.chooseReadRegister();
    this.emit(mnemonic, `${mnemonic} ${rs}, ${rt}`);

    const product = mnemonic.endsWith('u')
      ? BigInt(unsigned32(this.regValue(rs))) * BigInt(unsigned32(this.regValue(rt)))
      : BigInt(signed32(this.regValue(rs))) * BigInt(signed32(this.regValue(rt)));
    const low = Number(product & BigInt(0xffffffff));
    const high = Number((product >> BigInt(32)) & BigInt(0xffffffff));
    if (mnemonic === 'madd' || mnemonic === 'maddu') {
      const combined = (BigInt(unsigned32(this.hi)) << BigInt(32)) | BigInt(unsigned32(this.lo));
      const next = combined + product;
      this.hi = Number((next >> BigInt(32)) & BigInt(0xffffffff));
      this.lo = Number(next & BigInt(0xffffffff));
    } else if (mnemonic === 'msub' || mnemonic === 'msubu') {
      const combined = (BigInt(unsigned32(this.hi)) << BigInt(32)) | BigInt(unsigned32(this.lo));
      const next = combined - product;
      this.hi = Number((next >> BigInt(32)) & BigInt(0xffffffff));
      this.lo = Number(next & BigInt(0xffffffff));
    } else {
      this.hi = high;
      this.lo = low;
    }
    this.markHiLoWritten();
  }

  private emitDivide(mnemonic: string): void {
    const rs = mnemonic === 'div' ? this.chooseSmallReadRegister() : this.chooseReadRegister();
    const rt = this.rng.pick(this.nonZeroRegisters(mnemonic === 'div'));
    this.emit(mnemonic, `${mnemonic} ${rs}, ${rt}`);

    const left = mnemonic === 'div' ? signed32(this.regValue(rs)) : unsigned32(this.regValue(rs));
    const right = mnemonic === 'div' ? signed32(this.regValue(rt)) : unsigned32(this.regValue(rt));
    if (right !== 0) {
      this.lo = signed32(Math.trunc(left / right));
      this.hi = signed32(left % right);
    }
    this.markHiLoWritten();
  }

  private emitHiLoRead(mnemonic: string): void {
    const rd = this.chooseWriteRegister();
    this.emit(mnemonic, `${mnemonic} ${rd}`);
    this.setRegister(rd, mnemonic === 'mfhi' ? this.hi : this.lo);
    this.pendingHiLoRead = false;
  }

  private emitHiLoWrite(mnemonic: string): void {
    const rs = this.chooseReadRegister();
    this.emit(mnemonic, `${mnemonic} ${rs}`);
    if (mnemonic === 'mthi') {
      this.hi = this.regValue(rs);
    } else {
      this.lo = this.regValue(rs);
    }
    this.markHiLoWritten();
  }

  private emitConditionalMove(mnemonic: string): void {
    const rd = this.chooseWriteRegister();
    const rs = this.chooseReadRegister();
    const candidates = mnemonic === 'movn' ? this.nonZeroRegisters(false) : ['$0', ...this.zeroRegisters()];
    const rt = candidates.length ? this.rng.pick(candidates) : '$0';
    this.emit(mnemonic, `${mnemonic} ${rd}, ${rs}, ${rt}`);

    const condition = mnemonic === 'movn' ? this.regValue(rt) !== 0 : this.regValue(rt) === 0;
    if (condition) {
      this.setRegister(rd, this.regValue(rs));
    }
  }

  private emitCountBits(mnemonic: string): void {
    const rd = this.chooseWriteRegister();
    const rs = this.chooseReadRegister();
    this.emit(mnemonic, `${mnemonic} ${rd}, ${rs}`);
    const value = unsigned32(this.regValue(rs));
    this.setRegister(rd, mnemonic === 'clz' ? clz32(value) : clo32(value));
  }

  private emitCp0(mnemonic: string): void {
    if (mnemonic === 'mfc0') {
      const rt = this.chooseWriteRegister();
      const cp0 = this.rng.pick(['$12', '$13', '$14', '$15', '$8']);
      this.emit(mnemonic, `mfc0 ${rt}, ${cp0}`);
      this.setRegister(rt, 0);
      return;
    }

    const rt = this.chooseReadRegister();
    const cp0 = this.rng.pick(['$12', '$14']);
    this.emit(mnemonic, `mtc0 ${rt}, ${cp0}`);
  }

  private emitTrapRegister(mnemonic: string): void {
    const operands = this.falseTrapRegisterOperands(mnemonic);
    if (!operands) {
      throw new BuiltinAsmGeneratorError(`Cannot emit non-throwing ${mnemonic}; add a value-producing instruction such as ori/addiu first.`);
    }
    this.emit(mnemonic, `${mnemonic} ${operands[0]}, ${operands[1]}`);
  }

  private emitTrapImmediate(mnemonic: string): void {
    const [rs, imm] = falseTrapImmediateOperands(mnemonic);
    this.emit(mnemonic, `${mnemonic} ${rs}, ${imm}`);
  }

  private emitControl(mnemonic: ControlMnemonic): void {
    if (branchMnemonics.has(mnemonic)) {
      this.emitBranch(mnemonic);
      return;
    }
    if (mnemonic === 'j' || mnemonic === 'jal') {
      this.emitJump(mnemonic);
      return;
    }
    if (mnemonic === 'jr' || mnemonic === 'jalr') {
      this.emitRegisterJump(mnemonic);
      return;
    }
    throw new BuiltinAsmGeneratorError(`Unsupported control instruction: ${mnemonic}.`);
  }

  private emitBranch(mnemonic: ControlMnemonic): void {
    const label = this.nextLabel('br');
    const operands = this.branchOperands(mnemonic);
    const canSkip = this.remaining() > 1 + this.delaySlotCost() && this.hasNoStateProbeCandidate();
    const skipProbe = canSkip && this.rng.chance(0.55);

    this.emit(mnemonic, `${mnemonic} ${operands.join(', ')}, ${label}`);
    if (linkBranchMnemonics.has(mnemonic) && operands.length > 0) {
      this.setRegister('$31', this.currentPc() + (this.usesDelaySlot() ? 4 : 0));
    }
    if (this.usesDelaySlot()) {
      this.emitDelaySlot();
    }
    if (skipProbe && this.remaining() > 0) {
      this.emitSkippedProbeInstruction();
    }
    this.addLabel(label);
  }

  private emitJump(mnemonic: 'j' | 'jal'): void {
    const label = this.nextLabel(mnemonic);
    const canSkip = this.remaining() > 1 + this.delaySlotCost() && this.hasNoStateProbeCandidate();
    const skipProbe = canSkip && this.rng.chance(0.7);

    this.emit(mnemonic, `${mnemonic} ${label}`);
    if (mnemonic === 'jal') {
      this.setRegister('$31', textBaseAddress + (this.emittedCount + this.delaySlotCost()) * 4);
    }
    if (this.usesDelaySlot()) {
      this.emitDelaySlot();
    }
    if (skipProbe && this.remaining() > 0) {
      this.emitSkippedProbeInstruction();
    }
    this.addLabel(label);
  }

  private emitRegisterJump(mnemonic: 'jr' | 'jalr'): void {
    const loader = this.addressLoaderMnemonic();
    if (!loader) {
      throw new BuiltinAsmGeneratorError(`${mnemonic} requires ori/addiu/addi in the configured instruction set so the generator can build a safe forward target address.`);
    }

    const label = this.nextLabel(mnemonic);
    const delayCost = this.delaySlotCost();
    const minCost = 2 + delayCost;
    const skipProbe = this.remaining() > minCost && this.rng.chance(0.7);
    const targetIndex = this.emittedCount + minCost + (skipProbe ? 1 : 0);
    const targetAddress = textBaseAddress + targetIndex * 4;
    const targetRegister = '$25';

    this.emitAddressLoad(loader, targetRegister, targetAddress);
    if (mnemonic === 'jr') {
      this.emit('jr', `jr ${targetRegister}`);
    } else {
      this.emit('jalr', `jalr $31, ${targetRegister}`);
      this.setRegister('$31', textBaseAddress + (this.emittedCount + delayCost) * 4);
    }
    if (this.usesDelaySlot()) {
      this.emitDelaySlot();
    }
    if (skipProbe && this.remaining() > 0) {
      this.emitSkippedProbeInstruction();
    }
    this.addLabel(label);
  }

  private emitDelaySlot(): void {
    const mnemonic = this.pickDelaySlotMnemonic();
    if (!mnemonic) {
      throw new BuiltinAsmGeneratorError('No safe non-control instruction is available for a delay slot.');
    }
    this.emitSingle(mnemonic);
  }

  private emitSkippedProbeInstruction(): void {
    const mnemonic = this.pickNoStateProbeMnemonic();
    if (!mnemonic) {
      return;
    }
    this.emitNoStateProbe(mnemonic);
  }

  private pickDelaySlotMnemonic(): string | undefined {
    const preferred = ['addu', 'subu', 'ori', 'addiu', 'sll', 'srl', 'and', 'or', 'xor', 'slt', 'lw', 'sw'];
    const candidates = preferred
      .filter((mnemonic) => this.allowed.has(mnemonic) && this.canEmitSingle(mnemonic));
    if (candidates.length) {
      return this.rng.pick(candidates);
    }
    return this.rng.pick(Array.from(this.allowed).filter((mnemonic) => !controlMnemonics.has(mnemonic) && this.canEmitSingle(mnemonic)));
  }

  private hasNoStateProbeCandidate(): boolean {
    return this.noStateProbeCandidates().length > 0;
  }

  private pickNoStateProbeMnemonic(): string | undefined {
    const candidates = this.noStateProbeCandidates();
    return candidates.length ? this.rng.pick(candidates) : undefined;
  }

  private noStateProbeCandidates(): string[] {
    const preferred = [
      'sll', 'srl', 'sra', 'addu', 'subu', 'and', 'or', 'xor', 'nor', 'slt', 'sltu',
      'addiu', 'andi', 'ori', 'xori', 'slti', 'sltiu',
      'lw', 'lb', 'lbu', 'lh', 'lhu', 'mfhi', 'mflo', 'mfc0', 'nop'
    ];
    return preferred.filter((mnemonic) =>
      this.allowed.has(mnemonic) &&
      !controlMnemonics.has(mnemonic) &&
      this.canEmitSingle(mnemonic) &&
      (mnemonic !== 'mfc0' || this.profile === 'P7')
    );
  }

  private emitNoStateProbe(mnemonic: string): void {
    if (mnemonic === 'nop') {
      this.emitNop();
      return;
    }
    if (mnemonic === 'sll' || mnemonic === 'srl' || mnemonic === 'sra') {
      this.emit(mnemonic, `${mnemonic} $0, ${this.chooseReadRegister()}, ${this.rng.int(0, 31)}`);
      return;
    }
    if (mnemonic === 'addiu' || mnemonic === 'andi' || mnemonic === 'ori' || mnemonic === 'xori' || mnemonic === 'slti' || mnemonic === 'sltiu') {
      this.emit(mnemonic, `${mnemonic} $0, ${this.chooseReadRegister()}, ${formatImmediate(this.immediateFor(mnemonic))}`);
      return;
    }
    if (mnemonic === 'lw' || mnemonic === 'lb' || mnemonic === 'lbu' || mnemonic === 'lh' || mnemonic === 'lhu') {
      const operand = this.memoryOperand(memoryAlignment(mnemonic));
      this.emit(mnemonic, `${mnemonic} $0, ${operand.text}`);
      return;
    }
    if (mnemonic === 'mfhi' || mnemonic === 'mflo') {
      this.emit(mnemonic, `${mnemonic} $0`);
      return;
    }
    if (mnemonic === 'mfc0') {
      this.emit(mnemonic, `mfc0 $0, ${this.rng.pick(['$12', '$13', '$14', '$15', '$8'])}`);
      return;
    }
    this.emit(mnemonic, `${mnemonic} $0, ${this.chooseReadRegister()}, ${this.chooseReadRegister()}`);
  }

  private branchOperands(mnemonic: ControlMnemonic): string[] {
    if (mnemonic === 'beq') {
      if (this.rng.chance(0.5)) {
        const reg = this.chooseReadRegister();
        return [reg, reg];
      }
      return this.differentRegisterPair() ?? ['$0', '$0'];
    }
    if (mnemonic === 'bne') {
      return this.rng.chance(0.5)
        ? (this.differentRegisterPair() ?? ['$0', '$0'])
        : ['$0', '$0'];
    }
    if (mnemonic === 'bgez' || mnemonic === 'bgezal') {
      return [this.rng.pick([...this.nonNegativeRegisters(), '$0'])];
    }
    if (mnemonic === 'bgtz') {
      const positives = this.positiveRegisters();
      return [positives.length && this.rng.chance(0.6) ? this.rng.pick(positives) : '$0'];
    }
    if (mnemonic === 'blez') {
      return [this.rng.pick([...this.nonPositiveRegisters(), '$0'])];
    }
    if (mnemonic === 'bltz' || mnemonic === 'bltzal') {
      const negatives = this.negativeRegisters();
      return [negatives.length && this.rng.chance(0.6) ? this.rng.pick(negatives) : '$0'];
    }
    return ['$0'];
  }

  private emitAddressLoad(mnemonic: string, register: string, address: number): void {
    if (mnemonic === 'ori') {
      this.emit('ori', `ori ${register}, $0, ${formatUnsignedImmediate(address)}`);
      this.setRegister(register, address);
    } else {
      this.emit(mnemonic, `${mnemonic} ${register}, $0, ${address}`);
      this.setRegister(register, address);
    }
  }

  private addressLoaderMnemonic(): string | undefined {
    for (const mnemonic of ['ori', 'addiu', 'addi']) {
      if (this.allowed.has(mnemonic) && this.canEmitSingle(mnemonic)) {
        return mnemonic;
      }
    }
    return undefined;
  }

  private immediateFor(mnemonic: string): number {
    if (mnemonic === 'andi' || mnemonic === 'ori' || mnemonic === 'xori') {
      return this.rng.pick([0, 1, 2, 3, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, this.rng.int(0, 0xffff)]);
    }
    if (mnemonic === 'sltiu') {
      return this.rng.pick([0, 1, 2, 0x7fff, -1, this.rng.int(-64, 128)]);
    }
    return this.rng.pick([-32768, -129, -1, 0, 1, 2, 3, 127, 128, 32767, this.rng.int(-256, 256)]);
  }

  private chooseWriteRegister(): string {
    if (this.rng.chance(0.08)) {
      return '$0';
    }
    return this.rng.pick(writableRegisters);
  }

  private chooseReadRegister(): string {
    const recent = this.recentWrites.filter((register) => register !== '$0');
    if (recent.length && this.rng.chance(this.pipelineProfile() ? 0.62 : 0.35)) {
      return this.rng.pick(recent.slice(0, 4));
    }
    return this.rng.pick(readRegisters);
  }

  private chooseSmallReadRegister(): string {
    const small = readRegisters.filter((register) => Math.abs(signed32(this.regValue(register))) <= 0x2000);
    if (small.length) {
      return this.rng.pick(small);
    }
    return '$0';
  }

  private nonZeroRegisters(avoidSignedMinusOne: boolean): string[] {
    return readRegisters.filter((register) => {
      const value = this.regValue(register);
      return value !== 0 && (!avoidSignedMinusOne || signed32(value) !== -1);
    });
  }

  private zeroRegisters(): string[] {
    return readRegisters.filter((register) => this.regValue(register) === 0);
  }

  private positiveRegisters(): string[] {
    return readRegisters.filter((register) => signed32(this.regValue(register)) > 0);
  }

  private negativeRegisters(): string[] {
    return readRegisters.filter((register) => signed32(this.regValue(register)) < 0);
  }

  private nonNegativeRegisters(): string[] {
    return readRegisters.filter((register) => signed32(this.regValue(register)) >= 0);
  }

  private nonPositiveRegisters(): string[] {
    return readRegisters.filter((register) => signed32(this.regValue(register)) <= 0);
  }

  private differentRegisterPair(): [string, string] | undefined {
    for (const left of readRegisters) {
      for (const right of readRegisters) {
        if (this.regValue(left) !== this.regValue(right)) {
          return this.rng.chance(0.5) ? [left, right] : [right, left];
        }
      }
    }
    return undefined;
  }

  private falseTrapRegisterOperands(mnemonic: string): [string, string] | undefined {
    if (mnemonic === 'tne') {
      const reg = this.chooseReadRegister();
      return [reg, reg];
    }
    for (const rs of readRegisters) {
      for (const rt of readRegisters) {
        const left = this.regValue(rs);
        const right = this.regValue(rt);
        if (
          (mnemonic === 'teq' && left !== right) ||
          (mnemonic === 'tge' && signed32(left) < signed32(right)) ||
          (mnemonic === 'tgeu' && unsigned32(left) < unsigned32(right)) ||
          (mnemonic === 'tlt' && signed32(left) >= signed32(right)) ||
          (mnemonic === 'tltu' && unsigned32(left) >= unsigned32(right))
        ) {
          return [rs, rt];
        }
      }
    }
    return undefined;
  }

  private memoryOperand(alignment: number): { text: string; address: number } {
    const baseCandidates = readRegisters
      .map((register) => ({ register, value: this.regValue(register) }))
      .filter((item) => item.value >= 0 && item.value < dataByteLength && item.value % alignment === 0);
    const useBase = baseCandidates.length > 1 && this.rng.chance(0.25);
    const base = useBase ? this.rng.pick(baseCandidates) : { register: '$0', value: 0 };
    const maxOffset = dataByteLength - alignment - base.value;
    const rawOffset = Math.max(0, this.rng.int(0, Math.max(0, maxOffset)));
    const offset = alignDown(rawOffset, alignment);
    const address = base.value + offset;
    return {
      text: `${offset}(${base.register})`,
      address
    };
  }

  private wordAt(address: number): number {
    return this.memory.get(address & ~3) ?? 0;
  }

  private halfAt(address: number): number {
    return this.byteAt(address) | (this.byteAt(address + 1) << 8);
  }

  private byteAt(address: number): number {
    const word = this.wordAt(address);
    const shift = (address & 3) * 8;
    return (word >>> shift) & 0xff;
  }

  private writeByte(address: number, value: number): void {
    const aligned = address & ~3;
    const shift = (address & 3) * 8;
    const mask = ~(0xff << shift);
    const previous = this.wordAt(aligned);
    this.memory.set(aligned, (previous & mask) | ((value & 0xff) << shift));
  }

  private setRegister(register: string, value: number): void {
    if (register === '$0') {
      this.regs.set('$0', 0);
      return;
    }
    const normalized = signed32(value);
    this.regs.set(register, normalized);
    this.recentWrites.unshift(register);
    while (this.recentWrites.length > 8) {
      this.recentWrites.pop();
    }
  }

  private regValue(register: string): number {
    return this.regs.get(register) ?? 0;
  }

  private markHiLoWritten(): void {
    this.pendingHiLoRead = this.allowed.has('mfhi') || this.allowed.has('mflo');
  }

  private emit(mnemonic: string, text: string): void {
    if (this.remaining() <= 0) {
      throw new BuiltinAsmGeneratorError('Internal generator error: attempted to emit past the requested instruction count.');
    }
    this.lines.push(`    ${text}`);
    this.emittedCount++;
    this.used.add(mnemonic);
  }

  private addLabel(label: string): void {
    this.lines.push(`${label}:`);
  }

  private nextLabel(prefix: string): string {
    this.labelIndex++;
    return `_co_${prefix}_${this.labelIndex}`;
  }

  private remaining(): number {
    return this.targetCount - this.emittedCount;
  }

  private currentPc(): number {
    return textBaseAddress + this.emittedCount * 4;
  }

  private usesDelaySlot(): boolean {
    return this.profile === 'P5' || this.profile === 'P6' || this.profile === 'P7';
  }

  private delaySlotCost(): number {
    return this.usesDelaySlot() ? 1 : 0;
  }

  private pipelineProfile(): boolean {
    return this.profile === 'P5' || this.profile === 'P6' || this.profile === 'P7';
  }

  private shuffle<T>(items: T[]): T[] {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.rng.int(0, i);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}

function falseTrapImmediateOperands(mnemonic: string): [string, string] {
  switch (mnemonic) {
    case 'teqi':
      return ['$0', '1'];
    case 'tnei':
      return ['$0', '0'];
    case 'tgei':
    case 'tgeiu':
      return ['$0', '1'];
    case 'tlti':
      return ['$0', '-1'];
    case 'tltiu':
      return ['$0', '0'];
    default:
      return ['$0', '0'];
  }
}

function memoryAlignment(mnemonic: string): number {
  if (mnemonic === 'lw' || mnemonic === 'sw' || mnemonic === 'lwl' || mnemonic === 'lwr' || mnemonic === 'swl' || mnemonic === 'swr') {
    return 4;
  }
  if (mnemonic === 'lh' || mnemonic === 'lhu' || mnemonic === 'sh') {
    return 2;
  }
  return 1;
}

function formatImmediate(value: number): string {
  if (value < 0) {
    return String(value);
  }
  return value > 9 ? `0x${value.toString(16)}` : String(value);
}

function formatUnsignedImmediate(value: number): string {
  return value > 9 ? `0x${(value & 0xffff).toString(16)}` : String(value);
}

function alignDown(value: number, alignment: number): number {
  return Math.floor(value / alignment) * alignment;
}

function signed32(value: number): number {
  return value | 0;
}

function unsigned32(value: number): number {
  return value >>> 0;
}

function signExtend8(value: number): number {
  return (value << 24) >> 24;
}

function signExtend16(value: number): number {
  return (value << 16) >> 16;
}

function clz32(value: number): number {
  return Math.clz32(value);
}

function clo32(value: number): number {
  return Math.clz32(~value >>> 0);
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed || 0x12345678;
  }

  nextInt(): number {
    this.state += 0x6d2b79f5;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  next(): number {
    return this.nextInt() / 0x100000000;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (!items.length) {
      throw new BuiltinAsmGeneratorError('Internal generator error: attempted to pick from an empty list.');
    }
    return items[this.int(0, items.length - 1)];
  }
}
