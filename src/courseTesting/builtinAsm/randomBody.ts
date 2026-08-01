// @index core-generator — 核心随机指令序列生成，状态感知CPU模型，1860行
import { randomBytes } from 'crypto';
import { ProjectProfile } from '../../projectProfile';
import {
  instructions,
  MipsInstruction
} from '../../language/mips/resources';
import { P7ProbeMetadata, P7ProbeOptions, P7StressMode } from './types';
import { CpuState, courseDataByteLength } from '../cpuState';
import {
  p7UserTextBaseAddress,
  p7ExceptionHandlerAddress,
  p7ExternalInterruptAckAddress,
  p7CourseInstructionCountMaximum,
  p7ExceptionFlushShadowSlots,
  p7InterruptAnchorInstructionCount,
  p7StatusEnableExternalInterrupt
} from './p7/constants';
import { renderP7ExceptionHandler, renderP7ExceptionHandlerUnified } from './asmTemplates';
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
} from '../mnemonicSets';
import {
  signed32,
  unsigned32,
  signExtend8,
  signExtend16,
  clz32,
  clo32,
  formatImmediate,
  formatUnsignedImmediate,
  alignDown,
  courseAsmHaltLoop
} from '../mipsUtil';
import { Random, hashSeed } from '../random';

export type P7ExceptionKind = 'adel' | 'ades' | 'syscall' | 'ri' | 'ov';

