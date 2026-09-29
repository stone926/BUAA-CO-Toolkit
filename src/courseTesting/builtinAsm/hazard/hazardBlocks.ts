// @index hazard-blocks — 实现冒险目标：生产者→无关指令×间隔→消费者，含 JR/JALR 精确地址配方、JAL 调用返回、$0 写、转发优先级与 HI/LO 块
import { CpuState } from '../../cpuState';
import { branchMnemonics } from '../../mnemonicSets';
import { alignDown } from '../../mipsUtil';
import { Random } from '../../random';
import { branchTaken, isSmallArithmeticOperand } from '../instructionSemantics';
import { HazardTarget, HazardTargetPlanner } from './hazardTargets';
import { hazardClassOf, SourceRole } from '../../../hazardAnalysis/hazardTiming';
import { OperandSteer, SteeredEmission } from './operandSteer';
import { HazardWitnessEmitter } from './hazardWitnesses';

/** Narrow view of the random-body generator that hazard blocks emit through. */
export interface HazardEmitHost {
  readonly state: CpuState;
  readonly rng: Random;
  readonly allowed: ReadonlySet<string>;
  /** Registers a block may claim for producers, copies and setup values. */
  readonly hazardRegisters: readonly string[];
  remaining(): number;
  currentPc(): number;
  delaySlotCost(): number;
  canEmitSingle(mnemonic: string): boolean;
  canEmitBranch(mnemonic: string): boolean;
  /** One modeled non-control instruction; undefined (nothing emitted) when the steer is unsatisfiable. */
  emitSteered(mnemonic: string, steer: OperandSteer, delaySlot?: boolean): SteeredEmission | undefined;
  /** A modeled conditional branch with its delay slot and path-observable skipped poison. */
  emitSteeredBranch(mnemonic: string, steer: OperandSteer): boolean;
  /** A control instruction whose architectural effects the caller models. */
  emitControl(mnemonic: string, text: string): void;
  hasSkippedPoison(): boolean;
  emitSkippedPoison(): void;
  /** One independent instruction that writes none of `avoidWrites`; falls back to NOP. */
  emitFiller(avoidWrites: ReadonlySet<string>, delaySlot?: boolean): void;
  loadImmediateLength(value: number): number | undefined;
  loadImmediate(register: string, value: number): boolean;
  canAddressFromBase(mnemonic: string, base: number): boolean;
  label(name: string): void;
  nextLabel(prefix: string): string;
  beginDynamicGroup(): void;
  endDynamicGroup(order: readonly number[]): void;
  /** Applies pending modeled effects to coverage before the planner inspects it. */
  settleObservations(): void;
}

interface AddressPlan {
  readonly setups: ReadonlyArray<{ readonly register: string; readonly value: number }>;
  /** Moves the prepared value into memory or HI/LO before the producer reads it. */
  readonly stage?: { readonly mnemonic: string; readonly steer: OperandSteer };
  readonly producer: OperandSteer;
}

interface AddressConstants {
  readonly small: number;
  readonly mask: number;
  readonly amount: number;
  readonly address: number;
}

/** Budget a block may need beyond its gap: setup, producer, consumer, delay slot, poison. */
const blockReserve = 16;
const addressSetupRegisters = 2;

/**
 * Realizes planner targets with the random body's modeled emitters, so every operand stays
 * legal and the software CPU model stays exact. Each block binds the consumer to the fresh
 * register and arranges a stale value that a missing/wrong forward or stall would expose.
 */
export class HazardBlockEmitter {
  private exhausted = false;
  private readonly witnesses: HazardWitnessEmitter;

  constructor(private readonly host: HazardEmitHost, private readonly planner: HazardTargetPlanner) {
    this.witnesses = new HazardWitnessEmitter(host);
  }

  get done(): boolean {
    return this.exhausted;
  }

  /** Emits one coverage-directed block; false when no target is realizable now. */
  emitNext(): boolean {
    if (this.exhausted || this.host.remaining() < blockReserve) {
      return false;
    }
    if (this.witnesses.emitNext()) {
      this.host.settleObservations();
      return true;
    }
    const planned = this.planner.next((target) => this.realizable(target));
    if (!planned) {
      this.exhausted = !this.planner.hasOpenTargets();
      return false;
    }
    const openBefore = this.planner.openKeys(planned);
    const emitted = this.emitTarget(planned.target);
    this.host.settleObservations();
    this.planner.settle(planned, openBefore);
    return emitted;
  }

