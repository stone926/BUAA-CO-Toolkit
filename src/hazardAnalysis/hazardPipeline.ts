// @index hazard-pipeline — 课程五级流水线 AT 模型：按动态指令流推算 D 级阻塞、首次正确值转发、优先级与 $0 写
import { HazardInstruction } from './hazardInstruction';
import { HazardClass, pipelineStageIndex, pipelineStages, PipelineStage, SourceRole } from './hazardTiming';

export interface HazardObservationValues {
  readonly pc?: number;
  /** Destination value before this instruction (architectural stale value). */
  readonly previous?: number;
  /** Destination value after this instruction. */
  readonly next?: number;
  /** Value the instruction computed before `$0` discarded it. */
  readonly raw?: number;
  readonly hiLoPrevious?: { readonly hi: number; readonly lo: number };
  readonly hiLoNext?: { readonly hi: number; readonly lo: number };
}

export interface ForwardEvent {
  readonly producer: string;
  readonly producerPc?: number;
  readonly producerClass: HazardClass;
  /** Dynamic index of the producer (0 = first observed instruction). */
  readonly producerOrder: number;
  readonly register: string;
  readonly consumer: string;
  readonly consumerClass: HazardClass;
  readonly role: SourceRole;
  /** Dynamic instructions between producer and consumer. */
  readonly gap: number;
  readonly source: PipelineStage;
  readonly destination: PipelineStage;
  /** Course validity: the forwarded value differs from what the GRF holds at that moment. */
  readonly valid: boolean;
}

export interface StallEvent {
  readonly consumer: string;
  readonly consumerClass: HazardClass;
  readonly cause: string;
  readonly causePc?: number;
  readonly causeClass: HazardClass;
  /** Dynamic index of the stalling producer. */
  readonly causeOrder: number;
  readonly register: string;
  /** Course interval: instructions between D and the stalling stage (E=0, M=1). */
  readonly interval: number;
}

export interface ZeroDestinationEvent {
  readonly producer: string;
  readonly producerPc?: number;
  readonly producerOrder: number;
  readonly producerClass: HazardClass;
  readonly consumerClass: HazardClass;
  readonly role: SourceRole;
  readonly gap: number;
  /** The discarded write carried a nonzero value, so forwarding it would be observable. */
  readonly valid: boolean;
}

export interface PriorityEvent {
  readonly consumerClass: HazardClass;
  readonly role: SourceRole;
  /** Instructions between the older and the newer in-flight writer. */
  readonly olderGap: number;
  /** Instructions between the newer writer and the consumer. */
  readonly newerGap: number;
  readonly valid: boolean;
}

export interface HiLoEvent {
  readonly writer: string;
  readonly writerPc?: number;
  readonly reader: string;
  readonly gap: number;
  readonly valid: boolean;
}

export interface HazardObservation {
  readonly forwards: readonly ForwardEvent[];
  readonly stalls: readonly StallEvent[];
  readonly zeroDestinations: readonly ZeroDestinationEvent[];
  readonly priorities: readonly PriorityEvent[];
  readonly hiLo: readonly HiLoEvent[];
}

interface InFlightWrite {
  readonly order: number;
  readonly pc?: number;
  readonly mnemonic: string;
  readonly hazardClass: HazardClass;
  readonly register: string;
  readonly executeCycle: number;
  readonly readyCycle: number;
  readonly writebackCycle: number;
  readonly previous: number;
  readonly next: number;
}

interface HiLoWrite {
  readonly order: number;
  readonly pc?: number;
  readonly mnemonic: string;
  readonly changed: boolean;
}

const hiLoHazardWindow = 2;

/**
 * Cycle model of the course reference pipeline: every stall happens in D against E/M/W, all
 * forwarding follows the AT method, and the multiply/divide unit blocks D while it is busy.
 * Feed it the dynamic instruction stream (skipped instructions omitted) in execution order.
 */
export class HazardPipelineModel {
  private nextDecodeCycle = 0;
  private lastWritebackCycle = -1;
  private instructionCount = 0;
  /** D-stage bubbles caused by data hazards (AT method). */
  dataStallCycles = 0;
  /** D-stage bubbles caused by a busy multiply/divide unit. */
  multiplyDivideStallCycles = 0;

  /** Committed instructions observed so far. */
  get instructions(): number {
    return this.instructionCount;
  }

