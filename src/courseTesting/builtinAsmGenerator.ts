import { ProjectProfile } from '../projectProfile';
import {
  instructions,
  MipsInstruction
} from '../language/mips/resources';
import { CpuState } from './cpuState';
import {
  CpuProfile,
  MduReadProbeMode,
  ControlMnemonic,
  cpuProfiles,
  defaultInstructionSets,
  supportedMnemonics,
  controlMnemonics,
  branchMnemonics,
  linkBranchMnemonics,
  jumpLinkMnemonics,
  divideMnemonics,
  hiLoWriteMnemonics,
  hiLoReadMnemonics,
  longLatencyHiLoWriteMnemonics,
  loadMnemonics,
  storeMnemonics,
  falseTrapImmediateOperands,
  memoryAlignment,
  mduBusyCycles
} from './mnemonicSets';
import {
  signed32,
  unsigned32,
  signExtend8,
  signExtend16,
  clz32,
  clo32,
  formatImmediate,
  formatUnsignedImmediate,
  alignDown
} from './mipsUtil';
import { Random, hashSeed } from './random';

export interface BuiltinAsmGeneratorOptions {
  profile: ProjectProfile;
  instructionText: string;
  instructionCount: number;
  seed?: string;
  generatedAt?: Date;
  /** P7: inject an external interrupt scheduled at a generated "safe" PC. */
  interrupt?: boolean;
  /** P7: probability per body slot to emit a controllable internal exception (0..1). */
  exceptionRate?: number;
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
  /** P7 external-interrupt target PCs (committed-PC trigger); empty when none. */
  interruptSchedule: number[];
}

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
const p7ExceptionHandlerAddress = 0x4180;
const p7ExceptionHandlerInstructionIndex = (p7ExceptionHandlerAddress - textBaseAddress) / 4;
const p7MainTerminatorInstructionCount = 2;
const poisonRegister = '$26';
// The unified P7 handler (interrupt + exception) needs these CP0 instructions in the set.
const p7HandlerRequiredMnemonics = ['mfc0', 'mtc0', 'eret'] as const;
// SR value the prologue installs: IE=1 (bit0) + IM[2]=1 (bit12, the external-interrupt mask).
const p7StatusEnableInterrupts = 0x1001;
const p7IntAckAddress = 0x7f20;
// Simple, value-producing ALU/immediate ops that are safe to interrupt (no control/memory side
// effects that complicate the precise-interrupt point). Used to pick the external-interrupt target.
const safeInterruptTargetMnemonics = new Set<string>([
  'add', 'addu', 'sub', 'subu', 'and', 'or', 'xor', 'nor', 'slt', 'sltu',
  'addi', 'addiu', 'andi', 'ori', 'xori', 'slti', 'sltiu',
  'sll', 'srl', 'sra', 'sllv', 'srlv', 'srav', 'lui'
]);

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
  const interrupt = instructionSet.profile === 'P7' && options.interrupt === true;
  const exceptionRate = instructionSet.profile === 'P7' ? clamp01(options.exceptionRate ?? 0) : 0;
  validateBuiltinGeneratorRequest(instructionSet, count, { interrupt, exceptionRate });
  const seed = options.seed && options.seed.trim()
    ? options.seed.trim()
    : `${Date.now()}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
  const generator = new ProgramGenerator(
    instructionSet.profile,
    instructionSet.mnemonics,
    count,
    seed,
    options.generatedAt ?? new Date(),
    { interrupt, exceptionRate }
  );
  return generator.generate();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value >= 1 ? 1 : value;
}

function validateBuiltinGeneratorRequest(
  instructionSet: BuiltinInstructionSet,
  count: number,
  options: { interrupt: boolean; exceptionRate: number }
): void {
  const allowed = new Set(instructionSet.mnemonics);
  const isP7 = instructionSet.profile === 'P7';
  if (isP7) {
    const p7MaxCount = p7CourseInstructionCountMaximum();
    if (count > p7MaxCount) {
      throw new BuiltinAsmGeneratorError(`P7 generated instruction count must be at most ${p7MaxCount}, because 0x${p7ExceptionHandlerAddress.toString(16)} is reserved for the course exception entry.`);
    }
  }
  if (allowed.has('syscall') && !isP7) {
    throw new BuiltinAsmGeneratorError('Built-in ASM generator supports syscall only for P7.');
  }
  const handlerEnabled = isP7 && (options.interrupt || options.exceptionRate > 0 || allowed.has('syscall'));
  if (allowed.has('eret') && !handlerEnabled) {
    throw new BuiltinAsmGeneratorError('Built-in ASM generator emits eret only inside the P7 exception handler; enable syscall, interrupt, or exceptions to exercise it.');
  }
  if (handlerEnabled) {
    const missing = p7HandlerRequiredMnemonics.filter((mnemonic) => !allowed.has(mnemonic));
    if (missing.length) {
      throw new BuiltinAsmGeneratorError(`Built-in ASM generator P7 exception handler requires instruction(s): ${missing.join(', ')}.`);
    }
  }
}

function p7CourseInstructionCountMaximum(): number {
  return p7ExceptionHandlerInstructionIndex - p7MainTerminatorInstructionCount;
}

class ProgramGenerator {
  private readonly rng: Random;
  private readonly allowed: Set<string>;
  private readonly profile: CpuProfile;
  private readonly targetCount: number;
  private readonly seed: string;
  private readonly generatedAt: Date;
  private readonly interruptEnabled: boolean;
  private readonly exceptionRate: number;
  private readonly p7HandlerEnabled: boolean;
  private readonly state = new CpuState();
  private readonly lines: string[] = [];
  private readonly used = new Set<string>();
  /** Indices (0-based instruction positions) that are safe external-interrupt targets. */
  private readonly interruptCandidates: number[] = [];
  private labelIndex = 0;
  private emittedCount = 0;
  private nextMduProbeMode: MduReadProbeMode = 'busy';

  constructor(
    profile: CpuProfile,
    mnemonics: string[],
    targetCount: number,
    seed: string,
    generatedAt: Date,
    options: { interrupt: boolean; exceptionRate: number } = { interrupt: false, exceptionRate: 0 }
  ) {
    this.profile = profile;
    this.allowed = new Set(mnemonics);
    this.targetCount = targetCount;
    this.seed = seed;
    this.generatedAt = generatedAt;
    this.interruptEnabled = profile === 'P7' && options.interrupt;
    this.exceptionRate = profile === 'P7' ? options.exceptionRate : 0;
    this.p7HandlerEnabled = profile === 'P7'
      && (this.interruptEnabled || this.exceptionRate > 0 || this.allowed.has('syscall'));
    this.rng = new Random(hashSeed(`${profile}:${targetCount}:${seed}:${options.interrupt ? 'i' : ''}:${this.exceptionRate}`));
    this.nextMduProbeMode = this.rng.chance(0.5) ? 'busy' : 'ready';
  }

  generate(): BuiltinAsmGeneratorResult {
    if (this.p7HandlerEnabled) {
      this.emitP7Prologue();
    }

    const coverageQueue = this.shuffle(Array.from(this.allowed));
    let guard = this.targetCount * 30 + 200;

    while (this.remaining() > 0 && guard-- > 0) {
      if (this.wantsExceptionInjection() && this.emitException()) {
        continue;
      }

      const mnemonic = this.pickCoverageMnemonic(coverageQueue)
        ?? this.pickBiasedMnemonic()
        ?? this.pickAnyMnemonic();
      if (!mnemonic) {
        throw new BuiltinAsmGeneratorError('Built-in ASM generator could not fill the requested instruction count with the configured instruction set. Add a safe value-producing instruction such as ori/addiu/addu, or reduce control/MDU-only instructions.');
      }
      const startIndex = this.emittedCount;
      this.emitMnemonic(mnemonic);
      this.noteInterruptCandidate(mnemonic, startIndex);
    }

    if (this.emittedCount !== this.targetCount) {
      throw new BuiltinAsmGeneratorError(`Built-in ASM generator emitted ${this.emittedCount} instruction(s), expected ${this.targetCount}.`);
    }

    const interruptSchedule = this.interruptEnabled ? this.chooseInterruptSchedule() : [];

    return {
      text: this.render(),
      seed: this.seed,
      profile: this.profile,
      instructionSet: Array.from(this.allowed).sort(),
      instructionCount: this.emittedCount,
      usedInstructions: Array.from(this.used).sort(),
      interruptSchedule
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
      ...this.renderP7ExceptionHandler(),
      ''
    ].join('\n');
  }

  private renderP7ExceptionHandler(): string[] {
    if (!this.p7HandlerEnabled) {
      return [];
    }
    // Unified P7 handler at 0x4180.
    // 1. Acknowledge/clear the external interrupt by writing 0x7F20 FIRST. This both stops the
    //    Verilog testbench from re-raising `interrupt` (no storm) and clears Cause.IP[2] before
    //    we read Cause, so MARS (auto-clears IP at exception entry) and the CPU (holds the level
    //    until the ack) agree on the traced Cause value.
    // 2. Read Cause; if ExcCode == 0 (external interrupt) just eret (re-execute the deferred
    //    instruction). Otherwise advance EPC by 4 to skip the faulting instruction.
    // Only $k0/$k1 ($26/$27) are touched; generated user code never reads them, so the handler
    // is transparent to user-visible state. eret has no delay slot.
    return [
      '.ktext 0x4180',
      '_co_excep:',
      `    ori $k0, $0, 0x${p7IntAckAddress.toString(16)}`,
      '    sw $0, 0($k0)',
      '    mfc0 $k0, $13',
      '    andi $k1, $k0, 0x7c',
      '    beq $k1, $0, _co_excep_ret',
      '    nop',
      '    mfc0 $k0, $14',
      '    addi $k0, $k0, 4',
      '    mtc0 $k0, $14',
      '_co_excep_ret:',
      '    eret'
    ];
  }

  private emitP7Prologue(): void {
    // Install SR = 0x1001 (IE=1, IM[2]=1) before any body instruction so the external interrupt
    // can be taken and so mfc0 $12 reads agree between MARS (reset 0x0000FF11) and the Verilog
    // CPU (reset 0). Emitted as static instructions: $k0 must not enter the read-candidate pool.
    this.emitStaticInstruction('ori', `ori $k0, $0, 0x${p7StatusEnableInterrupts.toString(16)}`);
    this.emitStaticInstruction('mtc0', `mtc0 $k0, $12`);
    this.state.cp0_sr = p7StatusEnableInterrupts;
  }

  private wantsExceptionInjection(): boolean {
    if (this.exceptionRate <= 0 || !this.p7HandlerEnabled) {
      return false;
    }
    // Leave room: the faulting instruction takes a slot and must not be the last body slot.
    if (this.remaining() <= 2) {
      return false;
    }
    // Don't perturb a pending MDU read window or a delay-slot obligation.
    if (this.state.pendingHiLoRead || this.state.mduProtectedSlots > 0) {
      return false;
    }
    return this.rng.chance(this.exceptionRate);
  }

  private emitException(): boolean {
    const kinds = this.availableExceptionKinds();
    if (!kinds.length) {
      return false;
    }
    this.rng.pick(kinds)();
    return true;
  }

  // Each kind emits exactly one faulting instruction with NO modeled state change: the handler
  // skips it (EPC += 4), so the destination register / memory is never written. Both MARS and a
  // correct P7 CPU detect the same exception on the same instruction, so the (empty) effect and
  // the handler trace align.
  private availableExceptionKinds(): Array<() => void> {
    const kinds: Array<() => void> = [];
    if (this.allowed.has('syscall')) {
      kinds.push(() => this.emitStaticInstruction('syscall', 'syscall'));
    }
    const load = ['lw', 'lh', 'lhu'].find((mnemonic) => this.allowed.has(mnemonic));
    if (load) {
      kinds.push(() => this.emitStaticInstruction(load, `${load} ${this.chooseWriteRegister()}, 1($0)`)); // AdEL: misaligned
    }
    const store = ['sw', 'sh'].find((mnemonic) => this.allowed.has(mnemonic));
    if (store) {
      kinds.push(() => this.emitStaticInstruction(store, `${store} ${this.chooseReadRegister()}, 1($0)`)); // AdES: misaligned
    }
    const overflow = this.overflowException();
    if (overflow) {
      kinds.push(overflow);
    }
    return kinds;
  }

  private overflowException(): (() => void) | undefined {
    const overflows = (value: number): boolean => value > 0x7fffffff || value < -0x80000000;
    if (this.allowed.has('add') || this.allowed.has('sub')) {
      const useSub = !this.allowed.has('add');
      for (const rs of readRegisters) {
        for (const rt of readRegisters) {
          const a = signed32(this.state.regValue(rs));
          const b = signed32(this.state.regValue(rt));
          if (overflows(useSub ? a - b : a + b)) {
            const op = useSub ? 'sub' : 'add';
            return () => this.emitStaticInstruction(op, `${op} ${this.chooseWriteRegister()}, ${rs}, ${rt}`);
          }
        }
      }
    }
    if (this.allowed.has('addi')) {
      for (const rs of readRegisters) {
        const a = signed32(this.state.regValue(rs));
        for (const imm of [0x7fff, -0x8000]) {
          if (overflows(a + imm)) {
            return () => this.emitStaticInstruction('addi', `addi ${this.chooseWriteRegister()}, ${rs}, ${formatImmediate(imm)}`);
          }
        }
      }
    }
    return undefined;
  }

  private noteInterruptCandidate(mnemonic: string, startIndex: number): void {
    if (!this.interruptEnabled) {
      return;
    }
    // Only a simple value-producing op that emitted exactly one instruction is a safe target.
    if (safeInterruptTargetMnemonics.has(mnemonic) && this.emittedCount === startIndex + 1) {
      this.interruptCandidates.push(startIndex);
    }
  }

  private chooseInterruptSchedule(): number[] {
    // Require a contiguous safe pair (k, k+1) of always-executed simple instructions. The schedule
    // value is the testbench target_pc = the architectural instruction the CPU defers (its EPC),
    // which is k+1. MARS fires p7irq one instruction earlier (at k) — see buildMarsArgs — because
    // its prevIRQ injection commits the p7irq instruction and defers the next one, whereas the CPU
    // samples the interrupt against the M-stage macroscopic_pc and defers that instruction. Both
    // ends therefore defer k+1, and both k and k+1 are simple ops (so Cause.BD=0 and the precise
    // interrupt point is unambiguous).
    const candidateSet = new Set(this.interruptCandidates);
    const contiguous = this.interruptCandidates.filter((index) => candidateSet.has(index + 1)).sort((a, b) => a - b);
    if (!contiguous.length) {
      return [];
    }
    const pick = contiguous[Math.floor(contiguous.length / 2)];
    return [textBaseAddress + (pick + 1) * 4];
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
    if (this.state.pendingHiLoRead) {
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
      if (hiLoReadMnemonics.has(mnemonic) && this.state.pendingHiLoRead) {
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
    if (this.state.mduProtectedSlots > 0 && hiLoWriteMnemonics.has(mnemonic)) {
      return false;
    }
    if (divideMnemonics.has(mnemonic)) {
      return this.nonZeroRegisters(mnemonic === 'div').length > 0;
    }
    if (mnemonic === 'teq' || mnemonic === 'tge' || mnemonic === 'tgeu' || mnemonic === 'tlt' || mnemonic === 'tltu') {
      return this.falseTrapRegisterOperands(mnemonic) !== undefined;
    }
    if (mnemonic === 'mfc0') {
      // Body only reads Status ($12); EPC/Cause reads are left to the fixed handler.
      return this.profile === 'P7';
    }
    if (mnemonic === 'mtc0') {
      // Never generated in the body: mtc0 is reserved for the fixed prologue/handler so that
      // Status stays at p7StatusEnableInterrupts and the model can predict mfc0 $12 reads.
      return false;
    }
    if (mnemonic === 'syscall') {
      return this.p7HandlerEnabled;
    }
    if (mnemonic === 'eret') {
      return false;
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
    return Array.from(this.allowed).some((mnemonic) =>
      !controlMnemonics.has(mnemonic) && mnemonic !== 'syscall' && this.canEmitSingle(mnemonic));
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
      case 'syscall':
        this.emitSyscall();
        return;
      case 'eret':
        throw new BuiltinAsmGeneratorError('Built-in ASM generator emits eret only inside the P7 exception handler.');
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

    const left = this.state.regValue(rs);
    const right = this.state.regValue(rt);
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
    this.state.setRegister(rd, value);
  }

  private emitImmediate(mnemonic: string): void {
    const rt = this.chooseWriteRegister();
    const rs = mnemonic === 'addi'
      ? this.chooseSmallReadRegister()
      : this.chooseReadRegister();
    const imm = this.immediateFor(mnemonic);
    this.emit(mnemonic, `${mnemonic} ${rt}, ${rs}, ${formatImmediate(imm)}`);

    const left = this.state.regValue(rs);
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
    this.state.setRegister(rt, value);
  }

  private emitShift(mnemonic: string): void {
    const rd = this.chooseWriteRegister();
    const rt = this.chooseReadRegister();
    const shamt = this.rng.int(0, 31);
    this.emit(mnemonic, `${mnemonic} ${rd}, ${rt}, ${shamt}`);

    const value = this.state.regValue(rt);
    if (mnemonic === 'sll') {
      this.state.setRegister(rd, value << shamt);
    } else if (mnemonic === 'srl') {
      this.state.setRegister(rd, value >>> shamt);
    } else {
      this.state.setRegister(rd, value >> shamt);
    }
  }

  private emitVariableShift(mnemonic: string): void {
    const rd = this.chooseWriteRegister();
    const rt = this.chooseReadRegister();
    const rs = this.chooseReadRegister();
    this.emit(mnemonic, `${mnemonic} ${rd}, ${rt}, ${rs}`);

    const amount = this.state.regValue(rs) & 0x1f;
    const value = this.state.regValue(rt);
    if (mnemonic === 'sllv') {
      this.state.setRegister(rd, value << amount);
    } else if (mnemonic === 'srlv') {
      this.state.setRegister(rd, value >>> amount);
    } else {
      this.state.setRegister(rd, value >> amount);
    }
  }

  private emitLui(): void {
    const rt = this.chooseWriteRegister();
    const imm = this.rng.pick([0, 1, 0x7fff, 0x8000, 0xffff, this.rng.int(0, 0xffff)]);
    this.emit('lui', `lui ${rt}, ${formatUnsignedImmediate(imm)}`);
    this.state.setRegister(rt, imm << 16);
  }

  private emitLoad(mnemonic: string): void {
    const rt = this.chooseWriteRegister();
    const operand = this.memoryOperand(memoryAlignment(mnemonic));
    this.emit(mnemonic, `${mnemonic} ${rt}, ${operand.text}`);

    const address = operand.address;
    let value = 0;
    if (mnemonic === 'lb') {
      value = signExtend8(this.state.byteAt(address));
    } else if (mnemonic === 'lbu') {
      value = this.state.byteAt(address);
    } else if (mnemonic === 'lh') {
      value = signExtend16(this.state.halfAt(address));
    } else if (mnemonic === 'lhu') {
      value = this.state.halfAt(address);
    } else if (mnemonic === 'lwl' || mnemonic === 'lwr') {
      value = this.state.wordAt(address & ~3);
    } else {
      value = this.state.wordAt(address);
    }
    this.state.setRegister(rt, value);
  }

  private emitStore(mnemonic: string): void {
    const rt = this.chooseReadRegister();
    const operand = this.memoryOperand(memoryAlignment(mnemonic));
    this.emit(mnemonic, `${mnemonic} ${rt}, ${operand.text}`);

    const value = this.state.regValue(rt);
    const address = operand.address;
    if (mnemonic === 'sb') {
      this.state.writeByte(address, value & 0xff);
    } else if (mnemonic === 'sh') {
      this.state.writeByte(address, value & 0xff);
      this.state.writeByte(address + 1, (value >>> 8) & 0xff);
    } else {
      this.state.memory.set(address & ~3, value);
    }
  }

  private emitHiLoMultiply(mnemonic: string): void {
    const rs = this.chooseReadRegister();
    const rt = this.chooseReadRegister();
    this.emit(mnemonic, `${mnemonic} ${rs}, ${rt}`);

    const product = mnemonic.endsWith('u')
      ? BigInt(unsigned32(this.state.regValue(rs))) * BigInt(unsigned32(this.state.regValue(rt)))
      : BigInt(signed32(this.state.regValue(rs))) * BigInt(signed32(this.state.regValue(rt)));
    const low = Number(product & BigInt(0xffffffff));
    const high = Number((product >> BigInt(32)) & BigInt(0xffffffff));
    if (mnemonic === 'madd' || mnemonic === 'maddu') {
      const combined = (BigInt(unsigned32(this.state.hi)) << BigInt(32)) | BigInt(unsigned32(this.state.lo));
      const next = combined + product;
      this.state.hi = Number((next >> BigInt(32)) & BigInt(0xffffffff));
      this.state.lo = Number(next & BigInt(0xffffffff));
    } else if (mnemonic === 'msub' || mnemonic === 'msubu') {
      const combined = (BigInt(unsigned32(this.state.hi)) << BigInt(32)) | BigInt(unsigned32(this.state.lo));
      const next = combined - product;
      this.state.hi = Number((next >> BigInt(32)) & BigInt(0xffffffff));
      this.state.lo = Number(next & BigInt(0xffffffff));
    } else {
      this.state.hi = high;
      this.state.lo = low;
    }
    this.markHiLoWritten();
    if (longLatencyHiLoWriteMnemonics.has(mnemonic)) {
      this.state.armMduProtection(mduBusyCycles(mnemonic));
      this.maybeEmitMduReadProbe(mnemonic);
    }
  }

  private emitDivide(mnemonic: string): void {
    const rs = mnemonic === 'div' ? this.chooseSmallReadRegister() : this.chooseReadRegister();
    const rt = this.rng.pick(this.nonZeroRegisters(mnemonic === 'div'));
    this.emit(mnemonic, `${mnemonic} ${rs}, ${rt}`);

    const left = mnemonic === 'div' ? signed32(this.state.regValue(rs)) : unsigned32(this.state.regValue(rs));
    const right = mnemonic === 'div' ? signed32(this.state.regValue(rt)) : unsigned32(this.state.regValue(rt));
    if (right !== 0) {
      this.state.lo = signed32(Math.trunc(left / right));
      this.state.hi = signed32(left % right);
    }
    this.markHiLoWritten();
    this.state.armMduProtection(mduBusyCycles(mnemonic));
    this.maybeEmitMduReadProbe(mnemonic);
  }

  private emitHiLoRead(mnemonic: string, forceVisibleWrite = false): void {
    const rd = forceVisibleWrite ? this.chooseVisibleWriteRegister() : this.chooseWriteRegister();
    this.emit(mnemonic, `${mnemonic} ${rd}`);
    this.state.setRegister(rd, mnemonic === 'mfhi' ? this.state.hi : this.state.lo);
    this.state.pendingHiLoRead = false;
  }

  private emitHiLoWrite(mnemonic: string): void {
    const rs = this.chooseReadRegister();
    this.emit(mnemonic, `${mnemonic} ${rs}`);
    if (mnemonic === 'mthi') {
      this.state.hi = this.state.regValue(rs);
    } else {
      this.state.lo = this.state.regValue(rs);
    }
    this.markHiLoWritten();
  }

  private emitConditionalMove(mnemonic: string): void {
    const rd = this.chooseWriteRegister();
    const rs = this.chooseReadRegister();
    const candidates = mnemonic === 'movn' ? this.nonZeroRegisters(false) : ['$0', ...this.zeroRegisters()];
    const rt = candidates.length ? this.rng.pick(candidates) : '$0';
    this.emit(mnemonic, `${mnemonic} ${rd}, ${rs}, ${rt}`);

    const condition = mnemonic === 'movn' ? this.state.regValue(rt) !== 0 : this.state.regValue(rt) === 0;
    if (condition) {
      this.state.setRegister(rd, this.state.regValue(rs));
    }
  }

  private emitCountBits(mnemonic: string): void {
    const rd = this.chooseWriteRegister();
    const rs = this.chooseReadRegister();
    this.emit(mnemonic, `${mnemonic} ${rd}, ${rs}`);
    const value = unsigned32(this.state.regValue(rs));
    this.state.setRegister(rd, mnemonic === 'clz' ? clz32(value) : clo32(value));
  }

  private emitCp0(mnemonic: string): void {
    // Only mfc0 $12 (Status) is generated. Status is held constant by the prologue, so the read
    // value is modelable and matches both MARS and the Verilog CPU. EPC/Cause reads and all mtc0
    // writes are left to the fixed prologue/handler (see canEmitSingle).
    if (mnemonic !== 'mfc0') {
      return;
    }
    const rt = this.chooseWriteRegister();
    this.emit('mfc0', `mfc0 ${rt}, $12`);
    this.state.setRegister(rt, this.state.cp0_sr);
  }

  private emitSyscall(): void {
    // syscall raises ExcCode 8; the handler advances EPC by 4 so execution resumes after it.
    // No user-visible (GPR/DM) state changes, so the software model treats it as a no-op.
    this.emit('syscall', 'syscall');
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
    const skipPoison = (
      this.remaining() > 1 + this.delaySlotCost() &&
      this.branchWillTake(mnemonic, operands) &&
      this.hasStatefulPoisonCandidate()
    );

    this.emit(mnemonic, `${mnemonic} ${operands.join(', ')}, ${label}`);
    if (linkBranchMnemonics.has(mnemonic) && operands.length > 0) {
      this.state.setRegister('$31', this.currentPc() + (this.usesDelaySlot() ? 4 : 0));
    }
    if (this.usesDelaySlot()) {
      this.emitDelaySlot();
    }
    if (skipPoison && this.remaining() > 0) {
      this.emitSkippedPoisonInstruction();
    }
    this.addLabel(label);
  }

  private emitJump(mnemonic: 'j' | 'jal'): void {
    const label = this.nextLabel(mnemonic);
    const skipPoison = this.remaining() > 1 + this.delaySlotCost() && this.hasStatefulPoisonCandidate();

    this.emit(mnemonic, `${mnemonic} ${label}`);
    if (mnemonic === 'jal') {
      this.state.setRegister('$31', textBaseAddress + (this.emittedCount + this.delaySlotCost()) * 4);
    }
    if (this.usesDelaySlot()) {
      this.emitDelaySlot();
    }
    if (skipPoison && this.remaining() > 0) {
      this.emitSkippedPoisonInstruction();
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
    const skipPoison = this.remaining() > minCost && this.hasStatefulPoisonCandidate();
    const targetIndex = this.emittedCount + minCost + (skipPoison ? 1 : 0);
    const targetAddress = textBaseAddress + targetIndex * 4;
    const targetRegister = '$25';

    this.emitAddressLoad(loader, targetRegister, targetAddress);
    if (mnemonic === 'jr') {
      this.emit('jr', `jr ${targetRegister}`);
    } else {
      this.emit('jalr', `jalr $31, ${targetRegister}`);
      this.state.setRegister('$31', textBaseAddress + (this.emittedCount + delayCost) * 4);
    }
    if (this.usesDelaySlot()) {
      this.emitDelaySlot();
    }
    if (skipPoison && this.remaining() > 0) {
      this.emitSkippedPoisonInstruction();
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

  private emitSkippedPoisonInstruction(): void {
    const mnemonic = this.pickStatefulPoisonMnemonic();
    if (!mnemonic) {
      return;
    }
    this.emitStatefulPoison(mnemonic);
  }

  private pickDelaySlotMnemonic(): string | undefined {
    const preferred = ['addu', 'subu', 'ori', 'addiu', 'sll', 'srl', 'and', 'or', 'xor', 'slt', 'lw', 'sw'];
    const candidates = preferred
      .filter((mnemonic) => this.allowed.has(mnemonic) && this.canEmitSingle(mnemonic));
    if (candidates.length) {
      return this.rng.pick(candidates);
    }
    // Exclude syscall: an exception in a delay slot sets Cause.BD and makes the handler's EPC+4
    // land back on the delay slot, looping forever.
    return this.rng.pick(Array.from(this.allowed).filter((mnemonic) =>
      !controlMnemonics.has(mnemonic) && mnemonic !== 'syscall' && this.canEmitSingle(mnemonic)));
  }

  private hasStatefulPoisonCandidate(): boolean {
    return this.statefulPoisonCandidates().length > 0;
  }

  private pickStatefulPoisonMnemonic(): string | undefined {
    const candidates = this.statefulPoisonCandidates();
    return candidates.length ? this.rng.pick(candidates) : undefined;
  }

  private statefulPoisonCandidates(): string[] {
    const preferred = [
      'ori', 'addiu', 'addi', 'lui',
      'addu', 'subu', 'and', 'or', 'xor', 'nor', 'slt', 'sltu',
      'sll', 'srl', 'sra',
      'lw', 'lb', 'lbu', 'lh', 'lhu',
      'sw', 'sb', 'sh'
    ];
    return preferred.filter((mnemonic) =>
      this.allowed.has(mnemonic) &&
      !controlMnemonics.has(mnemonic) &&
      !hiLoWriteMnemonics.has(mnemonic) &&
      !hiLoReadMnemonics.has(mnemonic) &&
      this.canEmitSingle(mnemonic)
    );
  }

  private emitStatefulPoison(mnemonic: string): void {
    const imm = this.poisonImmediate();
    if (mnemonic === 'lui') {
      this.emitStaticInstruction(mnemonic, `lui ${poisonRegister}, ${formatUnsignedImmediate(imm)}`);
      return;
    }
    if (mnemonic === 'addi' || mnemonic === 'addiu') {
      this.emitStaticInstruction(mnemonic, `${mnemonic} ${poisonRegister}, $0, ${formatImmediate(imm)}`);
      return;
    }
    if (mnemonic === 'ori' || mnemonic === 'andi' || mnemonic === 'xori' || mnemonic === 'slti' || mnemonic === 'sltiu') {
      this.emitStaticInstruction(mnemonic, `${mnemonic} ${poisonRegister}, $0, ${formatImmediate(imm)}`);
      return;
    }
    if (mnemonic === 'sll' || mnemonic === 'srl' || mnemonic === 'sra') {
      this.emitStaticInstruction(mnemonic, `${mnemonic} ${poisonRegister}, $0, ${this.rng.int(0, 31)}`);
      return;
    }
    if (mnemonic === 'lw' || mnemonic === 'lb' || mnemonic === 'lbu' || mnemonic === 'lh' || mnemonic === 'lhu') {
      this.emitStaticInstruction(mnemonic, `${mnemonic} ${poisonRegister}, 0($0)`);
      return;
    }
    if (mnemonic === 'sw' || mnemonic === 'sb' || mnemonic === 'sh') {
      this.emitStaticInstruction(mnemonic, `${mnemonic} $0, 0($0)`);
      return;
    }
    this.emitStaticInstruction(mnemonic, `${mnemonic} ${poisonRegister}, $0, $0`);
  }

  private poisonImmediate(): number {
    return this.rng.pick([1, 2, 3, 0x1234, 0x5a5a, 0x7fff, this.rng.int(1, 0x7fff)]);
  }

  private branchWillTake(mnemonic: ControlMnemonic, operands: string[]): boolean {
    const first = operands[0] ? this.state.regValue(operands[0]) : 0;
    const second = operands[1] ? this.state.regValue(operands[1]) : 0;
    switch (mnemonic) {
      case 'beq':
        return first === second;
      case 'bne':
        return first !== second;
      case 'bgez':
      case 'bgezal':
        return signed32(first) >= 0;
      case 'bgtz':
        return signed32(first) > 0;
      case 'blez':
        return signed32(first) <= 0;
      case 'bltz':
      case 'bltzal':
        return signed32(first) < 0;
      default:
        return false;
    }
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
      this.state.setRegister(register, address);
    } else {
      this.emit(mnemonic, `${mnemonic} ${register}, $0, ${address}`);
      this.state.setRegister(register, address);
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

  private chooseVisibleWriteRegister(): string {
    return this.rng.pick(writableRegisters);
  }

  private chooseReadRegister(): string {
    const recent = this.state.recentWrites.filter((register) => register !== '$0');
    if (recent.length && this.rng.chance(this.pipelineProfile() ? 0.62 : 0.35)) {
      return this.rng.pick(recent.slice(0, 4));
    }
    return this.rng.pick(readRegisters);
  }

  private chooseSmallReadRegister(): string {
    const small = readRegisters.filter((register) => Math.abs(signed32(this.state.regValue(register))) <= 0x2000);
    if (small.length) {
      return this.rng.pick(small);
    }
    return '$0';
  }

  private nonZeroRegisters(avoidSignedMinusOne: boolean): string[] {
    return readRegisters.filter((register) => {
      const value = this.state.regValue(register);
      return value !== 0 && (!avoidSignedMinusOne || signed32(value) !== -1);
    });
  }

  private zeroRegisters(): string[] {
    return readRegisters.filter((register) => this.state.regValue(register) === 0);
  }

  private positiveRegisters(): string[] {
    return readRegisters.filter((register) => signed32(this.state.regValue(register)) > 0);
  }

  private negativeRegisters(): string[] {
    return readRegisters.filter((register) => signed32(this.state.regValue(register)) < 0);
  }

  private nonNegativeRegisters(): string[] {
    return readRegisters.filter((register) => signed32(this.state.regValue(register)) >= 0);
  }

  private nonPositiveRegisters(): string[] {
    return readRegisters.filter((register) => signed32(this.state.regValue(register)) <= 0);
  }

  private differentRegisterPair(): [string, string] | undefined {
    for (const left of readRegisters) {
      for (const right of readRegisters) {
        if (this.state.regValue(left) !== this.state.regValue(right)) {
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
        const left = this.state.regValue(rs);
        const right = this.state.regValue(rt);
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
      .map((register) => ({ register, value: this.state.regValue(register) }))
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

  private markHiLoWritten(): void {
    this.state.pendingHiLoRead = this.allowed.has('mfhi') || this.allowed.has('mflo');
  }

  private maybeEmitMduReadProbe(sourceMnemonic: string): void {
    if (!this.mduProbeProfile()) {
      return;
    }
    const busyCycles = mduBusyCycles(sourceMnemonic);
    const mode = this.pickMduProbeMode(busyCycles);
    if (!mode) {
      return;
    }

    const fillerCount = mode === 'busy'
      ? this.rng.int(1, Math.min(busyCycles, this.remaining() - 1))
      : busyCycles + 1;
    for (let i = 0; i < fillerCount; i++) {
      const filler = this.pickMduFillerMnemonic();
      if (!filler) {
        return;
      }
      this.emitSingle(filler);
    }

    const readers = this.mduReadCandidates();
    if (!readers.length) {
      return;
    }
    this.emitHiLoRead(this.rng.pick(readers), true);
    this.nextMduProbeMode = mode === 'busy' ? 'ready' : 'busy';
  }

  private pickMduProbeMode(busyCycles: number): MduReadProbeMode | undefined {
    const preferred = this.nextMduProbeMode;
    const fallback = preferred === 'busy' ? 'ready' : 'busy';
    if (this.canEmitMduReadProbe(preferred, busyCycles)) {
      return preferred;
    }
    if (this.canEmitMduReadProbe(fallback, busyCycles)) {
      return fallback;
    }
    return undefined;
  }

  private canEmitMduReadProbe(mode: MduReadProbeMode, busyCycles: number): boolean {
    const minRemaining = mode === 'busy' ? 2 : busyCycles + 2;
    return (
      this.remaining() >= minRemaining &&
      this.mduReadCandidates().length > 0 &&
      this.mduFillerCandidates().length > 0
    );
  }

  private mduProbeProfile(): boolean {
    return this.profile === 'P6' || this.profile === 'P7';
  }

  private mduReadCandidates(): string[] {
    return ['mflo', 'mfhi'].filter((mnemonic) => this.allowed.has(mnemonic) && this.canEmitSingle(mnemonic));
  }

  private pickMduFillerMnemonic(): string | undefined {
    return this.rng.pick(this.mduFillerCandidates());
  }

  private mduFillerCandidates(): string[] {
    const preferred = ['addu', 'subu', 'ori', 'addiu', 'sll', 'srl', 'sra', 'and', 'or', 'xor', 'slt', 'lw', 'sw', 'nop'];
    const preferredCandidates = preferred.filter((mnemonic) =>
      this.allowed.has(mnemonic) &&
      !hiLoWriteMnemonics.has(mnemonic) &&
      !hiLoReadMnemonics.has(mnemonic) &&
      this.canEmitSingle(mnemonic)
    );
    if (preferredCandidates.length) {
      return preferredCandidates;
    }
    return Array.from(this.allowed).filter((mnemonic) =>
      !controlMnemonics.has(mnemonic) &&
      !hiLoWriteMnemonics.has(mnemonic) &&
      !hiLoReadMnemonics.has(mnemonic) &&
      this.canEmitSingle(mnemonic)
    );
  }

  private noteMduProgress(mnemonic: string): void {
    if (this.state.mduProtectedSlots <= 0) {
      return;
    }
    if (hiLoReadMnemonics.has(mnemonic)) {
      this.state.mduProtectedSlots = 0;
      return;
    }
    if (!hiLoWriteMnemonics.has(mnemonic)) {
      this.state.mduProtectedSlots = Math.max(0, this.state.mduProtectedSlots - 1);
    }
  }

  private emit(mnemonic: string, text: string): void {
    this.recordInstruction(mnemonic, text);
    this.noteMduProgress(mnemonic);
  }

  private emitStaticInstruction(mnemonic: string, text: string): void {
    this.recordInstruction(mnemonic, text);
  }

  private recordInstruction(mnemonic: string, text: string): void {
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
