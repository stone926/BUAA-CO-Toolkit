// @index mips-providers — assembler/execution provider 契约：descriptor、capabilities、preflight、request/result
import * as vscode from 'vscode';
import { EngineCapabilities, EngineDescriptor, ProgramImage } from '../core/api';

/**
 * Provider-neutral engine contracts（计划第 5.3 节）。
 *
 * - Resolver 必须在产生任何副作用前完成 preflight；不支持时返回结构化
 *   capability diagnostic，禁止"执行到一半再隐式 fallback"。
 * - `EngineDescriptor + capabilities + catalog/contract/normalizer revision`
 *   共同构成证据 fingerprint。
 */

/** Structured capability failure; code 是稳定诊断码。 */
export interface CapabilityDiagnostic {
  code: string;
  message: string;
  /** Capability id this diagnostic refers to, when applicable. */
  capability?: string;
}

export interface ProviderPreflight {
  ok: boolean;
  diagnostics: CapabilityDiagnostic[];
  descriptor: EngineDescriptor;
}

/** Per-run context shared by both provider kinds. */
export interface ProviderRunContext {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

/** Engine-neutral process/run status (mirrors RunResult without the legacy name). */
export interface EngineRunStatus {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The process was stopped before its natural exit (for example by a halt detector or abort). */
  stopped?: boolean;
  /** Stable stop reason propagated from the process supervisor. */
  stopReason?: string;
  /** Process-level provenance; only meaningful for engines that spawn a process. */
  commandLine?: string;
  cwd?: string;
}

/** Content identity of the exact engine artifact used for one provider run. */
export interface EngineArtifactIdentity {
  sha256: string;
  role?: string;
  fileName?: string;
}

// ── Assembler ─────────────────────────────────────────────────────────────────

export interface AssembleTarget {
  /** `userText` = final text dump (0x3000..), `kernelText` = P7 kernel segment dump. */
  kind: 'userText' | 'kernelText';
  outputFile?: vscode.Uri;
}

export interface AssembleRequest {
  sourceUri: vscode.Uri;
  target: AssembleTarget;
  /** Course-trace invocation: enforces the course dump range and halt-loop validation. */
  courseTrace?: boolean;
  p7RiInstruction?: boolean;
  revealOutput?: boolean;
}

export interface AssembleResult {
  ok: boolean;
  outputFile?: vscode.Uri;
  /** PC of the validated final user-text self-branch (course-trace dumps only). */
  courseHaltPc?: number;
  status: EngineRunStatus;
  descriptor: EngineDescriptor;
  engineArtifact?: EngineArtifactIdentity;
}

export interface MipsAssemblerProvider {
  readonly descriptor: EngineDescriptor;
  readonly capabilities: EngineCapabilities;
  preflight(request: AssembleRequest): ProviderPreflight;
  assemble(request: AssembleRequest, context?: ProviderRunContext): Promise<AssembleResult>;
}

// ── Executor ─────────────────────────────────────────────────────────────────

/**
 * Execution input. The contract requires a ProgramImage in the domain model;
 * the legacy engine re-assembles from source, so `imageRef.kind === 'mars-dump'`
 * carries the validated dump plus its halt PC for that provider only.
 */
export type ExecuteImageRef =
  | { kind: 'mars-dump'; machineCodeUri: vscode.Uri; haltPc?: number }
  | { kind: 'program-image'; image: ProgramImage };

export interface ExecuteRequest {
  sourceUri: vscode.Uri;
  imageRef: ExecuteImageRef;
  stdin?: string;
  stdinSource?: vscode.Uri;
  traceOutput?: boolean;
  traceLevel?: 1 | 2;
  maxSteps?: number;
  haltPc?: number;
  interruptSchedule?: number[];
  p7RiInstruction?: boolean;
  runOutputFile?: vscode.Uri;
  courseTrace?: boolean;
  revealOutput?: boolean;
}

export interface ExecuteResult {
  ok: boolean;
  outputFile?: vscode.Uri;
  status: EngineRunStatus;
  descriptor: EngineDescriptor;
  engineArtifact?: EngineArtifactIdentity;
}

export interface MipsExecutionProvider {
  readonly descriptor: EngineDescriptor;
  readonly capabilities: EngineCapabilities;
  preflight(request: ExecuteRequest): ProviderPreflight;
  execute(request: ExecuteRequest, context?: ProviderRunContext): Promise<ExecuteResult>;
}

// ── Descriptors ───────────────────────────────────────────────────────────────

/** Legacy MARS engine: user-configured fork build, course-trace semantics. */
export const LEGACY_MARS_DESCRIPTOR: EngineDescriptor = {
  // This is deliberately not a pinned-reference id. Production executes the
  // user-configured JAR; conformance roles such as mars-assembler-v0.6.3 are
  // resolved and hash-verified separately.
  id: 'legacy-mars-configured',
  kind: 'full-stack',
  build: 'user-configured MARS artifact (unverified identity)',
  semanticsRevision: 1,
  capabilitiesRevision: 1
};

/** Builtin TS engine; registered only when its phases land (assembler: 5, executor: 2-3). */
export const BUILTIN_TS_DESCRIPTOR: EngineDescriptor = {
  id: 'builtin-ts',
  kind: 'full-stack',
  build: 'in-extension pure TypeScript course engine',
  semanticsRevision: 0,
  capabilitiesRevision: 0
};

/** Capabilities the legacy engine currently provides (behavior of the existing pipeline). */
export const LEGACY_MARS_CAPABILITIES: EngineCapabilities = {
  profiles: ['P2', 'P3', 'P4', 'P5', 'P6', 'P7'],
  instructionLayers: {
    required: [],
    commonExtensions: [],
    marsCompatibility: []
  },
  executionFeatures: [
    'delayed-branching',
    'overflow-traps',
    'cp0-exceptions',
    'timer-devices',
    'external-interrupt',
    'deterministic-console',
    'undefined-domain-classification'
  ],
  eventSchemaRevision: 1,
  courseContractRevision: 1
};

export function okPreflight(descriptor: EngineDescriptor): ProviderPreflight {
  return { ok: true, diagnostics: [], descriptor };
}

export function failedPreflight(
  descriptor: EngineDescriptor,
  diagnostics: CapabilityDiagnostic[]
): ProviderPreflight {
  return { ok: false, diagnostics, descriptor };
}