  private realizable(target: HazardTarget): boolean {
    switch (target.kind) {
      case 'forward': {
        const consumerClass = hazardClassOf(target.consumer);
        if ((target.producer === 'jal' || consumerClass === 'jr' || consumerClass === 'jalr') && !this.host.hasSkippedPoison()) return false;
        if (consumerClass === 'jr' || consumerClass === 'jalr') {
          return target.producer === 'jal'
            ? this.host.allowed.has('jal') && this.host.allowed.has('jr') && this.host.allowed.has('beq')
            : this.host.allowed.has(target.consumer) && this.addressPlanAvailable(target.producer);
        }
        return this.canProduce(target.producer) && this.canConsume(target.consumer);
      }
      case 'zero':
        return this.canProduce(target.producer) && this.canConsume(target.consumer);
      case 'priority':
        return this.canProduce(target.older) && this.canProduce(target.newer) && this.canConsume(target.consumer);
      case 'hilo':
        return this.host.canEmitSingle(target.writer) && this.host.allowed.has(target.reader);
    }
  }

  private canProduce(mnemonic: string): boolean {
    return mnemonic === 'jal' ? this.host.allowed.has('jal') : this.host.canEmitSingle(mnemonic);
  }

  private canConsume(mnemonic: string): boolean {
    return branchMnemonics.has(mnemonic) ? this.host.canEmitBranch(mnemonic) : this.host.canEmitSingle(mnemonic);
  }

  private emitTarget(target: HazardTarget): boolean {
    switch (target.kind) {
      case 'forward':
        return this.emitForward(target.producer, target.consumer, target.role, target.gap);
      case 'zero':
        return this.emitZeroDestination(target.producer, target.consumer, target.role, target.gap);
      case 'priority':
        return this.emitPriority(target);
      case 'hilo':
        return this.emitHiLo(target.writer, target.reader, target.gap);
    }
  }

  private emitForward(producer: string, consumer: string, role: SourceRole, gap: number): boolean {
    const consumerClass = hazardClassOf(consumer);
    if (consumerClass === 'jr' || consumerClass === 'jalr') {
      return producer === 'jal' ? this.emitCallReturn(gap) : this.emitRegisterJump(producer, consumer, gap);
    }
    if (producer === 'jal') {
      return this.emitLink(consumer, role, gap);
    }
    const avoid = new Set<string>();
    let register: string | undefined;
    let twin: string | undefined;
    if (hazardClassOf(consumer) === 'br_r2') {
      register = this.pickRegister(avoid);
      avoid.add(register);
      twin = this.prepareTwin(register, avoid);
      if (!twin) return false;
    }
    const before = this.snapshot();
    const produced = this.host.emitSteered(producer, {
      write: register,
      avoidWrites: avoid,
      preferSmallReads: this.needsSmallValue(consumer, role),
      accept: (value, destination) => destination !== '$0'
        && (destination === register || !avoid.has(destination))
        && this.consumerAccepts(consumer, role, value, this.host.state.regValue(destination))
    });
    if (!produced?.write) {
      return false;
    }
    avoid.add(produced.write);
    this.emitFillers(gap, avoid);
    return this.emitConsumer(consumer, role, produced.write, before.get(produced.write) ?? 0, twin);
  }

  /** JAL writes $31 = PC+8 in D; the consumer reads it from the delay slot or the target. */
  private emitLink(consumer: string, role: SourceRole, gap: number): boolean {
    const avoid = new Set(['$31']);
    let twin: string | undefined;
    if (hazardClassOf(consumer) === 'br_r2') {
      twin = this.prepareTwin('$31', avoid);
      if (!twin) return false;
    } else if (!this.consumerAccepts(consumer, role, this.host.currentPc() + 8, this.host.state.regValue('$31'))) {
      if (!this.preloadObservableLink(consumer, role)) return false;
    }
    const stale = this.host.state.regValue('$31');
    const label = this.host.nextLabel('hz_link');
    const jalPc = this.host.currentPc();
    this.host.emitControl('jal', `jal ${label}`);
    this.host.state.setRegister('$31', jalPc + 8);
    let consumed = false;
    if (gap === 0) {
      consumed = this.emitConsumer(consumer, role, '$31', stale, twin, true);
      if (!consumed) this.host.emitFiller(new Set(), true);
    } else {
      this.host.emitFiller(avoid, true);
    }
    if (this.host.hasSkippedPoison()) this.host.emitSkippedPoison();
    this.host.label(label);
    if (gap === 0) return consumed;
    this.emitFillers(gap - 1, avoid);
    return this.emitConsumer(consumer, role, '$31', stale, twin);
  }

