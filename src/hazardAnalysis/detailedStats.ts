// @index hazard-detailed-stats — Full-stream hazard counts with bounded mnemonic/port/gap key retention.
import type { HazardObservation } from './hazardPipeline';
import type { HazardDetailedStats, HazardDetailGroup, HazardObservability } from './reportTypes';

export const maximumDetailedKeys = 2048;

class Keys {
  readonly values = new Set<string>();
  truncated = false;
  constructor(private readonly limit: number) {}
  add(key: string): void {
    if (this.values.has(key)) return;
    if (this.values.size < this.limit) this.values.add(key);
    else this.truncated = true;
  }
  sorted(): string[] { return [...this.values].sort(); }
}

class Group {
  events = 0;
  validEvents = 0;
  readonly keys: Keys;
  readonly validKeys: Keys;
  readonly observability = { observable: 0, masked: 0, unknown: 0 };
  constructor(limit: number) { this.keys = new Keys(limit); this.validKeys = new Keys(limit); }
  add(key: string, valid: boolean, observability: HazardObservability): void {
    this.events++;
    this.keys.add(key);
    if (valid) { this.validEvents++; this.validKeys.add(key); }
    this.observability[observability]++;
  }
  result(): HazardDetailGroup {
    return { events: this.events, validEvents: this.validEvents, keys: this.keys.sorted(), validKeys: this.validKeys.sorted(),
      keysTruncated: this.keys.truncated, validKeysTruncated: this.validKeys.truncated,
      observability: { ...this.observability } };
  }
}

export class HazardDetailedAccumulator {
  private readonly forward: Group;
  private readonly zero: Group;
  private readonly priority: Group;
  private readonly hiLo: Group;
  private readonly stallKeys: Keys;
  private stallEvents = 0;
  constructor(limit = maximumDetailedKeys) {
    this.forward = new Group(limit); this.zero = new Group(limit);
    this.priority = new Group(limit); this.hiLo = new Group(limit); this.stallKeys = new Keys(limit);
  }
  record(observation: HazardObservation, consumer: string): void {
    for (const item of observation.forwards) this.forward.add(
      `${item.producer}>${item.consumer}.${item.role}+${item.gap}@${item.source}${item.destination}`, item.valid, item.observability);
    for (const item of observation.zeroDestinations) this.zero.add(
      `${item.producer}>${consumer}.${item.role}+${item.gap}`, item.valid, item.observability);
    for (const item of observation.priorities) this.priority.add(
      `${item.olderProducer}>${item.newerProducer}>${consumer}.${item.role}+${item.olderGap}/${item.newerGap}`, item.valid, item.observability);
    for (const item of observation.hiLo) this.hiLo.add(
      `${item.writer}>${item.reader}+${item.gap}`, item.valid, item.observability);
    for (const item of observation.stallCauses) {
      this.stallEvents++;
      this.stallKeys.add(`${item.cause}>${item.consumer}.${item.role}+${item.gap}#${item.interval}`);
    }
  }
  result(): HazardDetailedStats {
    return { schemaVersion: 1, forward: this.forward.result(), zero: this.zero.result(), priority: this.priority.result(), hiLo: this.hiLo.result(),
      stallCauses: { events: this.stallEvents, keys: this.stallKeys.sorted(), keysTruncated: this.stallKeys.truncated } };
  }
}
