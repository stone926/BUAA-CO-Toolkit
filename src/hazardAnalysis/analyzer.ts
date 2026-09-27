// @index hazard-analyzer — 使用内置 MIPS 动态执行流生成有界课程冒险报告
import type { ProgramImage } from '../mips/core/api';
import { CommitEvent } from '../mips/core/events/commitEvent';
import { CourseSystemSession } from '../mips/core/machine/system';
import { evaluateInstruction } from '../mips/core/machine/transition';
import { matchExactInstruction } from '../mips/core/isa/decoder';
import { resolveCourseProfile } from '../mips/core/profiles/courseProfiles';
import { forwardTupleKey, stallTupleKey } from './hazardCoverage';
import { hazardInstructionFor } from './hazardInstruction';
import { HazardObservation, HazardObservationValues, HazardPipelineModel } from './hazardPipeline';
import {
  courseHazardClassOf, courseHazardGrade, courseHazardModelFor,
  courseHazardPairKey, courseHazardTheory, CourseHazardClass
} from './courseHazardTheory';
import type { HazardClassCoverage, HazardProfile, HazardReport, HazardReportEvent, HazardStopReason } from './reportTypes';

const defaultMaxSteps = 100000;
const absoluteMaxSteps = 1000000;
const defaultMaxEvents = 128;
const absoluteMaxEvents = 1000;
const defaultSliceSize = 256;
const analysisLayers = ['required', 'commonExtensions', 'marsCompatibility'] as const;

export interface AnalyzeHazardOptions {
  readonly profile: HazardProfile;
  readonly maxSteps?: number;
  readonly maxEvents?: number;
  readonly sliceSize?: number;
  readonly signal?: { readonly aborted: boolean };
  /** Called after each bounded slice; defaults to a host event-loop turn. */
  readonly yieldControl?: () => Promise<void>;
}