export interface BuiltinAsmGeneratorOptions extends P7ProbeOptions {
  profile: ProjectProfile;
  instructionText: string;
  /** Randomized main-program payload count; the required two-instruction halt tail is additional. */
  instructionCount: number;
  seed?: string;
  generatedAt?: Date;
  /** P7: inject an external interrupt scheduled at a generated "safe" PC. */
  interrupt?: boolean;
  /** P7: probability per body slot to emit a controllable internal exception (0..1). */
  exceptionRate?: number;
  /** P7: enabled internal exception classes. Defaults to all course-required classes. */
  exceptionTypes?: readonly string[];
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
  /** Random mode: counted main payload, excluding the halt scaffold. Probe mode reports its full main count. */
  instructionCount: number;
  /** Random mode: mnemonics emitted into the counted main payload; uncounted scaffolding adds none. */
  usedInstructions: string[];
  mode?: P7StressMode;
  probe?: P7ProbeMetadata;
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

const textBaseAddress = p7UserTextBaseAddress;
const p7PrologueInstructionCount = 2;
const poisonRegister = '$26';
// Handler helpers come from the required P7 profile. These CP0-only instructions are the pieces a
// custom body selection can otherwise omit while still requesting exception handling.
const p7HandlerRequiredMnemonics = ['mfc0', 'mtc0', 'eret'] as const;
const registerTrapMnemonics = new Set(['teq', 'tne', 'tge', 'tgeu', 'tlt', 'tltu']);
const immediateTrapMnemonics = new Set(['teqi', 'tnei', 'tgei', 'tgeiu', 'tlti', 'tltiu']);
const trapMnemonics = new Set([...registerTrapMnemonics, ...immediateTrapMnemonics]);
// SR value the prologue installs: IE=1 (bit0) + external interrupt mask IM[2]=1 (bit12).
// Uses IE + IM[2] only, not the full course mask (0x1c01).
const p7StatusEnableInterrupts = p7StatusEnableExternalInterrupt;
export const p7InternalUnknownInstructionMnemonic = '_co_internal_unknown_instruction';
const p7ExceptionCoverageOrder: P7ExceptionKind[] = ['adel', 'ades', 'syscall', 'ri', 'ov'];
const p7ExceptionKindNames = new Set<string>(p7ExceptionCoverageOrder);
// Simple, value-producing ALU/immediate ops that are safe to interrupt (no control/memory side
// effects that complicate the precise-interrupt point). Used to pick the external-interrupt target.
const safeInterruptTargetMnemonics = new Set<string>([
  'add', 'addu', 'sub', 'subu', 'and', 'or', 'xor', 'nor', 'slt', 'sltu',
  'addi', 'addiu', 'andi', 'ori', 'xori', 'slti', 'sltiu',
  'sll', 'srl', 'sra', 'sllv', 'srlv', 'srav', 'lui'
]);
const p7InterruptAnchorMnemonics = [
  'ori', 'addiu', 'addu', 'add', 'subu', 'sub', 'or', 'xor',
  'sll', 'srl', 'sra', 'sllv', 'srlv', 'srav',
  'lui', 'andi', 'xori', 'and', 'slt', 'sltu', 'addi', 'slti', 'sltiu'
];
const p7ScratchRegisterA = '$24';
const p7ScratchRegisterB = '$23';
const p7InterruptAnchorRegister = '$25';
type MemoryOperandCoverage = 'zero-offset' | 'positive-offset' | 'negative-offset' | 'negative-base';

export function normalizeP7ExceptionTypes(values: readonly string[] | undefined): P7ExceptionKind[] {
  if (!values) {
    return [...p7ExceptionCoverageOrder];
  }
  const result: P7ExceptionKind[] = [];
  for (const value of values) {
    const normalized = String(value).trim().toLowerCase();
    if (p7ExceptionKindNames.has(normalized) && !result.includes(normalized as P7ExceptionKind)) {
      result.push(normalized as P7ExceptionKind);
    }
  }
  return result;
}

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
  const exceptionTypes = instructionSet.profile === 'P7' ? normalizeP7ExceptionTypes(options.exceptionTypes) : [];
  validateBuiltinGeneratorRequest(instructionSet, count, { interrupt, exceptionRate, exceptionTypes });
  const seed = options.seed && options.seed.trim()
    ? options.seed.trim()
    : `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const generator = new ProgramGenerator(
    instructionSet.profile,
    instructionSet.mnemonics,
    count,
    seed,
    options.generatedAt ?? new Date(),
    { interrupt, exceptionRate, exceptionTypes }
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
  options: { interrupt: boolean; exceptionRate: number; exceptionTypes: readonly P7ExceptionKind[] }
): void {
  const allowed = new Set(instructionSet.mnemonics);
  const isP7 = instructionSet.profile === 'P7';
  if (isP7) {
    const p7MaxCount = p7CourseInstructionCountMaximum;
    if (count > p7MaxCount) {
      throw new BuiltinAsmGeneratorError(`P7 generated instruction count must be at most ${p7MaxCount}, because 0x${p7ExceptionHandlerAddress.toString(16)} is reserved for the course exception entry.`);
    }
  }
  if (allowed.has('syscall') && !isP7) {
    throw new BuiltinAsmGeneratorError('Built-in ASM generator supports syscall only for P7.');
  }
  const syscallEnabled = options.exceptionTypes.includes('syscall');
  const handlerEnabled = isP7
    && (
      options.interrupt ||
      (options.exceptionRate > 0 && options.exceptionTypes.length > 0) ||
      (allowed.has('syscall') && syscallEnabled) ||
      Array.from(trapMnemonics).some((mnemonic) => allowed.has(mnemonic))
    );
  if (handlerEnabled && count < p7PrologueInstructionCount) {
    throw new BuiltinAsmGeneratorError(`Built-in ASM generator P7 exception handler prologue requires at least ${p7PrologueInstructionCount} instruction slots.`);
  }
  if (options.interrupt) {
    const minimum = p7PrologueInstructionCount + p7InterruptAnchorInstructionCount;
    if (count < minimum) {
      throw new BuiltinAsmGeneratorError(`Built-in ASM generator P7 interrupt tests require at least ${minimum} instruction slots to reserve a safe interrupt target.`);
    }
    if (!p7InterruptAnchorMnemonics.some((mnemonic) => allowed.has(mnemonic))) {
      throw new BuiltinAsmGeneratorError('Built-in ASM generator P7 interrupt tests require at least one safe ALU/immediate instruction such as ori, addiu, or addu.');
    }
  }
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

class ProgramGenerator {
  private readonly rng: Random;
  private readonly allowed: Set<string>;
  private readonly profile: CpuProfile;
  private readonly targetCount: number;
  private readonly seed: string;
  private readonly generatedAt: Date;
  private readonly interruptEnabled: boolean;
  private readonly exceptionRate: number;
  private readonly exceptionTypes: P7ExceptionKind[];
  private readonly p7HandlerEnabled: boolean;
  private readonly pendingExceptionCoverage: P7ExceptionKind[];
  private readonly state = new CpuState();
  private readonly lines: string[] = [];
  private readonly used = new Set<string>();
  /** Indices (0-based instruction positions) that are safe external-interrupt targets. */
  private readonly interruptCandidates: number[] = [];
  /** Indices of generated instructions that are expected to raise an internal exception. */
  private readonly exceptionVictimIndices: number[] = [];
  private interruptAnchorTargetIndex: number | undefined;
  private labelIndex = 0;
  private emittedCount = 0;
  private nextMduProbeMode: MduReadProbeMode = 'busy';
  private readonly nextBranchOutcome = new Map<string, boolean>();
  private readonly nextConditionalMoveOutcome = new Map<string, boolean>();
  private readonly nextTrapOutcome = new Map<string, boolean>();
  private readonly pendingMemoryCoverage: MemoryOperandCoverage[] = [
    'zero-offset', 'positive-offset', 'negative-offset', 'negative-base'
  ];

  constructor(
    profile: CpuProfile,
    mnemonics: string[],
    targetCount: number,
    seed: string,
    generatedAt: Date,
    options: { interrupt: boolean; exceptionRate: number; exceptionTypes?: readonly P7ExceptionKind[] } = { interrupt: false, exceptionRate: 0 }
  ) {
    this.profile = profile;
    this.allowed = new Set(mnemonics);
    this.targetCount = targetCount;
    this.seed = seed;
    this.generatedAt = generatedAt;
    this.interruptEnabled = profile === 'P7' && options.interrupt;
    this.exceptionRate = profile === 'P7' ? options.exceptionRate : 0;
    this.exceptionTypes = profile === 'P7' ? [...(options.exceptionTypes ?? p7ExceptionCoverageOrder)] : [];
    this.p7HandlerEnabled = profile === 'P7'
      && (
        this.interruptEnabled ||
        (this.exceptionRate > 0 && this.exceptionTypes.length > 0) ||
        this.syscallEnabled() ||
        Array.from(trapMnemonics).some((mnemonic) => this.allowed.has(mnemonic))
      );
    this.rng = new Random(hashSeed(`${profile}:${targetCount}:${seed}:${options.interrupt ? 'i' : ''}:${this.exceptionRate}`));
    this.nextMduProbeMode = this.rng.chance(0.5) ? 'busy' : 'ready';
    this.pendingExceptionCoverage = this.buildExceptionCoverageQueue();
  }

  generate(): BuiltinAsmGeneratorResult {
    if (this.p7HandlerEnabled) {
      this.emitP7Prologue();
    }
    if (this.interruptEnabled) {
      this.emitInterruptAnchor();
    }
    this.emitMemoryCoverageSeed();
    this.emitControlTargetCoverage();

    const coverageQueue = this.shuffle(Array.from(this.allowed));
    let guard = this.targetCount * 30 + 200;

    while (this.remaining() > 0 && guard-- > 0) {
      const randomBudget = this.randomBodyRemaining();
      if (randomBudget <= 0) {
        break;
      }

      if (this.wantsExceptionInjection() && this.emitException()) {
        continue;
      }

      const mnemonic = this.pickCoverageMnemonic(coverageQueue, randomBudget)
        ?? this.pickBiasedMnemonic(randomBudget)
        ?? this.pickAnyMnemonic(randomBudget);
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
      '# instruction_count_scope: payload (halt tail excluded)',
      `# instruction_set: ${instructionSet}`,
      '.data',
      '.align 2',
      '_co_data:',
      `    .space ${courseDataByteLength}`,
      '.text',
      '.globl main',
      'main:',
      ...this.lines,
      ...courseAsmHaltLoop(),
      ...this.renderP7ExceptionHandler(),
      ''
    ].join('\n');
  }

  private renderP7ExceptionHandler(): string[] {
    if (!this.p7HandlerEnabled) {
      return [];
    }
    if (this.interruptEnabled) {
      // With external interrupts enabled, the generator emits the interrupt anchor immediately
      // after the SR prologue and before any internal exception source. Therefore the first handler
      // entry is the external interrupt. Avoid reading full Cause there: MARS leaves IP clear for
      // p7irq while many course CPUs expose HWInt[2] in Cause.IP, and that implementation detail
      // would otherwise appear as a trace-visible $k0 write.
      return renderP7ExceptionHandler(p7ExternalInterruptAckAddress, p7ExceptionHandlerAddress);
    }
    // Unified P7 handler at the course exception entry.
    // 1. Read Cause first and branch on ExcCode. Only an external interrupt (ExcCode == 0)
    //    acknowledges/clears the interrupt generator at 0x7F20.
    // 2. Internal exceptions advance EPC by 4 to skip the faulting instruction, but must not ack
    //    the external interrupt generator: a pending interrupt may have arrived while EXL was set.
    // Only $k0/$k1 ($26/$27) are touched; generated user code never reads them, so the handler
    // is transparent to user-visible state. eret has no delay slot.
    return renderP7ExceptionHandlerUnified(p7ExternalInterruptAckAddress, p7ExceptionHandlerAddress);
  }

  private emitP7Prologue(): void {
    // Install SR = 0x1001 (IE=1, IM[2]=1) before any body instruction so the external interrupt
    // can be taken and mfc0 $12 remains predictable. Emitted as static instructions: $k0 must
    // not enter the read-candidate pool.
    this.emitStaticInstruction('ori', `ori $k0, $0, 0x${p7StatusEnableInterrupts.toString(16)}`);
    this.emitStaticInstruction('mtc0', `mtc0 $k0, $12`);
    this.state.cp0_sr = p7StatusEnableInterrupts;
  }

  private emitMemoryCoverageSeed(): void {
    if (![...loadMnemonics, ...storeMnemonics].some((mnemonic) => this.allowed.has(mnemonic))) {
      return;
    }
    // A small negative base is required to exercise the tutorial's negative-base addressing
    // class while keeping the final effective address inside DM. Seed it deterministically when
    // the configured real instruction set can express -1, and leave at least one slot for memory.
    if (this.allowed.has('addiu') && this.remaining() >= 2) {
      this.emit('addiu', `addiu ${p7ScratchRegisterA}, $0, -1`);
      this.state.setRegister(p7ScratchRegisterA, -1);
      return;
    }
    if (this.allowed.has('addi') && this.remaining() >= 2) {
      this.emit('addi', `addi ${p7ScratchRegisterA}, $0, -1`);
      this.state.setRegister(p7ScratchRegisterA, -1);
      return;
    }
    if (this.allowed.has('lui') && this.allowed.has('ori') && this.remaining() >= 3) {
      this.emit('lui', `lui ${p7ScratchRegisterA}, 0xffff`);
      this.state.setRegister(p7ScratchRegisterA, 0xffff0000);
      this.emit('ori', `ori ${p7ScratchRegisterA}, ${p7ScratchRegisterA}, 0xffff`);
      this.state.setRegister(p7ScratchRegisterA, -1);
    }
  }

  private emitControlTargetCoverage(): void {
    const required = ['ori', 'sub', 'beq', 'nop'];
    if (!required.every((mnemonic) => this.allowed.has(mnemonic))) {
      return;
    }
    const instructionCost = this.usesDelaySlot() ? 9 : 6;
    if (this.remaining() < instructionCost) {
      return;
    }

    const counter = '$21';
    const step = '$22';
    const selfLabel = this.nextLabel('self');
    const backwardLabel = this.nextLabel('backward');
    const doneLabel = this.nextLabel('backward_done');

    this.emitStaticInstruction('ori', `ori ${step}, $0, 1`);
    this.emitStaticInstruction('ori', `ori ${counter}, $0, 2`);
    this.addLabel(selfLabel);
    // A self target that is deliberately not taken catches both immediate/PC errors and an
    // incorrectly taken condition without creating a loop on a correct CPU.
    this.emitStaticInstruction('beq', `beq $0, ${step}, ${selfLabel}`);
    if (this.usesDelaySlot()) {
      this.emitStaticInstruction('nop', 'nop');
    }

    // Two bounded dynamic iterations exercise a genuinely taken negative branch offset. The
    // first exit check falls through, the backward branch is taken, and the second exit check
    // reaches done. NOP slots keep the final software-model state deterministic.
    this.addLabel(backwardLabel);
    this.emitStaticInstruction('sub', `sub ${counter}, ${counter}, ${step}`);
    this.emitStaticInstruction('beq', `beq ${counter}, $0, ${doneLabel}`);
    if (this.usesDelaySlot()) {
      this.emitStaticInstruction('nop', 'nop');
    }
    this.emitStaticInstruction('beq', `beq $0, $0, ${backwardLabel}`);
    if (this.usesDelaySlot()) {
      this.emitStaticInstruction('nop', 'nop');
    }
    this.addLabel(doneLabel);
    this.state.setRegister(step, 1);
    this.state.setRegister(counter, 0);
  }

  private emitModeledLui(register: string, imm: number): void {
    this.emit('lui', `lui ${register}, ${formatUnsignedImmediate(imm)}`);
    this.state.setRegister(register, imm << 16);
  }

  private emitModeledOri(register: string, rs: string, imm: number): void {
    this.emit('ori', `ori ${register}, ${rs}, ${formatUnsignedImmediate(imm)}`);
    this.state.setRegister(register, this.state.regValue(rs) | (imm & 0xffff));
  }

  private wantsExceptionInjection(): boolean {
    if (this.exceptionRate <= 0 || !this.p7HandlerEnabled) {
      return false;
    }
    const available = this.availableExceptionKinds();
    if (!available.length) {
      return false;
    }
    // Don't perturb a pending MDU read window or a delay-slot obligation.
    if (this.state.pendingHiLoRead || this.state.mduProtectedSlots > 0) {
      return false;
    }
    if (this.pendingExceptionCoverage.some((kind) => available.includes(kind))) {
      return true;
    }
    return this.rng.chance(this.exceptionRate);
  }

  private emitException(): boolean {
    const kinds = this.availableExceptionKinds();
    if (!kinds.length) {
      return false;
    }
    const coverageIndex = this.pendingExceptionCoverage.findIndex((kind) => kinds.includes(kind));
    const kind = coverageIndex >= 0 ? this.pendingExceptionCoverage.splice(coverageIndex, 1)[0] : this.rng.pick(kinds);
    const victimIndex = this.emitExceptionKind(kind);
    if (victimIndex === undefined) {
      return false;
    }
    this.noteExceptionVictim(victimIndex);
    return true;
  }

  // Setup instructions update CpuState normally. The returned victim instruction itself has no
  // modeled user-visible effect: the handler skips it (EPC += 4), so its destination/memory write
  // never commits in either MARS or a correct P7 CPU.
  private availableExceptionKinds(): P7ExceptionKind[] {
    const budget = this.randomBodyRemaining();
    return this.exceptionTypes.filter((kind) => this.canEmitExceptionKind(kind, budget));
  }

  private canEmitExceptionKind(kind: P7ExceptionKind, budget: number): boolean {
    const length = this.exceptionSequenceLength(kind);
    return length !== undefined && budget >= length + p7ExceptionFlushShadowSlots;
  }

  private exceptionSequenceLength(kind: P7ExceptionKind): number | undefined {
    switch (kind) {
      case 'adel':
        return this.intentionalAdelLoadMnemonic() ? 1 : undefined;
      case 'ades':
        return this.intentionalAdesStoreMnemonic() ? 1 : undefined;
      case 'syscall':
        return this.syscallEnabled() ? 1 : undefined;
      case 'ri':
        return 1;
      case 'ov':
        return this.overflowExceptionLength();
    }
  }

  private buildExceptionCoverageQueue(): P7ExceptionKind[] {
    if (this.profile !== 'P7' || this.exceptionRate <= 0) {
      return [];
    }
    return this.shuffle(this.exceptionTypes.filter((kind) => this.exceptionSequenceLength(kind) !== undefined));
  }

  private emitExceptionKind(kind: P7ExceptionKind): number | undefined {
    switch (kind) {
      case 'adel':
        return this.emitAdelException();
      case 'ades':
        return this.emitAdesException();
      case 'syscall':
        return this.emitSyscallException();
      case 'ri':
        return this.emitRiException();
      case 'ov':
        return this.emitOverflowException();
    }
  }

  private intentionalAdelLoadMnemonic(): string | undefined {
    return ['lw', 'lh', 'lhu'].find((mnemonic) => this.allowed.has(mnemonic));
  }

  private intentionalAdesStoreMnemonic(): string | undefined {
    return ['sw', 'sh'].find((mnemonic) => this.allowed.has(mnemonic));
  }

  private emitAdelException(): number | undefined {
    const mnemonic = this.intentionalAdelLoadMnemonic();
    if (!mnemonic) {
      return undefined;
    }
    const victimIndex = this.emittedCount;
    this.emitStaticInstruction(mnemonic, `${mnemonic} ${this.chooseWriteRegister()}, 1($0)`);
    return victimIndex;
  }

  private emitAdesException(): number | undefined {
    const mnemonic = this.intentionalAdesStoreMnemonic();
    if (!mnemonic) {
      return undefined;
    }
    const victimIndex = this.emittedCount;
    this.emitStaticInstruction(mnemonic, `${mnemonic} ${this.chooseReadRegister()}, 1($0)`);
    return victimIndex;
  }

  private emitSyscallException(): number | undefined {
    if (!this.syscallEnabled()) {
      return undefined;
    }
    const victimIndex = this.emittedCount;
    this.emitStaticInstruction('syscall', 'syscall');
    return victimIndex;
  }

  private emitRiException(): number {
    const victimIndex = this.emittedCount;
    this.emitStaticInstruction('ri', p7InternalUnknownInstructionMnemonic);
    return victimIndex;
  }

  private overflowExceptionLength(): number | undefined {
    if (this.currentOverflowException() !== undefined) {
      return 1;
    }
    if (this.allowed.has('lui') && this.allowed.has('addi')) {
      return 2;
    }
    if (this.allowed.has('lui') && this.allowed.has('add')) {
      return 2;
    }
    if (this.allowed.has('lui') && this.allowed.has('ori') && this.allowed.has('sub')) {
      return 3;
    }
    return undefined;
  }

  private currentOverflowException(): { mnemonic: 'add' | 'sub' | 'addi'; rs: string; rt?: string; imm?: number } | undefined {
    const overflows = (value: number): boolean => value > 0x7fffffff || value < -0x80000000;
    if (this.allowed.has('add') || this.allowed.has('sub')) {
      const useSub = !this.allowed.has('add');
      for (const rs of readRegisters) {
        for (const rt of readRegisters) {
          const a = signed32(this.state.regValue(rs));
          const b = signed32(this.state.regValue(rt));
          if (overflows(useSub ? a - b : a + b)) {
            return { mnemonic: useSub ? 'sub' : 'add', rs, rt };
          }
        }
      }
    }
    if (this.allowed.has('addi')) {
      for (const rs of readRegisters) {
        const a = signed32(this.state.regValue(rs));
        for (const imm of [0x7fff, -0x8000]) {
          if (overflows(a + imm)) {
            return { mnemonic: 'addi', rs, imm };
          }
        }
      }
    }
    return undefined;
  }

  private emitOverflowException(): number | undefined {
    const current = this.currentOverflowException();
    if (current) {
      const victimIndex = this.emittedCount;
      if (current.mnemonic === 'addi') {
        this.emitStaticInstruction('addi', `addi ${this.chooseWriteRegister()}, ${current.rs}, ${formatImmediate(current.imm ?? 0)}`);
      } else {
        this.emitStaticInstruction(current.mnemonic, `${current.mnemonic} ${this.chooseWriteRegister()}, ${current.rs}, ${current.rt}`);
      }
      return victimIndex;
    }

    if (this.allowed.has('lui') && this.allowed.has('addi')) {
      this.emitModeledLui(p7ScratchRegisterA, 0x8000);
      const victimIndex = this.emittedCount;
      this.emitStaticInstruction('addi', `addi ${this.chooseWriteRegister()}, ${p7ScratchRegisterA}, -1`);
      return victimIndex;
    }
    if (this.allowed.has('lui') && this.allowed.has('add')) {
      this.emitModeledLui(p7ScratchRegisterA, 0x7fff);
      const victimIndex = this.emittedCount;
      this.emitStaticInstruction('add', `add ${this.chooseWriteRegister()}, ${p7ScratchRegisterA}, ${p7ScratchRegisterA}`);
      return victimIndex;
    }
    if (this.allowed.has('lui') && this.allowed.has('ori') && this.allowed.has('sub')) {
      this.emitModeledLui(p7ScratchRegisterA, 0x8000);
      this.emitModeledOri(p7ScratchRegisterB, '$0', 1);
      const victimIndex = this.emittedCount;
      this.emitStaticInstruction('sub', `sub ${this.chooseWriteRegister()}, ${p7ScratchRegisterA}, ${p7ScratchRegisterB}`);
      return victimIndex;
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

  private syscallEnabled(): boolean {
    return this.allowed.has('syscall') && this.exceptionTypes.includes('syscall');
  }

  private noteExceptionVictim(index: number): void {
    if (this.profile !== 'P7') {
      return;
    }
    this.exceptionVictimIndices.push(index);
  }

  private isInExceptionFlushShadow(index: number): boolean {
    return this.exceptionVictimIndices.some((victimIndex) =>
      index > victimIndex && index <= victimIndex + p7ExceptionFlushShadowSlots);
  }

  private randomBodyRemaining(): number {
    return this.remaining();
  }

  private interruptAnchorMnemonic(): string | undefined {
    return p7InterruptAnchorMnemonics.find((mnemonic) => this.allowed.has(mnemonic) && this.canEmitSingle(mnemonic));
  }

  private emitInterruptAnchor(): void {
    if (this.remaining() < p7InterruptAnchorInstructionCount) {
      throw new BuiltinAsmGeneratorError('Internal generator error: not enough slots remain for the P7 interrupt anchor.');
    }
    const startIndex = this.emittedCount;
    for (let i = 0; i < p7InterruptAnchorInstructionCount; i++) {
      this.emitInterruptAnchorInstruction();
    }
    this.interruptAnchorTargetIndex = startIndex + 1;
  }

  private emitInterruptAnchorInstruction(): void {
    const mnemonic = this.interruptAnchorMnemonic();
    if (!mnemonic) {
      throw new BuiltinAsmGeneratorError('Internal generator error: cannot emit a safe P7 interrupt anchor instruction.');
    }
    const startIndex = this.emittedCount;
    this.emitModeledAnchorInstruction(mnemonic);
    this.noteInterruptCandidate(mnemonic, startIndex);
  }

  private emitModeledAnchorInstruction(mnemonic: string): void {
    const register = p7InterruptAnchorRegister;
    const current = this.state.regValue(register);
    let value = current;
    let text: string;
    switch (mnemonic) {
      case 'ori':
      case 'addiu':
      case 'xori':
        text = `${mnemonic} ${register}, ${register}, 0`;
        break;
      case 'addi':
        text = `${mnemonic} ${register}, ${register}, 0`;
        break;
      case 'addu':
      case 'add':
      case 'subu':
      case 'sub':
      case 'or':
      case 'xor':
        text = `${mnemonic} ${register}, ${register}, $0`;
        break;
      case 'and':
        text = `and ${register}, ${register}, ${register}`;
        break;
      case 'andi':
        text = `andi ${register}, ${register}, 0xffff`;
        value = current & 0xffff;
        break;
      case 'sll':
      case 'srl':
      case 'sra':
        text = `${mnemonic} ${register}, ${register}, 0`;
        break;
      case 'sllv':
      case 'srlv':
      case 'srav':
        text = `${mnemonic} ${register}, ${register}, $0`;
        break;
      case 'slt':
      case 'sltu':
        text = `${mnemonic} ${register}, $0, $0`;
        value = 0;
        break;
      case 'slti':
      case 'sltiu':
        text = `${mnemonic} ${register}, $0, 0`;
        value = 0;
        break;
      case 'lui':
        text = `lui ${register}, 0`;
        value = 0;
        break;
      default:
        throw new BuiltinAsmGeneratorError(`Internal generator error: unsupported P7 interrupt anchor instruction ${mnemonic}.`);
    }
    this.emit(mnemonic, text);
    this.state.setRegister(register, value);
  }

  private chooseInterruptSchedule(): number[] {
    if (this.interruptAnchorTargetIndex !== undefined) {
      return [textBaseAddress + this.interruptAnchorTargetIndex * 4];
    }
    // Require a contiguous safe pair (k, k+1) of always-executed simple instructions. The schedule
    // value is the testbench target_pc = the architectural instruction the CPU defers (its EPC),
    // which is k+1. MARS fires p7irq one instruction earlier (at k) — see buildMarsArgs — because
    // its prevIRQ injection commits the p7irq instruction and defers the next one, whereas the CPU
    // samples the interrupt against the M-stage macroscopic_pc and defers that instruction. Both
    // ends therefore defer k+1, and both k and k+1 are simple ops (so Cause.BD=0 and the precise
    // interrupt point is unambiguous).
    const candidateSet = new Set(this.interruptCandidates);
    const contiguous = this.interruptCandidates
      .filter((index) => candidateSet.has(index + 1))
      // A preserved PC from an internally excepting instruction can appear on flushed bubbles for
      // the following slots while EXL is set. Do not put either the MARS trigger point (k) or the
      // testbench target (k+1) in that shadow, or the one-shot interrupt source can fire too early.
      .filter((index) => !this.isInExceptionFlushShadow(index) && !this.isInExceptionFlushShadow(index + 1))
      .sort((a, b) => a - b);
    if (!contiguous.length) {
      return [];
    }
    const pick = contiguous[Math.floor(contiguous.length / 2)];
    return [textBaseAddress + (pick + 1) * 4];
  }

  private pickCoverageMnemonic(queue: string[], remainingBudget: number): string | undefined {
    for (let i = 0; i < queue.length; i++) {
      const mnemonic = queue[i];
      if (this.used.has(mnemonic)) {
        queue.splice(i, 1);
        i--;
        continue;
      }
      if (this.canEmit(mnemonic, remainingBudget)) {
        queue.splice(i, 1);
        return mnemonic;
      }
    }
    return undefined;
  }

  private pickBiasedMnemonic(remainingBudget: number): string | undefined {
    if (this.state.pendingHiLoRead) {
      const readers = ['mflo', 'mfhi'].filter((mnemonic) => this.allowed.has(mnemonic) && this.canEmit(mnemonic, remainingBudget));
      if (readers.length && this.rng.chance(0.75)) {
        return this.rng.pick(readers);
      }
    }

    const candidates = Array.from(this.allowed).filter((mnemonic) => this.canEmit(mnemonic, remainingBudget));
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

  private pickAnyMnemonic(remainingBudget: number): string | undefined {
    return this.rng.pick(Array.from(this.allowed).filter((mnemonic) => this.canEmit(mnemonic, remainingBudget)));
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
    if (this.state.mduProtectedSlots > 0 && (hiLoWriteMnemonics.has(mnemonic) || mnemonic === 'mul')) {
      return false;
    }
    if (mnemonic === 'mfhi' && !this.state.hiInitialized) {
      return false;
    }
    if (mnemonic === 'mflo' && !this.state.loInitialized) {
      return false;
    }
    if (
      (mnemonic === 'madd' || mnemonic === 'maddu' || mnemonic === 'msub' || mnemonic === 'msubu') &&
      (!this.state.hiInitialized || !this.state.loInitialized)
    ) {
      return false;
    }
    if (divideMnemonics.has(mnemonic)) {
      return this.nonZeroRegisters(mnemonic === 'div').length > 0;
    }
    if (registerTrapMnemonics.has(mnemonic)) {
      const mayRaise = this.profile === 'P7' && this.p7HandlerEnabled;
      return this.trapRegisterOperands(mnemonic, false) !== undefined ||
        (mayRaise && this.trapRegisterOperands(mnemonic, true) !== undefined);
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
      return this.p7HandlerEnabled && this.syscallEnabled();
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
    // The tutorial rejects arithmetic-overflow test data in every profile. P7's deliberate Ov
    // coverage is emitted separately by the controlled probe/exception scenarios.
    const avoidOverflow = mnemonic === 'add' || mnemonic === 'sub';
    const rs = avoidOverflow
      ? this.chooseSmallReadRegister()
      : this.chooseReadRegister();
    const rt = avoidOverflow
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
    if (mnemonic === 'mul') {
      // MIPS32 defines HI/LO as UNPREDICTABLE after MUL. Never use the host MARS choice as an
      // oracle until each half has been initialized again by an architecturally defined writer.
      this.state.hiInitialized = false;
      this.state.loInitialized = false;
      this.state.pendingHiLoRead = false;
    }
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
    } else if (mnemonic === 'lwl') {
      value = this.state.loadWordLeft(address, this.state.regValue(rt));
    } else if (mnemonic === 'lwr') {
      value = this.state.loadWordRight(address, this.state.regValue(rt));
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
    } else if (mnemonic === 'swl') {
      this.state.storeWordLeft(address, value);
    } else if (mnemonic === 'swr') {
      this.state.storeWordRight(address, value);
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
    this.markHiLoWritten('both');
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
    this.markHiLoWritten('both');
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
      this.markHiLoWritten('hi');
    } else {
      this.state.lo = this.state.regValue(rs);
      this.markHiLoWritten('lo');
    }
  }

  private emitConditionalMove(mnemonic: string): void {
    const rd = this.chooseVisibleWriteRegister();
    const rs = this.chooseReadRegister();
    const preferMove = this.nextConditionalMoveOutcome.get(mnemonic) ?? this.rng.chance(0.5);
    const moveCandidates = mnemonic === 'movn' ? this.nonZeroRegisters(false) : this.zeroRegisters();
    const noMoveCandidates = mnemonic === 'movn' ? this.zeroRegisters() : this.nonZeroRegisters(false);
    const preferred = preferMove ? moveCandidates : noMoveCandidates;
    const fallback = preferMove ? noMoveCandidates : moveCandidates;
    const rt = this.rng.pick(preferred.length ? preferred : fallback);
    this.emit(mnemonic, `${mnemonic} ${rd}, ${rs}, ${rt}`);

    const condition = mnemonic === 'movn' ? this.state.regValue(rt) !== 0 : this.state.regValue(rt) === 0;
    this.nextConditionalMoveOutcome.set(mnemonic, !condition);
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
    this.noteExceptionVictim(this.emittedCount - 1);
  }

  private emitTrapRegister(mnemonic: string): void {
    const mayRaise = this.profile === 'P7' && this.p7HandlerEnabled;
    const preferRaise = mayRaise && (this.nextTrapOutcome.get(mnemonic) ?? true);
    const operands = this.trapRegisterOperands(mnemonic, preferRaise)
      ?? this.trapRegisterOperands(mnemonic, !preferRaise);
    if (!operands) {
      throw new BuiltinAsmGeneratorError(`Cannot emit non-throwing ${mnemonic}; add a value-producing instruction such as ori/addiu first.`);
    }
    this.emit(mnemonic, `${mnemonic} ${operands[0]}, ${operands[1]}`);
    const raises = this.trapRegisterWillRaise(mnemonic, operands[0], operands[1]);
    if (mayRaise) {
      this.nextTrapOutcome.set(mnemonic, !raises);
      if (raises) {
        this.noteExceptionVictim(this.emittedCount - 1);
      }
    }
  }

  private emitTrapImmediate(mnemonic: string): void {
    const mayRaise = this.profile === 'P7' && this.p7HandlerEnabled;
    const raises = mayRaise && (this.nextTrapOutcome.get(mnemonic) ?? true);
    const [rs, imm] = raises
      ? this.trueTrapImmediateOperands(mnemonic)
      : falseTrapImmediateOperands(mnemonic);
    this.emit(mnemonic, `${mnemonic} ${rs}, ${imm}`);
    if (mayRaise) {
      this.nextTrapOutcome.set(mnemonic, !raises);
      if (raises) {
        this.noteExceptionVictim(this.emittedCount - 1);
      }
    }
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
    const willTake = this.branchWillTake(mnemonic, operands);
    const emitPathProbe = (
      this.remaining() > 1 + this.delaySlotCost() &&
      this.hasStatefulPoisonCandidate()
    );

    this.emit(mnemonic, `${mnemonic} ${operands.join(', ')}, ${label}`);
    this.nextBranchOutcome.set(mnemonic, !willTake);
    if (linkBranchMnemonics.has(mnemonic)) {
      // MIPS links to branch-PC+8 regardless of the condition. The trace parser repairs modified
      // MARS' missing not-taken event, so both outcomes remain useful differential tests.
      this.state.setRegister('$31', this.currentPc() + 4);
    }
    if (this.usesDelaySlot()) {
      this.emitDelaySlot();
    }
    // The instruction between the branch and label is observable on exactly one path. This makes
    // both taken and not-taken decisions detectable; its destination ($26) is excluded from the
    // generator's state-dependent operand pool, so a skipped instruction need not be modeled.
    if (emitPathProbe && this.remaining() > 0) {
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
    // Random exceptions in a delay slot need a different EPC recovery rule. Dedicated P7 probe
    // scenarios cover that rule; keep the stateful random stream free of nested control hazards.
    return this.rng.pick(Array.from(this.allowed).filter((mnemonic) =>
      !controlMnemonics.has(mnemonic) && mnemonic !== 'syscall' && !trapMnemonics.has(mnemonic) && this.canEmitSingle(mnemonic)));
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
    const preferTaken = this.nextBranchOutcome.get(mnemonic) ?? this.rng.chance(0.5);
    if (mnemonic === 'beq') {
      const reg = this.chooseReadRegister();
      const different = this.differentRegisterPair();
      return this.pickBranchOperands(preferTaken, [[reg, reg]], different ? [different] : []);
    }
    if (mnemonic === 'bne') {
      const different = this.differentRegisterPair();
      return this.pickBranchOperands(preferTaken, different ? [different] : [], [['$0', '$0']]);
    }
    if (mnemonic === 'bgez' || mnemonic === 'bgezal') {
      return this.pickBranchOperands(
        preferTaken,
        this.nonNegativeRegisters().map((register) => [register]),
        this.negativeRegisters().map((register) => [register])
      );
    }
    if (mnemonic === 'bgtz') {
      return this.pickBranchOperands(
        preferTaken,
        this.positiveRegisters().map((register) => [register]),
        this.nonPositiveRegisters().map((register) => [register])
      );
    }
    if (mnemonic === 'blez') {
      return this.pickBranchOperands(
        preferTaken,
        this.nonPositiveRegisters().map((register) => [register]),
        this.positiveRegisters().map((register) => [register])
      );
    }
    if (mnemonic === 'bltz' || mnemonic === 'bltzal') {
      return this.pickBranchOperands(
        preferTaken,
        this.negativeRegisters().map((register) => [register]),
        this.nonNegativeRegisters().map((register) => [register])
      );
    }
    return ['$0'];
  }

  private pickBranchOperands(preferTaken: boolean, taken: string[][], notTaken: string[][]): string[] {
    const preferred = preferTaken ? taken : notTaken;
    const fallback = preferTaken ? notTaken : taken;
    if (preferred.length) {
      return this.rng.pick(preferred);
    }
    return fallback.length ? this.rng.pick(fallback) : ['$0'];
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

  private trapRegisterOperands(mnemonic: string, raises: boolean): [string, string] | undefined {
    for (const rs of readRegisters) {
      for (const rt of readRegisters) {
        if (this.trapRegisterWillRaise(mnemonic, rs, rt) === raises) {
          return [rs, rt];
        }
      }
    }
    return undefined;
  }

  private trapRegisterWillRaise(mnemonic: string, rs: string, rt: string): boolean {
    const left = this.state.regValue(rs);
    const right = this.state.regValue(rt);
    switch (mnemonic) {
      case 'teq':
        return left === right;
      case 'tne':
        return left !== right;
      case 'tge':
        return signed32(left) >= signed32(right);
      case 'tgeu':
        return unsigned32(left) >= unsigned32(right);
      case 'tlt':
        return signed32(left) < signed32(right);
      case 'tltu':
        return unsigned32(left) < unsigned32(right);
      default:
        return false;
    }
  }

  private trueTrapImmediateOperands(mnemonic: string): [string, string] {
    switch (mnemonic) {
      case 'teqi':
      case 'tgei':
      case 'tgeiu':
        return ['$0', '0'];
      case 'tnei':
      case 'tlti':
      case 'tltiu':
        return ['$0', '1'];
      default:
        return ['$0', '0'];
    }
  }

  private memoryOperand(alignment: number): { text: string; address: number } {
    const lastAddress = courseDataByteLength - alignment;
    const randomAddress = alignDown(this.rng.int(0, lastAddress), alignment);
    const candidates: Array<{
      register: string;
      baseValue: number;
      offset: number;
      address: number;
    }> = [];

    for (const register of readRegisters) {
      const baseValue = signed32(this.state.regValue(register));
      const nearby = [baseValue, baseValue - alignment, baseValue + alignment];
      const targetAddresses = new Set([
        0,
        Math.min(alignment, lastAddress),
        alignDown(lastAddress / 2, alignment),
        lastAddress,
        randomAddress,
        ...nearby
      ]);
      for (const address of targetAddresses) {
        const offset = address - baseValue;
        if (
          address < 0 || address > lastAddress || address % alignment !== 0 ||
          offset < -0x8000 || offset > 0x7fff
        ) {
          continue;
        }
        candidates.push({ register, baseValue, offset, address });
      }
    }

    if (!candidates.length) {
      throw new BuiltinAsmGeneratorError('Internal generator error: no legal course DM operand is available.');
    }

    let selected: typeof candidates[number] | undefined;
    for (let index = 0; index < this.pendingMemoryCoverage.length; index++) {
      const coverage = this.pendingMemoryCoverage[index];
      const matching = candidates.filter((candidate) => this.matchesMemoryCoverage(candidate, coverage));
      if (!matching.length) {
        continue;
      }
      selected = this.rng.pick(matching);
      this.pendingMemoryCoverage.splice(index, 1);
      break;
    }
    const operand = selected ?? this.rng.pick(candidates);
    return {
      text: `${formatImmediate(operand.offset)}(${operand.register})`,
      address: operand.address
    };
  }

  private matchesMemoryCoverage(
    operand: { baseValue: number; offset: number },
    coverage: MemoryOperandCoverage
  ): boolean {
    switch (coverage) {
      case 'zero-offset':
        return operand.offset === 0;
      case 'positive-offset':
        return operand.offset > 0;
      case 'negative-offset':
        return operand.offset < 0;
      case 'negative-base':
        return operand.baseValue < 0;
    }
  }

  private markHiLoWritten(part: 'hi' | 'lo' | 'both'): void {
    if (part === 'hi' || part === 'both') {
      this.state.hiInitialized = true;
    }
    if (part === 'lo' || part === 'both') {
      this.state.loInitialized = true;
    }
    this.state.pendingHiLoRead = (
      (this.allowed.has('mfhi') && this.state.hiInitialized) ||
      (this.allowed.has('mflo') && this.state.loInitialized)
    );
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

    const budget = this.randomBodyRemaining();
    const fillerCount = mode === 'busy'
      ? this.rng.int(1, Math.min(busyCycles, budget - 1))
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
      this.randomBodyRemaining() >= minRemaining &&
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