  /** Makes the link value differ observably from $31's stale value for sign-sensitive users. */
  private preloadObservableLink(consumer: string, role: SourceRole): boolean {
    for (const candidate of [-1, 0, 1, 0x7fff]) {
      const length = this.host.loadImmediateLength(candidate);
      if (length === undefined) continue;
      const link = this.host.currentPc() + length * 4 + 8;
      if (this.consumerAccepts(consumer, role, link, candidate)) {
        return this.host.loadImmediate('$31', candidate);
      }
    }
    return false;
  }

  /**
   * JAL -> JR $31 (course call/return). The return lands on an escape branch placed after the
   * JAL delay slot, so the block stays forward-only. $31 is preloaded with the address of a
   * skipped poison, which a stale JR target would execute instead of escaping.
   */
  private emitCallReturn(gap: number): boolean {
    const extraFiller = gap >= 2 ? 1 : 0;
    const withPoison = this.host.hasSkippedPoison();
    const delay = this.host.delaySlotCost();
    // jal, delay, escape beq, escape delay, [filler], jr, jr delay, [poison]
    const poisonOffset = 1 + delay + 1 + delay + extraFiller + 1 + delay;
    if (withPoison) {
      const guess = this.host.currentPc() + 4 * (1 + poisonOffset);
      const length = this.host.loadImmediateLength(guess) ?? 0;
      if (length) this.host.loadImmediate('$31', this.host.currentPc() + 4 * (length + poisonOffset));
    }
    const stale = this.host.state.regValue('$31');
    const call = this.host.nextLabel('hz_call');
    const done = this.host.nextLabel('hz_return');
    const jalPc = this.host.currentPc();
    const avoid = new Set(['$31']);
    this.host.beginDynamicGroup();
    this.host.emitControl('jal', `jal ${call}`);
    this.host.state.setRegister('$31', jalPc + 8);
    if (delay) this.host.emitFiller(avoid, true);
    this.host.emitControl('beq', `beq $0, $0, ${done}`);
    // The escape delay slot executes last dynamically, so it must not change modeled state.
    if (delay) this.host.emitControl('nop', 'nop');
    this.host.label(call);
    this.emitFillers(extraFiller, avoid);
    this.host.emitControl('jr', 'jr $31');
    if (delay) this.host.emitFiller(new Set(), true);
    if (withPoison) this.host.emitSkippedPoison();
    this.host.label(done);
    const jal = 0;
    const escape = 1 + delay;
    const body = escape + 1 + delay;
    const jr = body + extraFiller;
    this.host.endDynamicGroup([
      jal,
      ...range(1, delay),
      ...range(body, extraFiller),
      jr,
      ...range(jr + 1, delay),
      escape,
      ...range(escape + 1, delay)
    ]);
    return stale !== jalPc + 8;
  }

