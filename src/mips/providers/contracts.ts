// @index mips-providers — assembler/execution provider 契约：descriptor、capabilities、preflight、request/result
import * as vscode from 'vscode';
import {
  DeviceCapabilityId,
  EngineCapabilities,
  EngineDescriptor,
  InstructionLayer,
  ProgramImage,
  SourceUnit,
  SourceUnitFingerprint
} from '../core/api';
import type { CommitEvent } from '../core/events/commitEvent';
import type { CoverageBin } from '../core/events/coverage';
import type { CpuTraceEvent } from '../../language/mips/traceParser';
import { isaInstructions } from '../core/generated/isaCatalog';
import {
  BUILTIN_TS_ENGINE_ID,
  LEGACY_MARS_ENGINE_ID
} from './courseEnginePolicy';

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

export type ProviderPreflightResult = ProviderPreflight | Promise<ProviderPreflight>;

/** Per-run context shared by both provider kinds. */
export interface ProviderRunContext {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Stream canonical commit events when the selected provider exposes them. */
  onCommitEvent?: (event: CommitEvent) => void;
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

/** Capabilities a caller relies on. Providers must reject these before starting any process. */
export interface ProviderCapabilityRequirements {
  profile?: string;
  instructionLayers?: readonly InstructionLayer[];
  directives?: readonly string[];
  pseudoInstructions?: boolean;
  syscallMode?: 'mars-services' | 'course-exception';
  devices?: readonly DeviceCapabilityId[];
  deterministicConsole?: boolean;
  interactiveConsole?: boolean;
  eventSchemaRevision?: number;
}

/** Content identity of the exact engine artifact used for one provider run. */
export interface EngineArtifactIdentity {
  sha256: string;
  role?: string;
  fileName?: string;
  /** Immutable runtime companions (for example the pinned P7 RI instruction class). */
  dependencies?: EngineArtifactIdentity[];
}

// ── Assembler ─────────────────────────────────────────────────────────────────

export interface AssembleTarget {
  /** `userText` = final text dump (0x3000..), `kernelText` = P7 kernel segment dump. */
  kind: 'userText' | 'kernelText';
  outputFile?: vscode.Uri;
}

export interface AssembleRequest {
  sourceUri: vscode.Uri;
  /** Host-verified complete source graph identity when the caller already captured one. */
  inputGraph?: readonly SourceUnitFingerprint[];
  /** Verified original blobs/edges; builtin assemblers consume this instead of rewritten files. */
  sourceGraphInput?: {
    readonly rootId: string;
    readonly sources: readonly SourceUnit[];
    readonly includes: readonly {
      readonly fromId: string;
      readonly specifier: string;
      readonly toId: string;
    }[];
  };
  target: AssembleTarget;
  /** Course-trace invocation: enforces the course dump range and halt-loop validation. */
  courseTrace?: boolean;
  p7RiInstruction?: boolean;
  revealOutput?: boolean;
  requirements?: ProviderCapabilityRequirements;
}

export interface AssembleResult {
  ok: boolean;
  outputFile?: vscode.Uri;
  /** PC of the validated final user-text self-branch (course-trace dumps only). */
  courseHaltPc?: number;
  status: EngineRunStatus;
  descriptor: EngineDescriptor;
  engineArtifact?: EngineArtifactIdentity;
  /** Exact process/configuration values resolved before this run produced side effects. */
  resolvedRun?: ResolvedEngineRun;
  /** Authoritative domain image produced by the assembly stage. */
  image?: ProgramImage;
  /** Opaque-to-orchestration binding needed by source-reassembling legacy engines. */
  executionBinding?: ProviderExecutionBinding;
}

export interface MipsAssemblerProvider {
  readonly descriptor: EngineDescriptor;
  readonly capabilities: EngineCapabilities;
  preflight(request: AssembleRequest): ProviderPreflightResult;
  assemble(request: AssembleRequest, context?: ProviderRunContext): Promise<AssembleResult>;
}

// ── Executor ─────────────────────────────────────────────────────────────────

/**
 * Provider-owned source binding returned by an assembler adapter. The course pipeline treats this
 * as an identity-bound capability and never reads the source path or branches on the engine kind.
 * A native ProgramImage executor does not need a binding.
 */
export interface ProviderExecutionBinding {
  kind: 'source-reassembly';
  providerId: string;
  sourceUri: vscode.Uri;
  imageFingerprint: string;
}

export interface ArchitecturalWriteTraceRequest {
  kind: 'architectural-writes';
  /** Require the provider to reject implementation-specific/undefined legacy behavior. */
  courseCorrect: true;
}

/** Provider-neutral projection consumed by course trace comparison. */
export interface ArchitecturalWriteTrace {
  schemaRevision: 1;
  eventSchema: 'buaa-co-architectural-write-v1';
  events: readonly CpuTraceEvent[];
  rawText: string;
  /** Exact provider raw-trace revision, retained for replay provenance only. */
  rawTraceRevision: number;
}

export interface ExecuteRequest {
  /** Every executor receives the immutable domain image, including legacy source adapters. */
  image: ProgramImage;
  /** Course profile when the caller already resolved one; legacy derives it from its launch. */
  profile?: string;
  /** Memory configuration only as provenance/validation; the builtin core ignores it. */
  memoryConfiguration?: string;
  executionBinding?: ProviderExecutionBinding;
  stdin?: string;
  stdinSource?: vscode.Uri;
  trace?: ArchitecturalWriteTraceRequest;
  maxSteps?: number;
  haltPc?: number;
  interruptSchedule?: number[];
  p7RiInstruction?: boolean;
  runOutputFile?: vscode.Uri;
  courseTrace?: boolean;
  revealOutput?: boolean;
  requirements?: ProviderCapabilityRequirements;
}

export type EngineStopKind =
  | 'halt-loop'
  | 'completed'
  | 'cancelled'
  | 'timeout'
  | 'engine-error'
  | 'out-of-domain'
  | 'step-limit';

export interface ExecuteResult {
  ok: boolean;
  outputFile?: vscode.Uri;
  status: EngineRunStatus;
  descriptor: EngineDescriptor;
  engineArtifact?: EngineArtifactIdentity;
  /** Exact process/configuration values resolved before this run produced side effects. */
  resolvedRun?: ResolvedEngineRun;
  trace?: ArchitecturalWriteTrace;
  stop?: {
    kind: EngineStopKind;
    haltPc?: number;
  };
  /**
   * Phase-4 builtin evidence. Providers without structured commit events omit it;
   * callers must never assume two different engines expose the same schema.
   */
  events?: readonly CommitEvent[];
  /** Number of architectural instructions executed by this run. */
  instructions?: number;
  eventCount?: number;
  eventDigest?: string;
  coverage?: readonly CoverageBin[];
  finalStateDigest?: string;
  checkpoints?: readonly { readonly instruction: number; readonly digest: string }[];
  /** Canonical structured event artifact produced by the provider, when one exists. */
  eventArtifact?: vscode.Uri;
}

export interface ResolvedEngineRun {
  profile: string;
  memoryConfiguration: string;
  /** In-process TS runs have no command line; the runtime kind makes that explicit. */
  runtime: { kind: 'java'; command: string } | { kind: 'builtin-ts' };
  wallClockMs: number;
  p7RiInstruction: boolean;
}

export interface MipsExecutionProvider {
  readonly descriptor: EngineDescriptor;
  readonly capabilities: EngineCapabilities;
  preflight(request: ExecuteRequest): ProviderPreflightResult;
  execute(request: ExecuteRequest, context?: ProviderRunContext): Promise<ExecuteResult>;
}

// ── Descriptors ───────────────────────────────────────────────────────────────

/** Legacy MARS engine: user-configured fork build, course-trace semantics. */
export const LEGACY_MARS_DESCRIPTOR: EngineDescriptor = {
  // This is deliberately not a pinned-reference id. Production executes the
  // user-configured JAR; conformance roles such as mars-assembler-v0.6.3 are
  // resolved and hash-verified separately.
  id: LEGACY_MARS_ENGINE_ID,
  kind: 'full-stack',
  build: 'user-configured MARS artifact (unverified identity)',
  semanticsRevision: 1,
  capabilitiesRevision: 1
};

/** Builtin TS engine; registered only when its phases land (assembler: 5, executor: 2-3). */
export const BUILTIN_TS_DESCRIPTOR: EngineDescriptor = {
  id: BUILTIN_TS_ENGINE_ID,
  kind: 'executor',
  build: 'in-extension pure TypeScript course executor (phase 2-3 core)',
  semanticsRevision: 1,
  capabilitiesRevision: 1
};

/** Capabilities the legacy engine currently provides (behavior of the existing pipeline). */
export const LEGACY_MARS_CAPABILITIES: EngineCapabilities = {
  profiles: ['P2', 'P3', 'P4', 'P5', 'P6', 'P7'],
  instructionLayers: Object.fromEntries(
    (['required', 'commonExtensions', 'marsCompatibility'] as const).map((layer) => [
      layer,
      [...new Set(isaInstructions.filter((instruction) => instruction.layer === layer)
        .map((instruction) => instruction.mnemonic))].sort()
    ])
  ),
  assembly: {
    directives: [
      '.align', '.ascii', '.asciiz', '.byte', '.data', '.double', '.eqv', '.extern',
      '.float', '.globl', '.half', '.include', '.kdata', '.ktext', '.macro', '.set',
      '.space', '.text', '.word'
    ],
    pseudoInstructions: 'mars-compatible',
    macros: true,
    includes: true
  },
  syscalls: { modes: ['mars-services', 'course-exception'], deterministic: false },
  devices: ['cp0', 'timer', 'external-interrupt-generator'],
  console: { deterministicInput: true, deterministicOutput: true, interactive: true },
  executionFeatures: [
    'delayed-branching',
    'overflow-traps',
    'cp0-exceptions',
    'timer-devices',
    'external-interrupt',
    'deterministic-console',
    'undefined-domain-classification'
  ],
  catalogRevision: 1,
  normalizerRevision: 1,
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

/** Deterministic, engine-name-independent capability validation used by every resolver adapter. */
export function capabilityRequirementDiagnostics(
  descriptor: EngineDescriptor,
  capabilities: EngineCapabilities,
  requirements: ProviderCapabilityRequirements | undefined,
  resolvedProfile?: string
): CapabilityDiagnostic[] {
  if (!requirements) return [];
  const diagnostics: CapabilityDiagnostic[] = [];
  const prefix = `${descriptor.id}.capability`;
  const profile = requirements.profile ?? resolvedProfile;
  if (requirements.profile && resolvedProfile && requirements.profile !== resolvedProfile) {
    diagnostics.push({
      code: `${prefix}.profile-mismatch`, capability: 'profile',
      message: `请求 profile ${requirements.profile} 与解析得到的 ${resolvedProfile} 不一致`
    });
  } else if (profile && !capabilities.profiles.includes(profile)) {
    diagnostics.push({
      code: `${prefix}.profile-unsupported`, capability: 'profile',
      message: `provider 不支持 profile ${profile}`
    });
  }
  for (const layer of requirements.instructionLayers ?? []) {
    if (!(capabilities.instructionLayers[layer]?.length)) {
      diagnostics.push({
        code: `${prefix}.instruction-layer-unsupported`, capability: `instruction-layer:${layer}`,
        message: `provider 未声明指令层 ${layer}`
      });
    }
  }
  const directives = new Set(capabilities.assembly.directives.map((item) => item.toLowerCase()));
  for (const directive of requirements.directives ?? []) {
    if (!directives.has(directive.toLowerCase())) {
      diagnostics.push({
        code: `${prefix}.directive-unsupported`, capability: `directive:${directive.toLowerCase()}`,
        message: `provider 不支持 directive ${directive}`
      });
    }
  }
  if (requirements.pseudoInstructions && capabilities.assembly.pseudoInstructions === 'none') {
    diagnostics.push({
      code: `${prefix}.pseudo-unsupported`, capability: 'pseudo-instructions',
      message: 'provider 不支持 pseudo instructions'
    });
  }
  if (requirements.syscallMode && !capabilities.syscalls.modes.includes(requirements.syscallMode)) {
    diagnostics.push({
      code: `${prefix}.syscall-unsupported`, capability: `syscall:${requirements.syscallMode}`,
      message: `provider 不支持 syscall 模式 ${requirements.syscallMode}`
    });
  }
  for (const device of requirements.devices ?? []) {
    if (!capabilities.devices.includes(device)) {
      diagnostics.push({
        code: `${prefix}.device-unsupported`, capability: `device:${device}`,
        message: `provider 不支持设备 ${device}`
      });
    }
  }
  if (requirements.deterministicConsole
    && (!capabilities.console.deterministicInput || !capabilities.console.deterministicOutput)) {
    diagnostics.push({
      code: `${prefix}.deterministic-console-unsupported`, capability: 'deterministic-console',
      message: 'provider 未声明确定性输入/输出 console'
    });
  }
  if (requirements.interactiveConsole && !capabilities.console.interactive) {
    diagnostics.push({
      code: `${prefix}.interactive-console-unsupported`, capability: 'interactive-console',
      message: 'provider 不支持 interactive console'
    });
  }
  if (requirements.eventSchemaRevision !== undefined
    && requirements.eventSchemaRevision !== capabilities.eventSchemaRevision) {
    diagnostics.push({
      code: `${prefix}.event-schema-unsupported`, capability: 'event-schema',
      message: `请求 event schema revision ${requirements.eventSchemaRevision}，provider 仅声明 ${capabilities.eventSchemaRevision}`
    });
  }
  return diagnostics;
}
