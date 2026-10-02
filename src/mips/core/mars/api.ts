// @index mips-core — Resumable ordinary-MARS syscall DTOs; host IO stays outside the CPU
import { ProgramImage } from '../api';
import { MarsMemoryConfiguration } from '../profiles/marsMemoryLayout';

interface RequestBase { readonly id: number; readonly service: number; }
export type MarsIoRequest = RequestBase & (
  | { readonly kind: 'write'; readonly text: string }
  | { readonly kind: 'read-int' }
  | { readonly kind: 'read-float' }
  | { readonly kind: 'read-double' }
  | { readonly kind: 'read-char' }
  | { readonly kind: 'read-string'; readonly maxLength: number }
  | { readonly kind: 'open'; readonly path: string; readonly flags: number }
  | { readonly kind: 'read-file'; readonly fd: number; readonly length: number }
  | { readonly kind: 'write-file'; readonly fd: number; readonly bytes: readonly number[] }
  | { readonly kind: 'close'; readonly fd: number }
  | { readonly kind: 'time' }
  | { readonly kind: 'sleep'; readonly milliseconds: number }
);

/** A response matches the pending request id; errors become runtime diagnostics. */
export interface MarsIoResponse {
  readonly id: number;
  readonly value?: number;
  readonly text?: string;
  readonly bytes?: readonly number[];
  readonly time?: number;
  readonly error?: string;
}

export interface MarsSessionOptions {
  readonly image: ProgramImage;
  readonly memoryConfiguration?: MarsMemoryConfiguration;
  readonly delayedBranching?: boolean;
  readonly maxSteps?: number;
  /** Bound for each syscall buffer, including NUL-terminated strings. */
  readonly maxIoBytes?: number;
}

export interface MarsRuntimeDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly pc: number;
}

export type MarsStepResult =
  | { readonly status: 'running' }
  | { readonly status: 'waiting'; readonly request: MarsIoRequest }
  | { readonly status: 'exited'; readonly exitCode: number }
  | { readonly status: 'fault' | 'step-limit'; readonly diagnostic: MarsRuntimeDiagnostic };

export type MarsSliceResult = MarsStepResult & { readonly executed: number };