  /** Producer builds the exact forward target; a stale register value points at the poison. */
  private emitRegisterJump(producer: string, consumer: string, gap: number): boolean {
    const avoid = new Set<string>();
    const register = this.pickRegister(avoid);
    avoid.add(register);
    const setupRegisters = Array.from({ length: addressSetupRegisters }, () => {
      const setup = this.pickRegister(avoid);
      avoid.add(setup);
      return setup;
    });
    const link = consumer === 'jalr' ? this.pickRegister(avoid) : undefined;
    const constants: AddressConstants = {
      small: this.host.rng.int(1, 0xff),
      mask: this.host.rng.int(0, 0xffff),
      amount: this.host.rng.pick([1, 33, 65]),
      address: alignDown(this.host.rng.int(0x200, 0x2f00), 4)
    };
    const withPoison = this.host.hasSkippedPoison();
    const tail = 1 + gap + 1 + this.host.delaySlotCost() + (withPoison ? 1 : 0);
    let target = this.host.currentPc() + 4 * (tail + 4);
    let plan: AddressPlan | undefined;
    let preload = 0;
    for (let iteration = 0; iteration < 4; iteration++) {
      plan = this.addressPlan(producer, target, register, setupRegisters, constants);
      const setupLength = plan ? this.planLength(plan) : undefined;
      preload = withPoison ? this.host.loadImmediateLength(target - 4) ?? 0 : 0;
      if (!plan || setupLength === undefined) return false;
      const next = this.host.currentPc() + 4 * (preload + setupLength + tail);
      if (next === target) break;
      target = next;
    }
    if (!plan) return false;
    const stale = preload ? target - 4 : this.host.state.regValue(register);
    if (preload) this.host.loadImmediate(register, target - 4);
    for (const setup of plan.setups) {
      if (!this.host.loadImmediate(setup.register, setup.value)) return false;
    }
    if (plan.stage && !this.host.emitSteered(plan.stage.mnemonic, plan.stage.steer)) return false;
    if (!this.host.emitSteered(producer, plan.producer)) return false;
    this.emitFillers(gap, avoid);
    const jumpPc = this.host.currentPc();
    if (link) {
      this.host.emitControl('jalr', `jalr ${link}, ${register}`);
      this.host.state.setRegister(link, jumpPc + 8);
    } else {
      this.host.emitControl('jr', `jr ${register}`);
    }
    if (this.host.delaySlotCost()) this.host.emitFiller(new Set(), true);
    if (withPoison) this.host.emitSkippedPoison();
    if (this.host.currentPc() !== target) {
      throw new Error(`Internal generator error: register-jump hazard target 0x${target.toString(16)} is misaligned.`);
    }
    this.host.label(this.host.nextLabel('hz_jump'));
    return stale !== target;
  }

  private addressPlanAvailable(producer: string): boolean {
    const probe = this.addressPlan(producer, 0x3000, '$1', ['$2', '$3'], { small: 1, mask: 0, amount: 1, address: 0x200 });
    return probe !== undefined && this.planLength(probe) !== undefined && this.host.canEmitSingle(producer);
  }

  private planLength(plan: AddressPlan): number | undefined {
    let length = plan.stage ? 1 : 0;
    for (const setup of plan.setups) {
      const setupLength = this.host.loadImmediateLength(setup.value);
      if (setupLength === undefined) return undefined;
      length += setupLength;
    }
    return length;
  }

  /** Operand recipes that make `producer` compute exactly `target` (course 值域匹配). */
  private addressPlan(
    producer: string,
    target: number,
    register: string,
    [first, second]: string[],
    constants: AddressConstants
  ): AddressPlan | undefined {
    const exact = (reads: OperandSteer['reads'], extra: Partial<OperandSteer> = {}): OperandSteer =>
      ({ write: register, reads, accept: (value) => value === target, ...extra });
    const low16 = 0xffff;
    switch (producer) {
      case 'ori':
      case 'xori':
      case 'addiu':
      case 'addi':
        return { setups: [], producer: exact({ rs: '$0' }, { immediate: target }) };
      case 'andi':
        return {
          setups: [{ register: first, value: target }],
          producer: exact({ rs: first }, { immediate: (target | constants.mask) & low16 })
        };
      case 'sll':
        return { setups: [{ register: first, value: target >>> 2 }], producer: exact({ rt: first }, { shamt: 2 }) };
      case 'srl':
      case 'sra':
        return { setups: [{ register: first, value: target << 1 }], producer: exact({ rt: first }, { shamt: 1 }) };
      case 'sllv':
        return {
          setups: [{ register: first, value: target >>> 1 }, { register: second, value: constants.amount }],
          producer: exact({ rt: first, rs: second })
        };
      case 'srlv':
      case 'srav':
        return {
          setups: [{ register: first, value: target << 1 }, { register: second, value: constants.amount }],
          producer: exact({ rt: first, rs: second })
        };
      case 'add':
      case 'addu':
        return {
          setups: [{ register: first, value: target - constants.small }, { register: second, value: constants.small }],
          producer: exact({ rs: first, rt: second })
        };
      case 'sub':
      case 'subu':
        return {
          setups: [{ register: first, value: target + constants.small }, { register: second, value: constants.small }],
          producer: exact({ rs: first, rt: second })
        };
      case 'or':
        return {
          setups: [{ register: first, value: target & constants.mask }, { register: second, value: target & ~constants.mask & low16 }],
          producer: exact({ rs: first, rt: second })
        };
      case 'xor':
        return {
          setups: [{ register: first, value: target ^ constants.small }, { register: second, value: constants.small }],
          producer: exact({ rs: first, rt: second })
        };
      case 'and': {
        const free = ~target & low16;
        const left = constants.mask & free;
        return {
          setups: [{ register: first, value: target | left }, { register: second, value: target | (free & ~left) }],
          producer: exact({ rs: first, rt: second })
        };
      }
      case 'nor':
        return { setups: [{ register: first, value: ~target }], producer: exact({ rs: first, rt: '$0' }) };
      case 'lw':
      case 'lh':
      case 'lhu': {
        const store = ['sw', 'sh'].find((mnemonic) =>
          this.host.canEmitSingle(mnemonic) && (producer !== 'lw' || mnemonic === 'sw'));
        if (!store) return undefined;
        return {
          setups: [{ register: first, value: target }],
          stage: { mnemonic: store, steer: { reads: { rt: first }, address: constants.address } },
          producer: exact(undefined, { address: constants.address })
        };
      }
      case 'mfhi':
      case 'mflo': {
        const mover = producer === 'mfhi' ? 'mthi' : 'mtlo';
        if (!this.host.canEmitSingle(mover)) return undefined;
        return {
          setups: [{ register: first, value: target }],
          stage: { mnemonic: mover, steer: { reads: { rs: first } } },
          producer: exact(undefined)
        };
      }
      default:
        return undefined;
    }
  }

