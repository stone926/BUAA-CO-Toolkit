// @index hazard-targets — 冒险覆盖目标：枚举生产者×消费者端口×间隔、静态可行性、课程元组预测与按覆盖缺口选择
import { controlMnemonics } from '../../mnemonicSets';
import {
  forwardClassKey,
  forwardTupleKey,
  HazardCoverage,
  hiLoClassKey,
  priorityClassKey,
  stallTupleKey,
  zeroClassKey
} from '../../../hazardAnalysis/hazardCoverage';
import { hazardInstructionFor } from '../../../hazardAnalysis/hazardInstruction';
import { HazardPipelineModel } from '../../../hazardAnalysis/hazardPipeline';
import { HazardClass, hazardClassOf, hazardSourceRoles, SourceRole } from '../../../hazardAnalysis/hazardTiming';

export type HazardGap = 0 | 1 | 2;

export type HazardTarget =
  | { readonly kind: 'forward'; readonly producer: string; readonly consumer: string; readonly role: SourceRole; readonly gap: HazardGap }
  | { readonly kind: 'zero'; readonly producer: string; readonly consumer: string; readonly role: SourceRole; readonly gap: HazardGap }
  | {
    readonly kind: 'priority';
    readonly older: string;
    readonly newer: string;
    readonly consumer: string;
    readonly role: SourceRole;
    readonly olderGap: 0 | 1;
    readonly newerGap: 0 | 1;
  }
  | { readonly kind: 'hilo'; readonly writer: 'mthi' | 'mtlo'; readonly reader: 'mfhi' | 'mflo'; readonly gap: HazardGap };

export interface PlannedHazardTarget {
  readonly target: HazardTarget;
  readonly classKey: string;
  /** Course forward/stall tuples a clean realization produces (forward targets only). */
  readonly tupleKeys: readonly string[];
  failures: number;
}

const gaps: readonly HazardGap[] = [0, 1, 2];
const maximumRealizationFailures = 3;
const priorityPairsPerShape = 2;

const producerClasses = new Set<HazardClass>(['cal_rr', 'cal_ri', 'lui', 'load', 'mv_fr', 'jal', 'cp0_fr']);
const consumerClasses = new Set<HazardClass>(['cal_rr', 'cal_ri', 'br_r1', 'br_r2', 'mv_to', 'load', 'store', 'mul_div', 'jr', 'jalr']);
/** Conditional moves write only on one outcome; they stay in the random stream. */
const excludedMnemonics = new Set(['movn', 'movz']);

/**
 * Producers that can deliver an exact in-range instruction address to JR/JALR (course
 * "值域匹配"): SLT-style, byte loads and LUI can never form 0x3000..0x6ffc.
 */
export const codeAddressProducers: ReadonlySet<string> = new Set([
  'add', 'addu', 'sub', 'subu', 'and', 'or', 'xor', 'nor', 'sllv', 'srlv', 'srav',
  'addi', 'addiu', 'andi', 'ori', 'xori', 'sll', 'srl', 'sra',
  'lw', 'lh', 'lhu', 'mfhi', 'mflo', 'jal'
]);

export function isHazardProducer(mnemonic: string): boolean {
  return producerClasses.has(hazardClassOf(mnemonic)) && !excludedMnemonics.has(mnemonic);
}

export function isHazardConsumer(mnemonic: string): boolean {
  return consumerClasses.has(hazardClassOf(mnemonic)) && !excludedMnemonics.has(mnemonic);
}

/** Structural feasibility independent of the generator's current register state. */
export function isFeasibleForwardTarget(producer: string, consumer: string, gap: HazardGap): boolean {
  const consumerClass = hazardClassOf(consumer);
  if (consumerClass === 'jr' || consumerClass === 'jalr') {
    if (!codeAddressProducers.has(producer)) return false;
    // JAL -> JR is the call/return idiom; JAL -> JR in its own delay slot is undefined.
    if (producer === 'jal' && (gap === 0 || consumerClass === 'jalr')) return false;
  }
  // A control transfer in JAL's delay slot is undefined behavior.
  return !(producer === 'jal' && gap === 0 && controlMnemonics.has(consumer));
}

const predictionCache = new Map<string, readonly string[]>();

/** Course tuples produced by `producer`, `gap` independent instructions, then `consumer`. */
export function predictForwardTuples(producer: string, consumer: string, role: SourceRole, gap: number): readonly string[] {
  const cacheKey = `${producer}|${consumer}|${role}|${gap}`;
  const cached = predictionCache.get(cacheKey);
  if (cached) return cached;
  const model = new HazardPipelineModel();
  const producerFacts = hazardInstructionFor(producer, { rd: '$1', rs: '$2', rt: '$1' });
  const destination = producerFacts?.write?.register;
  const keys: string[] = [];
  if (producerFacts && destination) {
    model.observe(producerFacts, { previous: 0, next: 1 });
    const nop = hazardInstructionFor('nop', {});
    for (let index = 0; index < gap && nop; index++) {
      model.observe(nop);
    }
    const other: SourceRole = role === 'rs' ? 'rt' : 'rs';
    const consumerFacts = hazardInstructionFor(consumer, { rd: '$5', [role]: destination, [other]: '$4' });
    if (consumerFacts) {
      const observation = model.observe(consumerFacts);
      for (const forward of observation.forwards) {
        keys.push(forwardTupleKey(forward.producer, forward.consumer, forward.source, forward.destination));
      }
      for (const stall of observation.stalls) {
        keys.push(stallTupleKey(stall.consumer, stall.cause, stall.interval));
      }
    }
  }
  predictionCache.set(cacheKey, keys);
  return keys;
}

