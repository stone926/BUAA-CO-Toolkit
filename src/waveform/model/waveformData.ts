// @index waveform-model — 可跨宿主/Webview 传输的波形数据契约：scope/var 表与按 track 列式存储的 typed-array 变化序列

import type { TimeScale } from './timeScale';

/** How values of one track are stored (`Bits`: four-state vectors in VPI aval/bval word planes). */
export const TrackEncoding = {
  Bits: 0,
  Real: 1,
  Text: 2
} as const;
export type TrackEncoding = typeof TrackEncoding[keyof typeof TrackEncoding];

export interface WaveScope {
  readonly name: string;
  /** VCD scope type such as `module`, `task`, `begin`. */
  readonly kind: string;
  /** Index of the parent scope, or -1 for a root. */
  readonly parent: number;
  /** Dot-joined hierarchical path, unique per scope after duplicate-block merging. */
  readonly path: string;
}

export interface WaveVar {
  /** Leaf name with escape backslashes removed (memory words keep their `[i]` suffix). */
  readonly name: string;
  /** Stable identity used by persisted signal lists. */
  readonly path: string;
  readonly scope: number;
  /** VCD var type such as `wire`, `reg`, `integer`, `parameter`, `real`, `event`. */
  readonly kind: string;
  readonly width: number;
  /** Declared bit range text such as `[31:0]`, when the dump provided one. */
  readonly range?: string;
  /** Most/least significant declared bit indexes, when known. */
  readonly msb?: number;
  readonly lsb?: number;
  readonly track: number;
}

/**
 * Columnar value-change storage. Track `t` owns changes
 * `changeStart[t] .. changeStart[t + 1] - 1`, whose times are ascending and whose
 * consecutive values always differ (except named-event tracks, where every change
 * is one trigger of the same value). For bit tracks, change `i` (relative to the
 * track) occupies `wordsPerValue[t]` words starting at `valueStart[t] + i * wordsPerValue[t]`
 * in `aval`, and in `bval` at `bvalStart[t] + …` when `bvalStart[t] >= 0`
 * (a negative `bvalStart` means the track never held x/z). Words are little-endian:
 * word 0 holds bits 31..0 of the value. Bit encoding follows VPI: (a,b) = 0:(0,0),
 * 1:(1,0), z:(0,1), x:(1,1). Real and text tracks index `reals`/`texts` from `valueStart[t]`.
 */
export interface WaveTracks {
  readonly count: number;
  readonly width: Uint32Array;
  readonly encoding: Uint8Array;
  readonly wordsPerValue: Uint32Array;
  readonly changeStart: Uint32Array;
  readonly times: Float64Array;
  readonly valueStart: Uint32Array;
  readonly bvalStart: Int32Array;
  readonly aval: Uint32Array;
  readonly bval: Uint32Array;
  readonly reals: Float64Array;
  readonly texts: readonly string[];
}

export type WaveDiagnosticSeverity = 'warning' | 'error';

export interface WaveDiagnostic {
  readonly severity: WaveDiagnosticSeverity;
  readonly message: string;
}

export interface WaveformData {
  readonly timescale: TimeScale;
  /** First and last timestamps present in the dump (both 0 for an empty dump). */
  readonly startTime: number;
  readonly endTime: number;
  readonly scopes: readonly WaveScope[];
  readonly vars: readonly WaveVar[];
  readonly tracks: WaveTracks;
  readonly diagnostics: readonly WaveDiagnostic[];
  readonly metadata: {
    readonly date?: string;
    readonly version?: string;
    readonly byteLength: number;
    readonly changeCount: number;
    /** True when the input ended inside the header or mid-token (e.g. still being written). */
    readonly incomplete: boolean;
  };
}

export function trackChangeCount(tracks: WaveTracks, track: number): number {
  return tracks.changeStart[track + 1] - tracks.changeStart[track];
}
