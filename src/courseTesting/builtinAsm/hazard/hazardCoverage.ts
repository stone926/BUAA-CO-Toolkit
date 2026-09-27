// @index hazard-coverage — 冒险覆盖键（课程转发四元组/阻塞三元组 + 类别级目标）与覆盖统计
import { HazardObservation } from './hazardPipeline';
import { HazardClass, PipelineStage, SourceRole } from './hazardTiming';

export function forwardTupleKey(producer: string, consumer: string, source: PipelineStage, destination: PipelineStage): string {
  return `${producer}>${consumer}@${source}${destination}`;
}

export function stallTupleKey(consumer: string, cause: string, interval: number): string {
  return `${consumer}<${cause}#${interval}`;
}

export function forwardClassKey(producerClass: HazardClass, consumerClass: HazardClass, role: SourceRole, gap: number): string {
  return `fwd:${producerClass}>${consumerClass}.${role}+${gap}`;
}

export function zeroClassKey(producerClass: HazardClass, consumerClass: HazardClass, role: SourceRole): string {
  return `zero:${producerClass}>${consumerClass}.${role}`;
}

export function priorityClassKey(consumerClass: HazardClass, role: SourceRole, olderGap: number, newerGap: number): string {
  return `prio:${consumerClass}.${role}:${olderGap}/${newerGap}`;
}

export function hiLoClassKey(writer: string, reader: string, gap: number): string {
  return `hilo:${writer}>${reader}+${gap}`;
}

export interface HazardCoverageSummary {
  readonly forwardTuples: number;
  readonly stallTuples: number;
  readonly classTargets: number;
  readonly forwardEvents: number;
  readonly validForwardEvents: number;
}

/** Coverage that only counts hazards a wrong forwarding/stall decision would make observable. */
export class HazardCoverage {
  readonly forwardTuples = new Set<string>();
  readonly stallTuples = new Set<string>();
  readonly classKeys = new Set<string>();
  private forwardEvents = 0;
  private validForwardEvents = 0;

  record(observation: HazardObservation): void {
    for (const forward of observation.forwards) {
      this.forwardEvents++;
      if (!forward.valid) continue;
      this.validForwardEvents++;
      this.forwardTuples.add(forwardTupleKey(forward.producer, forward.consumer, forward.source, forward.destination));
      this.classKeys.add(forwardClassKey(forward.producerClass, forward.consumerClass, forward.role, forward.gap));
    }
    for (const stall of observation.stalls) {
      this.stallTuples.add(stallTupleKey(stall.consumer, stall.cause, stall.interval));
    }
    for (const zero of observation.zeroDestinations) {
      if (zero.valid) this.classKeys.add(zeroClassKey(zero.producerClass, zero.consumerClass, zero.role));
    }
    for (const priority of observation.priorities) {
      if (priority.valid) {
        this.classKeys.add(priorityClassKey(priority.consumerClass, priority.role, priority.olderGap, priority.newerGap));
      }
    }
    for (const hiLo of observation.hiLo) {
      if (hiLo.valid) this.classKeys.add(hiLoClassKey(hiLo.writer, hiLo.reader, hiLo.gap));
    }
  }

  covers(key: string): boolean {
    return this.forwardTuples.has(key) || this.stallTuples.has(key) || this.classKeys.has(key);
  }

  summary(): HazardCoverageSummary {
    return {
      forwardTuples: this.forwardTuples.size,
      stallTuples: this.stallTuples.size,
      classTargets: this.classKeys.size,
      forwardEvents: this.forwardEvents,
      validForwardEvents: this.validForwardEvents
    };
  }
}
