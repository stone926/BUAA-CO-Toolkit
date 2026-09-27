// @index hazard-tracker — 把生成器按静态顺序发出的指令转成动态执行流送入流水线模型并累计冒险覆盖
import { CpuState } from '../../cpuState';
import { HazardCoverage } from '../../../hazardAnalysis/hazardCoverage';
import { decodeHazardInstruction, HazardInstruction } from '../../../hazardAnalysis/hazardInstruction';
import { HazardObservationValues, HazardPipelineModel } from '../../../hazardAnalysis/hazardPipeline';

interface PendingRecord {
  readonly index: number;
  readonly decoded: HazardInstruction | undefined;
  readonly executed: boolean;
  readonly previous: number | undefined;
  readonly hiLoPrevious: { hi: number; lo: number };
  victim: boolean;
  values?: HazardObservationValues;
}

/**
 * Observes each emitted instruction once its modeled effects are applied (the generator updates
 * CpuState right after emitting), then feeds the pipeline model in dynamic order. Skipped
 * instructions never enter the pipeline; an exception victim drains it for the handler.
 */
export class HazardTracker {
  readonly coverage = new HazardCoverage();
  readonly model = new HazardPipelineModel();
  private pending: PendingRecord | undefined;
  private group: PendingRecord[] | undefined;

  constructor(private readonly state: CpuState) {}

  record(index: number, text: string, executed: boolean): void {
    this.settle();
    const decoded = decodeHazardInstruction(text);
    const destination = decoded?.write?.register;
    this.state.lastWrite = undefined;
    this.pending = {
      index,
      decoded,
      executed,
      previous: destination ? this.state.regValue(destination) : undefined,
      hiLoPrevious: { hi: this.state.hi, lo: this.state.lo },
      victim: false
    };
  }

  markVictim(index: number): void {
    if (this.pending?.index === index) {
      this.pending.victim = true;
      return;
    }
    const grouped = this.group?.find((record) => record.index === index);
    if (grouped) {
      grouped.victim = true;
      return;
    }
    // Already observed: the handler still drains the pipeline before execution resumes.
    this.model.flush();
  }

  /** Instructions recorded until `endGroup` execute in a caller-specified dynamic order. */
  beginGroup(): void {
    this.settle();
    this.group = [];
  }

  /** `order` lists group-relative positions in execution order; omitted ones never execute. */
  endGroup(order: readonly number[]): void {
    this.settle();
    const records = this.group ?? [];
    this.group = undefined;
    for (const position of order) {
      const record = records[position];
      if (record) this.feed(record);
    }
  }

  settle(): void {
    const record = this.pending;
    if (!record) return;
    this.pending = undefined;
    const destination = record.decoded?.write?.register;
    const lastWrite = this.state.lastWrite;
    record.values = {
      previous: record.previous,
      next: destination ? this.state.regValue(destination) : undefined,
      raw: destination && lastWrite?.register === destination ? lastWrite.value : undefined,
      hiLoPrevious: record.hiLoPrevious,
      hiLoNext: { hi: this.state.hi, lo: this.state.lo }
    };
    if (this.group) {
      this.group.push(record);
    } else {
      this.feed(record);
    }
  }

  private feed(record: PendingRecord): void {
    if (record.victim) {
      this.model.flush();
      return;
    }
    if (record.executed && record.decoded) {
      this.coverage.record(this.model.observe(record.decoded, record.values));
    }
  }
}
