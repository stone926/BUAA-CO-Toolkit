// @index waveform-protocol — 波形编辑器宿主与 Webview 之间的消息契约（加载进度/文档/trace/定位/持久化/源码跳转）

import type { PersistedViewState } from './viewStateContract';
import type { WaveformData } from './waveformData';

export type WaveformTraceKind = 'grf' | 'dm';

/** One architectural write printed by the testbench (`$display`), placed on the dump's time axis. */
export interface WaveformTraceEvent {
  /** Dump ticks. */
  readonly time: number;
  readonly kind: WaveformTraceKind;
  readonly pc: string;
  /** Register number (GRF) or byte address (DM) as printed. */
  readonly target: string;
  readonly value: string;
}

export interface WaveformTraceData {
  /** File the events came from (for display only). */
  readonly source: string;
  /** Sorted by time. */
  readonly events: readonly WaveformTraceEvent[];
  /** Explains why some or all trace lines could not be placed on the time axis. */
  readonly note?: string;
}

export type HostToWebviewMessage =
  | { readonly type: 'init'; readonly fileName: string; readonly state?: PersistedViewState }
  | { readonly type: 'progress'; readonly loadedBytes: number; readonly totalBytes: number }
  | { readonly type: 'document'; readonly data: WaveformData; readonly reload: boolean }
  | { readonly type: 'trace'; readonly trace?: WaveformTraceData }
  | { readonly type: 'error'; readonly message: string; readonly canRetry: boolean }
  | { readonly type: 'revealTime'; readonly time: number }
  | { readonly type: 'addSignals'; readonly paths: readonly string[] };

export type WebviewToHostMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'saveState'; readonly state: PersistedViewState }
  | { readonly type: 'openSource'; readonly path: string; readonly scope: boolean }
  | { readonly type: 'reload'; readonly force?: boolean }
  | { readonly type: 'copyText'; readonly text: string };