  private emitZeroDestination(producer: string, consumer: string, role: SourceRole, gap: number): boolean {
    const avoid = new Set<string>(['$0']);
    const twin = hazardClassOf(consumer) === 'br_r2' ? this.prepareTwin('$0', avoid) : undefined;
    if (hazardClassOf(consumer) === 'br_r2' && !twin) return false;
    const address = hazardClassOf(producer) === 'load' ? this.seedNonzeroWord() : undefined;
    const produced = this.host.emitSteered(producer, {
      write: '$0',
      address,
      accept: (value) => value !== 0,
      preferSmallReads: this.needsSmallValue(consumer, role)
    });
    if (!produced?.value) {
      return false;
    }
    this.emitFillers(gap, avoid);
    return this.emitConsumer(consumer, role, '$0', produced.value, twin);
  }

  /** DM is sparse, so a load into $0 first gets a nonzero word to discard. */
  private seedNonzeroWord(): number | undefined {
    const source = this.host.hazardRegisters.find((register) => this.host.state.regValue(register) !== 0);
    if (!source || !this.host.canEmitSingle('sw')) return undefined;
    const address = alignDown(this.host.rng.int(0x200, 0x2f00), 4);
    return this.host.emitSteered('sw', { reads: { rt: source }, address }) ? address : undefined;
  }

  private emitPriority(target: Extract<HazardTarget, { kind: 'priority' }>): boolean {
    const avoid = new Set<string>();
    const register = this.pickRegister(avoid);
    avoid.add(register);
    // Prepare the comparison operand before either producer, so setup cannot age away the
    // competing writes. Requiring the older write to preserve the stale value makes a wrong
    // older/GRF selection flip BEQ/BNE instead of merely producing a different non-equal value.
    const branchTwin = hazardClassOf(target.consumer) === 'br_r2' ? this.prepareTwin(register, avoid) : undefined;
    if (hazardClassOf(target.consumer) === 'br_r2' && !branchTwin) return false;
    const original = this.host.state.regValue(register);
    const small = this.needsSmallValue(target.consumer, target.role);
    const older = this.host.emitSteered(target.older, {
      write: register,
      preferSmallReads: small,
      accept: (value) => branchTwin ? value === original : value !== original
    });
    if (older?.value === undefined) return false;
    const olderValue = this.host.state.regValue(register);
    this.emitFillers(target.olderGap, avoid);
    const newer = this.host.emitSteered(target.newer, {
      write: register,
      preferSmallReads: small,
      accept: (value) => value !== olderValue && value !== original &&
        this.consumerAccepts(target.consumer, target.role, value, olderValue)
    });
    if (!newer) return false;
    this.emitFillers(target.newerGap, avoid);
    return this.emitConsumer(target.consumer, target.role, register, olderValue, branchTwin);
  }

  private emitHiLo(writer: 'mthi' | 'mtlo', reader: 'mfhi' | 'mflo', gap: number): boolean {
    const current = writer === 'mthi' ? this.host.state.hi : this.host.state.lo;
    if (!this.host.emitSteered(writer, { accept: (value) => value !== current })) {
      return false;
    }
    this.emitFillers(gap, new Set());
    return this.host.emitSteered(reader, { accept: (_value, destination) => destination !== '$0' }) !== undefined;
  }