/** Analyze actual committed instructions; unused text and wrong-path fetches cannot create hazards. */
export async function analyzeHazardProgram(image: ProgramImage, options: AnalyzeHazardOptions): Promise<HazardReport> {
  const maxSteps = boundedOption(options.maxSteps, defaultMaxSteps, absoluteMaxSteps, 'maxSteps');
  const maxEvents = boundedOption(options.maxEvents, defaultMaxEvents, absoluteMaxEvents, 'maxEvents', true);
  const sliceSize = boundedOption(options.sliceSize, defaultSliceSize, 1024, 'sliceSize');
  const model = courseHazardModelFor(options.profile);
  const theory = courseHazardTheory[model];
  const pipeline = new HazardPipelineModel();
  const forwardTuples = new Set<string>();
  const stallTuples = new Set<string>();
  const classForwards = new Map<string, Set<string>>();
  const classStalls = new Map<string, Set<string>>();
  const destinationCache = new Map<number, number | null>();
  const events: HazardReportEvent[] = [];
  const warnings: string[] = [];
  let omittedWarnings = 0;
  let omittedEvents = 0;
  let forwardEvents = 0;
  let validForwardEvents = 0;
  let stopReason: HazardStopReason = 'engine-error';
  let stopPc = image.entryPc;
  const textEnd = contiguousTextEnd(image);
  const session = new CourseSystemSession({
    profile: resolveCourseProfile(options.profile), image, maxSteps, layers: analysisLayers,
    deviceSchedule: { kind: 'disabled' }
  });
  let lastInstruction: CommitEvent | undefined;

  try {
    outer: for (;;) {
      for (let index = 0; index < sliceSize; index++) {
        if (options.signal?.aborted) {
          stopReason = 'cancelled';
          break outer;
        }
        const pc = session.machine.state.pc >>> 0;
        if (textEnd !== undefined && pc === textEnd && lastInstruction
          && (lastInstruction.pcBefore + 4) >>> 0 === pc
          && lastInstruction.controlTarget === undefined
          && !lastInstruction.delaySlot
          && session.machine.state.pendingBranch === undefined) {
          stopReason = 'program-end';
          break outer;
        }
        const hiBefore = session.machine.state.hi;
        const loBefore = session.machine.state.lo;
        // The commit stream intentionally suppresses $0 writes. Ask the core's own pure evaluator
        // for that discarded value only when the decoded destination is $0.
        const fetchedWord = session.machine.memory.fetch(pc).word;
        let destination = fetchedWord === undefined ? null : destinationCache.get(fetchedWord);
        if (destination === undefined && fetchedWord !== undefined) {
          const entry = matchExactInstruction(fetchedWord, {
            profile: options.profile, enabledLayers: analysisLayers
          });
          const field = entry?.gprWrites[0];
          destination = typeof field === 'number' ? field
            : field === 'rd' ? (fetchedWord >>> 11) & 31
              : field === 'rt' ? (fetchedWord >>> 16) & 31
                : field === 'rs' ? (fetchedWord >>> 21) & 31 : null;
          destinationCache.set(fetchedWord, destination);
        }
        const previousValue = destination == null ? undefined : session.machine.state.gpr.read(destination);
        const zeroRaw = destination === 0 ? evaluateInstruction({
          profile: session.profile, state: session.machine.state, memory: session.machine.memory,
          scope: { profile: options.profile, enabledLayers: analysisLayers },
          undefinedBehavior: 'fail-closed'
        }).gprWrites.find((write) => write.register === 0)?.value : undefined;
        const result = session.stepInstruction();
        stopPc = session.machine.state.pc >>> 0;
        if (result.event?.kind === 'instruction') {
          const event = result.event;
          lastInstruction = event;
          const mnemonic = event.mnemonic;
          if (mnemonic && event.instructionWord !== undefined) {
            const word = event.instructionWord;
            const decoded = hazardInstructionFor(mnemonic, {
              rs: `$${(word >>> 21) & 31}`, rt: `$${(word >>> 16) & 31}`, rd: `$${(word >>> 11) & 31}`
            });
            const instruction = decoded && (mnemonic === 'movn' || mnemonic === 'movz')
              && !event.gprWrites.length && zeroRaw === undefined
              ? { ...decoded, write: undefined } : decoded;
            if (instruction) {
              const destination = instruction.write?.register;
              const registerNumber = destination ? Number(destination.slice(1)) : undefined;
              const values: HazardObservationValues = {
                pc: event.pcBefore,
                ...(registerNumber === undefined ? {} : {
                  previous: previousValue ?? 0,
                  next: event.gprWrites.find((write) => write.register === registerNumber)?.value ?? previousValue ?? 0,
                  ...(registerNumber === 0 && zeroRaw !== undefined ? { raw: zeroRaw } : {})
                }),
                hiLoPrevious: { hi: hiBefore, lo: loBefore },
                hiLoNext: { hi: session.machine.state.hi, lo: session.machine.state.lo }
              };
              record(pipeline.observe(instruction, values), event);
            }
          }
        } else if (result.event?.kind === 'exception' || result.event?.kind === 'interrupt') {
          pipeline.flush();
          lastInstruction = undefined;
          warn(`0x${result.event.pcBefore.toString(16).padStart(8, '0')} 发生${result.event.kind === 'exception' ? '异常' : '中断'}，流水线已清空`);
        }
        if (result.status !== 'committed') {
          stopReason = result.event?.haltReason ?? (result.status === 'step-limit' ? 'step-limit' : result.status === 'out-of-domain' ? 'out-of-domain' : 'engine-error');
          if (result.diagnostic) warn(`${result.diagnostic.code}: ${result.diagnostic.message}`);
          break outer;
        }
      }
      await (options.yieldControl?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 0)));
    }
  } catch (error) {
    stopReason = options.signal?.aborted ? 'cancelled' : 'engine-error';
    warn(error instanceof Error ? error.message : String(error));
  }

  if (omittedWarnings) warnings.push(`另有 ${omittedWarnings} 条重复异常/中断信息未展示`);
  if (stopReason === 'step-limit') warnings.push(`分析在 ${maxSteps} 步上限处截断，覆盖率为当前已执行部分`);
  if (stopReason === 'cancelled') warnings.push('分析已取消，覆盖率为取消前已执行部分');
  if (omittedEvents) warnings.push(`只保留前 ${maxEvents} 条事件示例，另有 ${omittedEvents} 条未展示；汇总仍包含全部事件`);

  const classCoverage = Object.entries(theory.byClass).map(([pair, bound]): HazardClassCoverage => {
    const [consumerClass, producerClass] = pair.split(' <~~ ') as [CourseHazardClass, CourseHazardClass];
    const forwardCovered = classForwards.get(pair)?.size ?? 0;
    const stallCovered = classStalls.get(pair)?.size ?? 0;
    return {
      pair, consumerClass, producerClass,
      forwardCovered, forwardExpected: bound.forward,
      stallCovered, stallExpected: bound.stall,
      forwardGrade: forwardCovered > bound.forward ? null : courseHazardGrade(bound.forward, forwardCovered) ?? null,
      stallGrade: stallCovered > bound.stall ? null : courseHazardGrade(bound.stall, stallCovered) ?? null
    };
  });
  const forwardOverBound = classCoverage.some((item) => item.forwardCovered > item.forwardExpected);
  const stallOverBound = classCoverage.some((item) => item.stallCovered > item.stallExpected);
  if (forwardOverBound || stallOverBound) {
    warnings.push('观察到超出课程理论表上限的组合；可能使用了扩展指令或不同流水线行为，相关评分不适用');
  }
  const forwardCovered = classCoverage.reduce((sum, item) => sum + item.forwardCovered, 0);
  const stallCovered = classCoverage.reduce((sum, item) => sum + item.stallCovered, 0);
  if (forwardTuples.size > forwardCovered || stallTuples.size > stallCovered) {
    warnings.push('部分事件不属于当前课程强度表的计分组合，已展示事件但未计入课程覆盖率');
  }
  return {
    version: 1, profile: options.profile, model, imageFingerprint: image.fingerprint,
    summary: {
      instructions: pipeline.instructions,
      cycles: pipeline.cycles,
      dataStallCycles: pipeline.dataStallCycles,
      multiplyDivideStallCycles: pipeline.multiplyDivideStallCycles,
      forwardEvents, validForwardEvents,
      forwardValidRate: forwardEvents ? validForwardEvents / forwardEvents : null,
      forwardCovered, forwardExpected: theory.forward,
      forwardCoverage: Math.min(1, forwardCovered / theory.forward),
      stallCovered, stallExpected: theory.stall,
      stallCoverage: Math.min(1, stallCovered / theory.stall),
      forwardGrade: forwardOverBound ? null : averageGrade(classCoverage.map((item) => item.forwardGrade)),
      stallGrade: stallOverBound ? null : averageGrade(classCoverage.map((item) => item.stallGrade))
    },
    classCoverage,
    forwardTuples: [...forwardTuples].sort(), stallTuples: [...stallTuples].sort(),
    events, omittedEvents, warnings, stopReason, stopPc
  };

  function record(observation: HazardObservation, commit: CommitEvent): void {
    const consumerOrder = pipeline.instructions - 1;
    function add(event: HazardReportEvent): void {
      if (events.length < maxEvents) events.push(event);
      else omittedEvents++;
    }
    for (const forward of observation.forwards) {
      forwardEvents++;
      if (forward.valid) {
        validForwardEvents++;
        const key = forwardTupleKey(forward.producer, forward.consumer, forward.source, forward.destination);
        forwardTuples.add(key);
        const consumerClass = courseHazardClassOf(forward.consumer);
        const producerClass = courseHazardClassOf(forward.producer);
        if (consumerClass && producerClass) addClassTuple(classForwards, consumerClass, producerClass, key);
      }
      add({ kind: 'forward', consumerPc: commit.pcBefore, consumerOrder, cycle: pipeline.cycles - 5, consumer: forward.consumer,
        producer: forward.producer, producerPc: forward.producerPc, producerOrder: forward.producerOrder, register: forward.register,
        role: forward.role, sourceStage: forward.source, destinationStage: forward.destination, valid: forward.valid });
    }
    for (const stall of observation.stalls) {
      const key = stallTupleKey(stall.consumer, stall.cause, stall.interval);
      stallTuples.add(key);
      const consumerClass = courseHazardClassOf(stall.consumer);
      const producerClass = courseHazardClassOf(stall.cause);
      if (consumerClass && producerClass) addClassTuple(classStalls, consumerClass, producerClass, key);
      add({ kind: 'stall', consumerPc: commit.pcBefore, consumerOrder, cycle: pipeline.cycles - 5, consumer: stall.consumer,
        producer: stall.cause, producerPc: stall.causePc, producerOrder: stall.causeOrder, register: stall.register,
        interval: stall.interval, sourceStage: stall.interval === 0 ? 'E' : 'M' });
    }
    for (const zero of observation.zeroDestinations) add({
      kind: 'zero', consumerPc: commit.pcBefore, consumerOrder, cycle: pipeline.cycles - 5, consumer: commit.mnemonic ?? '',
      producer: zero.producer, producerPc: zero.producerPc, producerOrder: zero.producerOrder,
      register: '$0', role: zero.role, valid: zero.valid
    });
    for (const priority of observation.priorities) add({
      kind: 'priority', consumerPc: commit.pcBefore, consumerOrder, cycle: pipeline.cycles - 5, consumer: commit.mnemonic ?? '',
      role: priority.role, valid: priority.valid
    });
    for (const hilo of observation.hiLo) add({
      kind: 'hilo', consumerPc: commit.pcBefore, consumerOrder, cycle: pipeline.cycles - 5, consumer: hilo.reader,
      producer: hilo.writer, producerPc: hilo.writerPc, valid: hilo.valid
    });
  }

  function addClassTuple(target: Map<string, Set<string>>, consumer: CourseHazardClass, producer: CourseHazardClass, key: string): void {
    const pair = courseHazardPairKey(consumer, producer);
    if (!theory.byClass[pair]) return;
    let set = target.get(pair);
    if (!set) target.set(pair, set = new Set<string>());
    set.add(key);
  }

  function warn(message: string): void {
    if (warnings.length < 20) warnings.push(message);
    else omittedWarnings++;
  }
}

function boundedOption(value: number | undefined, fallback: number, maximum: number, label: string, allowZero = false): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1) || result > maximum) {
    throw new RangeError(`${label} must be an integer in ${allowZero ? '0' : '1'}..${maximum}`);
  }
  return result;
}

function averageGrade(values: readonly (number | null)[]): number | null {
  const defined = values.filter((value): value is number => value !== null);
  return defined.length ? defined.reduce((sum, value) => sum + value, 0) / defined.length : null;
}

/** Only contiguous user text gets an implicit end; arbitrary image holes remain errors. */
function contiguousTextEnd(image: ProgramImage): number | undefined {
  const text = image.segments.filter((segment) => segment.name === 'text' && segment.baseAddress === image.entryPc);
  return text.length === 1 ? text[0].baseAddress + text[0].words.length * 4 : undefined;
}
