// @index mips-core — Pure interactive debugger commands, snapshots and memory pages
import type { ProgramImage } from '../api';
import type { CourseProfile } from '../generated/isaCatalog';
import type { MachineSnapshot } from '../machine/session';
import type { MarsRuntimeDiagnostic } from '../mars/api';
import type { MarsMemoryConfiguration } from '../profiles/marsMemoryLayout';

export type DebugMode =
  | { readonly kind: 'mars'; readonly memoryConfiguration?: MarsMemoryConfiguration; readonly delayedBranching?: boolean }
  | { readonly kind: 'course'; readonly profile: CourseProfile };
export interface DebugMemoryRequest { readonly address: number; readonly words?: number }
export interface DebugSessionOptions {
  readonly image: ProgramImage;
  readonly mode: DebugMode;
  readonly maxSteps?: number;
  readonly breakpoints?: readonly number[];
  readonly memory?: DebugMemoryRequest;
}
export type DebugCommand =
  | { readonly kind: 'step' | 'continue' | 'pause' | 'stop' }
  | { readonly kind: 'memory'; readonly address: number; readonly words?: number }
  | { readonly kind: 'set-breakpoints'; readonly addresses: readonly number[] };
export interface DebugMemoryPage {
  readonly address: number;
  readonly words: readonly { readonly address: number; readonly value?: number; readonly unavailable?: string }[];
}
export type DebugStatus = 'paused' | 'running' | 'exited' | 'fault' | 'step-limit' | 'stopped';
export interface DebugSnapshot extends MachineSnapshot {
  readonly fpr?: readonly number[];
  readonly fpConditionFlags?: number;
  readonly instructions: number;
  readonly status: DebugStatus;
  readonly reason: 'entry' | 'step' | 'breakpoint' | 'pause' | 'slice' | 'terminal';
  readonly breakpoints: readonly number[];
  readonly memory: DebugMemoryPage;
  readonly diagnostic?: MarsRuntimeDiagnostic;
  readonly exitCode?: number;
}
export interface DebugProgress { readonly kind: 'mars-debug'; readonly snapshot: DebugSnapshot }