  /** Clock cycles from the first fetch until the last instruction leaves W. */
  get cycles(): number {
    return this.lastWritebackCycle < 0 ? 0 : this.lastWritebackCycle + 2;
  }
  private order = 0;
  private writes: InFlightWrite[] = [];
  private zeroWrites: InFlightWrite[] = [];
  private mduFreeCycle = 0;
  private readonly hiLoWrites = new Map<'hi' | 'lo', HiLoWrite>();

  observe(instruction: HazardInstruction, values: HazardObservationValues = {}): HazardObservation {
    const decodeCycle = this.nextDecodeCycle;
    const order = this.order++;
    this.instructionCount++;
    const dependencies: Array<{
      readonly role: SourceRole;
      readonly register: string;
      readonly writer: InFlightWrite;
      readonly older?: InFlightWrite;
      readonly requiredExecute: number;
    }> = [];
    let executeCycle = decodeCycle + 1;
    for (const read of instruction.reads) {
      if (read.register === '$0') continue;
      const writers = this.inFlightWriters(read.register, decodeCycle);
      const writer = writers[0];
      if (!writer) continue;
      const requiredExecute = writer.readyCycle - pipelineStageIndex[read.useStage] + 2;
      executeCycle = Math.max(executeCycle, requiredExecute);
      dependencies.push({ role: read.role, register: read.register, writer, older: writers[1], requiredExecute });
    }
    if (instruction.usesMdu) {
      executeCycle = Math.max(executeCycle, this.mduFreeCycle);
    }

    const stalls: StallEvent[] = [];
    const stallKeys = new Set<string>();
    for (let cycle = decodeCycle; cycle < executeCycle - 1; cycle++) {
      let cause: typeof dependencies[number] | undefined;
      for (const dependency of dependencies) {
        if (dependency.requiredExecute > cycle + 1 && (!cause || dependency.requiredExecute > cause.requiredExecute)) {
          cause = dependency;
        }
      }
      if (!cause) {
        this.multiplyDivideStallCycles++; // Busy MDU; the course statistics exclude it.
        continue;
      }
      this.dataStallCycles++;
      const interval = cycle - cause.writer.executeCycle;
      const key = `${cause.writer.order}:${interval}`;
      if (stallKeys.has(key)) continue;
      stallKeys.add(key);
      stalls.push({
        consumer: instruction.mnemonic,
        consumerClass: instruction.hazardClass,
        cause: cause.writer.mnemonic,
        ...(cause.writer.pc === undefined ? {} : { causePc: cause.writer.pc }),
        causeClass: cause.writer.hazardClass,
        causeOrder: cause.writer.order,
        register: cause.register,
        interval
      });
    }

    const forwards: ForwardEvent[] = [];
    const priorities: PriorityEvent[] = [];
    for (const dependency of dependencies) {
      const { writer } = dependency;
      const forwardCycle = Math.max(decodeCycle, writer.readyCycle);
      const destinationIndex = forwardCycle < executeCycle ? 0 : 1 + forwardCycle - executeCycle;
      forwards.push({
        producer: writer.mnemonic,
        ...(writer.pc === undefined ? {} : { producerPc: writer.pc }),
        producerClass: writer.hazardClass,
        producerOrder: writer.order,
        register: dependency.register,
        consumer: instruction.mnemonic,
        consumerClass: instruction.hazardClass,
        role: dependency.role,
        gap: order - writer.order - 1,
        source: pipelineStages[1 + forwardCycle - writer.executeCycle],
        destination: pipelineStages[destinationIndex],
        valid: writer.next !== this.registerFileValue(dependency.register, forwardCycle)
      });
      if (dependency.older) {
        priorities.push({
          consumerClass: instruction.hazardClass,
          role: dependency.role,
          olderGap: writer.order - dependency.older.order - 1,
          newerGap: order - writer.order - 1,
          valid: writer.next !== dependency.older.next
        });
      }
    }

    const zeroDestinations: ZeroDestinationEvent[] = [];
    for (const read of instruction.reads) {
      if (read.register !== '$0') continue;
      for (const zero of this.zeroWrites) {
        if (zero.writebackCycle < decodeCycle) continue;
        zeroDestinations.push({
          producer: zero.mnemonic,
          ...(zero.pc === undefined ? {} : { producerPc: zero.pc }),
          producerOrder: zero.order,
          producerClass: zero.hazardClass,
          consumerClass: instruction.hazardClass,
          role: read.role,
          gap: order - zero.order - 1,
          valid: zero.next !== 0
        });
      }
    }

    const hiLo: HiLoEvent[] = [];
    if (instruction.hazardClass === 'mv_fr') {
      for (const half of instruction.hiLoReads) {
        const writer = this.hiLoWrites.get(half);
        const gap = writer ? order - writer.order - 1 : Infinity;
        if (writer && gap <= hiLoHazardWindow) {
          hiLo.push({ writer: writer.mnemonic, ...(writer.pc === undefined ? {} : { writerPc: writer.pc }), reader: instruction.mnemonic, gap, valid: writer.changed });
        }
      }
    }

    this.commit(instruction, values, order, executeCycle);
    return { forwards, stalls, zeroDestinations, priorities, hiLo };
  }