  private emitConsumer(
    consumer: string,
    role: SourceRole,
    register: string,
    wrong: number,
    twin?: string,
    delaySlot = false
  ): boolean {
    const other: SourceRole = role === 'rs' ? 'rt' : 'rs';
    const steer: OperandSteer = {
      reads: twin ? { [role]: register, [other]: twin } : { [role]: register },
      accept: (_value, destination) => destination !== '$0',
      wrong: { role, value: wrong }
    };
    if (branchMnemonics.has(consumer)) {
      return this.host.emitSteeredBranch(consumer, steer);
    }
    return this.host.emitSteered(consumer, steer, delaySlot) !== undefined;
  }

  /** A second register holding the stale value, so BEQ/BNE outcomes flip on a stale read. */
  private prepareTwin(register: string, avoid: Set<string>): string | undefined {
    const stale = this.host.state.regValue(register);
    const existing = ['$0', ...this.host.hazardRegisters].filter((candidate) =>
      candidate !== register && !avoid.has(candidate) && this.host.state.regValue(candidate) === stale);
    if (existing.length) {
      const twin = this.host.rng.pick(existing);
      avoid.add(twin);
      return twin;
    }
    const twin = this.pickRegister(avoid);
    for (const [mnemonic, steer] of [
      ['ori', { immediate: 0 }],
      ['addiu', { immediate: 0 }],
      ['addu', { reads: { rs: register, rt: '$0' } }],
      ['or', { reads: { rs: register, rt: '$0' } }],
      ['add', { reads: { rs: register, rt: '$0' } }],
      ['sll', { reads: { rt: register }, shamt: 0 }]
    ] as const) {
      if (!this.host.canEmitSingle(mnemonic)) continue;
      const copied = this.host.emitSteered(mnemonic, {
        write: twin,
        reads: { rs: register },
        ...steer,
        accept: (value) => value === stale
      });
      if (copied) {
        avoid.add(twin);
        return twin;
      }
    }
    return undefined;
  }

  private emitFillers(count: number, avoid: ReadonlySet<string>): void {
    for (let index = 0; index < count; index++) {
      this.host.emitFiller(avoid);
    }
  }

  private pickRegister(avoid: ReadonlySet<string>): string {
    const candidates = this.host.hazardRegisters.filter((register) => !avoid.has(register));
    // Prefer a register whose stale value no other register shares: fewer accidental equalities.
    const distinct = candidates.filter((register) => {
      const value = this.host.state.regValue(register);
      return this.host.hazardRegisters.every((other) => other === register || this.host.state.regValue(other) !== value);
    });
    return this.host.rng.pick(distinct.length ? distinct : candidates);
  }

  private snapshot(): Map<string, number> {
    return new Map(this.host.state.regs);
  }

  private needsSmallValue(consumer: string, role: SourceRole): boolean {
    const consumerClass = hazardClassOf(consumer);
    return (role === 'rs' && (consumerClass === 'load' || consumerClass === 'store')) ||
      consumer === 'add' || consumer === 'sub' || consumer === 'addi';
  }

  /** Whether `value` is a legal operand for the consumer that a stale `stale` would change. */
  private consumerAccepts(consumer: string, role: SourceRole, value: number, stale: number): boolean {
    if (value === stale) return false;
    const consumerClass = hazardClassOf(consumer);
    if (role === 'rs' && (consumerClass === 'load' || consumerClass === 'store')) {
      return this.host.canAddressFromBase(consumer, value);
    }
    if (consumerClass === 'store' && role === 'rt') {
      const lanes = consumer === 'sb' ? 0xff : consumer === 'sh' ? 0xffff : 0xffffffff;
      return ((value ^ stale) & lanes) !== 0;
    }
    if (consumer === 'add' || consumer === 'sub' || consumer === 'addi') {
      return isSmallArithmeticOperand(value);
    }
    if ((consumer === 'sllv' || consumer === 'srlv' || consumer === 'srav') && role === 'rs') {
      return ((value ^ stale) & 31) !== 0;
    }
    if (consumerClass === 'br_r1') {
      return branchTaken(consumer, value, 0) !== branchTaken(consumer, stale, 0);
    }
    if ((consumer === 'div' || consumer === 'divu') && role === 'rt') {
      return value !== 0 && !(consumer === 'div' && value === -1);
    }
    return true;
  }
}

function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => start + index);
}
