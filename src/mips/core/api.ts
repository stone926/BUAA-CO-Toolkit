// @index mips-core — 核心数据契约（SourceUnit/ProgramImage 等，纯 TS，无 vscode/fs 依赖）

/**
 * 汇编器与执行器之间的不可变核心契约（计划第 5.3 节）。
 *
 * 阶段 1 只冻结类型骨架与 `ProgramImage` 的 fingerprint 规则；builtin
 * assembler 在阶段 5 才产生真实 image。HexText、MIF 与 Verilog memory image
 * 是 artifact adapter 的输出格式，不进入领域模型。
 */

/** A source file participating in assembly (root or include). */
export interface SourceUnit {
  id: string;
  /** Canonical URI when available; core code must never interpret it as a path. */
  uri?: string;
  text: string;
}

/** Fingerprint of one input source unit, in discovery order. */
export interface SourceUnitFingerprint {
  id: string;
  uri?: string;
  /** Lowercase hex SHA-256 of the UTF-8 text. */
  contentHash: string;
}

/** A contiguous program segment with word-aligned addresses. */
export interface ProgramSegment {
  name: string;
  baseAddress: number;
  /** One entry per word, `baseAddress + 4*i` aligned. */
  words: readonly number[];
}

/** Assembler symbol (label or .eqv) with its resolved value. */
export interface SymbolEntry {
  name: string;
  /** Absolute address for labels, constant value for .eqv; undefined when unresolved (diagnostic-only). */
  value?: number;
  kind: 'label' | 'eqv';
  segment?: string;
}

/** One source-origin frame (leaf or macro/include expansion frame). */
export interface SourceOrigin {
  sourceId: string;
  startOffset?: number;
  endOffset?: number;
}

/** Maps a program word back to its source origin. */
export interface SourceMapEntry {
  /** Index into ProgramImage.segments (segment index) and the word index inside it. */
  segmentIndex: number;
  wordIndex: number;
  /** SourceUnit id of the origin (macro-expansion stack in later phases). */
  sourceId: string;
  /** Offset/line ranges are added with the strict assembler (phase 5). */
  startOffset?: number;
  endOffset?: number;
  /** Innermost-first include/macro expansion frames; the entry fields are the leaf. */
  expansionStack?: readonly SourceOrigin[];
}

/** Immutable machine image produced by an assembler and consumed by an executor. */
export interface ProgramImage {
  formatVersion: 1;
  /** Content fingerprint of the whole image; computed from a stable serialization of the fields below. */
  fingerprint: string;
  entryPc: number;
  segments: readonly ProgramSegment[];
  symbols: readonly SymbolEntry[];
  sourceMap: readonly SourceMapEntry[];
  inputGraph: readonly SourceUnitFingerprint[];
}

/** Descriptor identifying an engine build; part of every evidence fingerprint. */
export interface EngineDescriptor {
  /** Stable engine id, e.g. `legacy-mars-v0.6.3` or `builtin-ts`. */
  id: string;
  kind: 'assembler' | 'executor' | 'full-stack';
  /** Human-readable build identifier (release tag / commit prefix). */
  build: string;
  /** Semantics revision; bumps when behavior of the engine changes. */
  semanticsRevision: number;
  /** Revision of the capabilities data this build declares. */
  capabilitiesRevision: number;
}

/** Instruction availability layers (COURSE-P7-ISA-EXT-001). */
export type InstructionLayer = 'required' | 'commonExtensions' | 'marsCompatibility';

/** Stable capability ids for devices / execution features. */
export type ExecutionFeatureId =
  | 'delayed-branching'
  | 'overflow-traps'
  | 'cp0-exceptions'
  | 'timer-devices'
  | 'external-interrupt'
  | 'deterministic-console'
  | 'undefined-domain-classification';

/** Stable device capabilities used during provider preflight. */
export type DeviceCapabilityId = 'cp0' | 'timer' | 'external-interrupt-generator';

export interface AssemblyLanguageCapabilities {
  /** Directives accepted by the strict/source front-end (lowercase, including the leading dot). */
  directives: readonly string[];
  /** Whether source-level pseudo instructions are accepted and, if so, under which compatibility model. */
  pseudoInstructions: 'none' | 'course' | 'mars-compatible';
  macros: boolean;
  includes: boolean;
}

export interface SyscallCapabilities {
  /** MARS service calls and the P7 architectural Syscall exception are deliberately distinct. */
  modes: readonly ('mars-services' | 'course-exception')[];
  deterministic: boolean;
}

export interface ConsoleCapabilities {
  deterministicInput: boolean;
  deterministicOutput: boolean;
  interactive: boolean;
}

/** Versioned capability data shared by assembler and executor descriptors. */
export interface EngineCapabilities {
  /** Profiles the engine claims to support. */
  profiles: string[];
  /** Real instructions by availability layer. */
  instructionLayers: Partial<Record<InstructionLayer, string[]>>;
  /** Source-language surface; explicit so preflight need not infer it from an engine name. */
  assembly: AssemblyLanguageCapabilities;
  syscalls: SyscallCapabilities;
  devices: readonly DeviceCapabilityId[];
  console: ConsoleCapabilities;
  /** Execution features the engine implements. */
  executionFeatures: ExecutionFeatureId[];
  /** ISA catalog and normalizer revisions participating in evidence identity. */
  catalogRevision: number;
  normalizerRevision: number;
  /** Revision of the event schema produced by the engine. */
  eventSchemaRevision: number;
  /** Revision of the course contract this engine claims to implement. */
  courseContractRevision: number;
}