  /** The pipeline drained (exception entry): nothing older can forward to later instructions. */
  flush(): void {
    this.writes = [];
    this.zeroWrites = [];
    this.hiLoWrites.clear();
    this.nextDecodeCycle += pipelineStages.length;
  }

  /** Newest-first GPR writers that have not left W before `decodeCycle`. */
  inFlightWriters(register: string, decodeCycle = this.nextDecodeCycle): InFlightWrite[] {
    const result: InFlightWrite[] = [];
    for (let index = this.writes.length - 1; index >= 0; index--) {
      const write = this.writes[index];
      if (write.register === register && write.writebackCycle >= decodeCycle) {
        result.push(write);
      }
    }
    return result;
  }

  /** In-flight destination registers (newest first) with their producer and dynamic gap. */
  pendingProducers(): Array<{ register: string; producer: string; producerClass: HazardClass; gap: number; changed: boolean }> {
    const seen = new Set<string>();
    const result: Array<{ register: string; producer: string; producerClass: HazardClass; gap: number; changed: boolean }> = [];
    for (let index = this.writes.length - 1; index >= 0; index--) {
      const write = this.writes[index];
      if (write.writebackCycle < this.nextDecodeCycle || seen.has(write.register)) continue;
      seen.add(write.register);
      result.push({
        register: write.register,
        producer: write.mnemonic,
        producerClass: write.hazardClass,
        gap: this.order - write.order - 1,
        changed: write.next !== write.previous
      });
    }
    return result;
  }

  private registerFileValue(register: string, cycle: number): number {
    let oldest: InFlightWrite | undefined;
    for (let index = this.writes.length - 1; index >= 0; index--) {
      const write = this.writes[index];
      if (write.register !== register) continue;
      if (write.writebackCycle < cycle) return write.next;
      oldest = write;
    }
    return oldest?.previous ?? 0;
  }

  private commit(instruction: HazardInstruction, values: HazardObservationValues, order: number, executeCycle: number): void {
    const write = instruction.write;
    if (write) {
      const record: InFlightWrite = {
        order,
        ...(values.pc === undefined ? {} : { pc: values.pc }),
        mnemonic: instruction.mnemonic,
        hazardClass: instruction.hazardClass,
        register: write.register,
        executeCycle,
        readyCycle: executeCycle + pipelineStageIndex[write.readyStage] - pipelineStageIndex.E,
        writebackCycle: executeCycle + 2,
        previous: values.previous ?? 0,
        next: write.register === '$0' ? values.raw ?? 0 : values.next ?? 0
      };
      (write.register === '$0' ? this.zeroWrites : this.writes).push(record);
    }
    if (instruction.mduBusyCycles > 0) {
      // A five-cycle MULT occupies its issue cycle plus four following cycles.
      this.mduFreeCycle = executeCycle + instruction.mduBusyCycles;
    }
    for (const half of instruction.hiLoWrites) {
      const before = values.hiLoPrevious?.[half];
      const after = values.hiLoNext?.[half];
      this.hiLoWrites.set(half, { order, ...(values.pc === undefined ? {} : { pc: values.pc }), mnemonic: instruction.mnemonic, changed: before !== after });
    }
    this.nextDecodeCycle = executeCycle;
    this.lastWritebackCycle = executeCycle + 2;
    this.writes = this.writes.filter((item) => item.writebackCycle >= executeCycle);
    this.zeroWrites = this.zeroWrites.filter((item) => item.writebackCycle >= executeCycle);
  }
}
