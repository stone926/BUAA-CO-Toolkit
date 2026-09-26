// @index waveform-markers — 时间标记集合：稳定编号（删除其他标记不改名，空出的编号复用）、测量用活动标记、就近/相邻查找、持久化往返

import type { PersistedMarker } from '../model/viewStateContract';

export interface WaveMarker {
  /** Dump tick. */
  readonly time: number;
  /** Display number (M1, M2 …): kept while the marker exists, so removing others never renames it. */
  readonly label: number;
}

export function markerName(marker: WaveMarker): string {
  return `M${marker.label}`;
}

export class MarkerList {
  private markers: WaveMarker[] = [];
  /** Label of the marker used for Δ measurements. */
  private activeLabel: number | undefined;

  /** Markers in the order they were placed. */
  get all(): readonly WaveMarker[] {
    return this.markers;
  }

  get size(): number {
    return this.markers.length;
  }

  /** The marker used for Δ measurements. */
  get active(): WaveMarker | undefined {
    return this.find(this.activeLabel);
  }

  find(label: number | undefined): WaveMarker | undefined {
    return label === undefined ? undefined : this.markers.find((marker) => marker.label === label);
  }

  /** Place a marker at `time` with the smallest free label and make it active; a marker already there is reused. */
  add(time: number): WaveMarker {
    let marker = this.markers.find((candidate) => candidate.time === time);
    if (!marker) {
      marker = { time, label: smallestFreeLabel(new Set(this.markers.map((candidate) => candidate.label))) };
      this.markers.push(marker);
    }
    this.activeLabel = marker.label;
    return marker;
  }

  /** Move a marker, keeping its label, and make it active. Returns false when there is no such marker. */
  move(label: number, time: number): boolean {
    const index = this.markers.findIndex((marker) => marker.label === label);
    if (index < 0) {
      return false;
    }
    this.markers[index] = { time, label };
    this.activeLabel = label;
    return true;
  }

  activate(label: number): void {
    if (this.find(label)) {
      this.activeLabel = label;
    }
  }

  /** Returns false when there is no such marker. */
  remove(label: number): boolean {
    const before = this.markers.length;
    this.removeWhere((marker) => marker.label === label);
    return this.markers.length !== before;
  }

  clear(): void {
    this.markers = [];
    this.activeLabel = undefined;
  }

  /** Drop markers outside [start, end], e.g. after the dump was reloaded shorter. */
  retain(start: number, end: number): void {
    this.removeWhere((marker) => marker.time < start || marker.time > end);
  }

  /** The marker closest to `time` within `tolerance` ticks; on ties the later-placed one, which is drawn on top. */
  nearest(time: number, tolerance = Number.POSITIVE_INFINITY): WaveMarker | undefined {
    let best: WaveMarker | undefined;
    let bestDistance = tolerance;
    for (const marker of this.markers) {
      const distance = Math.abs(marker.time - time);
      if (distance <= bestDistance) {
        best = marker;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** The closest marker strictly after (`direction` 1) or before (-1) `time`. */
  adjacent(time: number, direction: -1 | 1): WaveMarker | undefined {
    let best: WaveMarker | undefined;
    for (const marker of this.markers) {
      if ((marker.time - time) * direction > 0 && (!best || (marker.time - best.time) * direction < 0)) {
        best = marker;
      }
    }
    return best;
  }

  /**
   * Replace the markers with saved ones inside [start, end]. Markers saved without a
   * label (older states) or with a repeated one get the smallest free labels.
   */
  restore(saved: readonly PersistedMarker[], start: number, end: number): void {
    const kept = saved.filter((marker) => marker.time >= start && marker.time <= end);
    const taken = new Set<number>();
    const labels = kept.map((marker) => {
      if (marker.label === undefined || taken.has(marker.label)) {
        return undefined;
      }
      taken.add(marker.label);
      return marker.label;
    });
    this.markers = kept.map((marker, index) => {
      let label = labels[index];
      if (label === undefined) {
        label = smallestFreeLabel(taken);
        taken.add(label);
      }
      return { time: marker.time, label };
    });
    this.activeLabel = this.markers[0]?.label;
  }

  toPersisted(): PersistedMarker[] {
    return this.markers.map(({ time, label }) => ({ time, label }));
  }

  /** Remove matching markers; when the active one goes, measure against the remaining marker closest to it. */
  private removeWhere(predicate: (marker: WaveMarker) => boolean): void {
    const active = this.active;
    this.markers = this.markers.filter((marker) => !predicate(marker));
    if (active && !this.find(active.label)) {
      this.activeLabel = this.nearest(active.time)?.label;
    }
  }
}

function smallestFreeLabel(taken: ReadonlySet<number>): number {
  let label = 1;
  while (taken.has(label)) {
    label++;
  }
  return label;
}
