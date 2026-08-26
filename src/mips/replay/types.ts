// @index mips-replay — exact replay/re-evaluate adapter contracts
import type { ProgramImage, SourceUnitFingerprint } from '../core/api';
import type { EngineArtifactIdentity } from '../providers/contracts';
import type { ManifestEngineInfo, ManifestRunConfiguration } from '../../courseTesting/manifestCodec';
import type { AsmCaseSourceKind } from '../../asmCaseStoreCore';

export interface ReplayEngineSelection {
  engine: ManifestEngineInfo;
  artifact: EngineArtifactIdentity;
}

export interface ReplayAdapterContext {
  artifactPath: string;
  dependencies: ReadonlyMap<string, string>;
  sourceRoot: string;
  sourceKind: AsmCaseSourceKind;
  inputGraph: readonly SourceUnitFingerprint[];
  configuration: ManifestRunConfiguration;
  stdinBytes?: Uint8Array;
  workingDirectory: string;
  signal?: AbortSignal;
}

export interface ReplayAssemblyOutput {
  ok: boolean;
  image?: ProgramImage;
  dutBytes?: Uint8Array;
  stdout: string;
  stderr: string;
}

export interface ReplayExecutionOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
  stopReason: 'halt-loop' | 'step-limit' | 'error';
}

/** Immutable assembler output consumed by an execution adapter. */
export interface ReplayExecutableProgram {
  image: ProgramImage;
  dutBytes: Uint8Array;
}

export interface ReplayEngineAdapter {
  readonly engineId: string;
  /** Fail closed unless this adapter glue implements the complete recorded revision tuple. */
  supportsEngine(engine: ManifestEngineInfo): boolean;
  assemble(context: ReplayAdapterContext): Promise<ReplayAssemblyOutput>;
  execute(context: ReplayAdapterContext, program: ReplayExecutableProgram): Promise<ReplayExecutionOutput>;
  /** Adapter-owned semantic checks; orchestration must not assume MARS formats for future engines. */
  validateAssembly?(context: ReplayAdapterContext, output: ReplayAssemblyOutput): Promise<string | undefined>;
  validateExecution?(
    context: ReplayAdapterContext,
    assembly: ReplayAssemblyOutput,
    output: ReplayExecutionOutput
  ): Promise<string | undefined> | string | undefined;
}

export class ReplayAdapterRegistry {
  private readonly adapters = new Map<string, ReplayEngineAdapter>();

  register(adapter: ReplayEngineAdapter): void {
    if (this.adapters.has(adapter.engineId)) throw new Error(`replay adapter already registered: ${adapter.engineId}`);
    this.adapters.set(adapter.engineId, adapter);
  }

  resolve(engine: ManifestEngineInfo): ReplayEngineAdapter {
    const adapter = this.adapters.get(engine.id);
    if (!adapter) throw new Error(`no replay adapter is registered for engine ${engine.id}`);
    if (!adapter.supportsEngine(engine)) {
      throw new Error(`replay adapter ${engine.id} does not support the recorded engine revision tuple`);
    }
    return adapter;
  }
}