/**
 * Chooses the next hazard scenario by coverage gap: first every class-level target (producer
 * class x consumer port x gap, discarded-$0 writes, forwarding priority, HI/LO), then course
 * mnemonic-level tuples. The coverage object is fed by the dynamic pipeline model, so hazards
 * that the random stream creates incidentally are never re-targeted.
 */
export class HazardTargetPlanner {
  private readonly targets: PlannedHazardTarget[];

  constructor(
    allowed: ReadonlySet<string>,
    private readonly coverage: HazardCoverage,
    shuffle: <T>(items: T[]) => T[]
  ) {
    this.targets = shuffle(enumerateTargets(allowed, shuffle));
  }

  get size(): number {
    return this.targets.length;
  }

  next(realizable: (target: HazardTarget) => boolean): PlannedHazardTarget | undefined {
    for (const tier of [1, 2] as const) {
      for (const planned of this.targets) {
        if (planned.failures >= maximumRealizationFailures || !this.open(planned, tier)) continue;
        if (realizable(planned.target)) return planned;
      }
    }
    return undefined;
  }

  /** Counts a realization that covered none of the target's open keys as a failure. */
  settle(planned: PlannedHazardTarget, openBefore: readonly string[]): void {
    if (!openBefore.some((key) => this.coverage.covers(key))) {
      planned.failures++;
    } else if (!this.open(planned, 1) && !this.open(planned, 2)) {
      planned.failures = maximumRealizationFailures;
    }
  }

  openKeys(planned: PlannedHazardTarget): string[] {
    return [planned.classKey, ...planned.tupleKeys].filter((key) => !this.coverage.covers(key));
  }

  hasOpenTargets(): boolean {
    return this.targets.some((planned) =>
      planned.failures < maximumRealizationFailures && (this.open(planned, 1) || this.open(planned, 2)));
  }

  private open(planned: PlannedHazardTarget, tier: 1 | 2): boolean {
    if (tier === 1) return !this.coverage.covers(planned.classKey);
    return planned.tupleKeys.some((key) => !this.coverage.covers(key));
  }
}

function enumerateTargets(allowed: ReadonlySet<string>, shuffle: <T>(items: T[]) => T[]): PlannedHazardTarget[] {
  const producers = Array.from(allowed).filter(isHazardProducer);
  const consumers = Array.from(allowed).filter(isHazardConsumer)
    .flatMap((consumer) => hazardSourceRoles(consumer).map((role) => ({ consumer, role })));
  const targets: PlannedHazardTarget[] = [];

  for (const producer of producers) {
    for (const { consumer, role } of consumers) {
      for (const gap of gaps) {
        if (!isFeasibleForwardTarget(producer, consumer, gap)) continue;
        targets.push({
          target: { kind: 'forward', producer, consumer, role, gap },
          classKey: forwardClassKey(hazardClassOf(producer), hazardClassOf(consumer), role, gap),
          tupleKeys: predictForwardTuples(producer, consumer, role, gap),
          failures: 0
        });
      }
    }
  }

  // Writes to $0 must never forward. One random gap per producer/consumer port keeps the
  // class-level key reachable without multiplying the target list.
  const zeroProducers = producers.filter((producer) => producer !== 'jal');
  const zeroConsumers = consumers.filter(({ consumer, role }) => {
    const consumerClass = hazardClassOf(consumer);
    return consumerClass !== 'jr' && consumerClass !== 'jalr' && !(role === 'rt' && (consumer === 'div' || consumer === 'divu'));
  });
  for (const producer of zeroProducers) {
    for (const { consumer, role } of zeroConsumers) {
      const gap = shuffle([...gaps])[0];
      targets.push({
        target: { kind: 'zero', producer, consumer, role, gap },
        classKey: zeroClassKey(hazardClassOf(producer), hazardClassOf(consumer), role),
        tupleKeys: [],
        failures: 0
      });
    }
  }

  // Two different values for the same register in flight: the younger one must win.
  const priorityProducers = producers.filter((producer) => producer !== 'jal');
  if (priorityProducers.length) {
    for (const { consumer, role } of zeroConsumers) {
      for (const [olderGap, newerGap] of [[0, 0], [0, 1], [1, 0]] as const) {
        for (let pair = 0; pair < priorityPairsPerShape; pair++) {
          const [older] = shuffle([...priorityProducers]);
          const [newer] = shuffle([...priorityProducers]);
          targets.push({
            target: { kind: 'priority', older, newer, consumer, role, olderGap, newerGap },
            classKey: priorityClassKey(hazardClassOf(consumer), role, olderGap, newerGap),
            tupleKeys: [],
            failures: 0
          });
        }
      }
    }
  }

  for (const [writer, reader] of [['mthi', 'mfhi'], ['mtlo', 'mflo']] as const) {
    if (!allowed.has(writer) || !allowed.has(reader)) continue;
    for (const gap of gaps) {
      targets.push({
        target: { kind: 'hilo', writer, reader, gap },
        classKey: hiLoClassKey(writer, reader, gap),
        tupleKeys: [],
        failures: 0
      });
    }
  }
  return targets;
}
