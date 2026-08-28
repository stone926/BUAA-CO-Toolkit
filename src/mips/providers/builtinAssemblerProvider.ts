// @index mips-providers — BuiltinTsAssemblerProvider：阶段 5 纯 TS 课程汇编器（显式/后续默认切换）

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getProfile } from '../../config';
import {
  AssembleRequest,
  AssembleResult,
  BUILTIN_TS_DESCRIPTOR,
  capabilityRequirementDiagnostics,
  CapabilityDiagnostic,
  failedPreflight,
  MipsAssemblerProvider,
  okPreflight,
  ProviderPreflight,
  ProviderRunContext,
  ResolvedEngineRun
} from './contracts';
import { EngineCapabilities, SourceUnit } from '../core/api';
import { CourseProfile, isaInstructions } from '../core/generated/isaCatalog';
import {
  AssemblerServiceInclude,
  AssemblerServiceSource,
  assembleProgramForService,
  AssemblerServiceResult,
  courseAssemblerSemanticsRevision
} from '../core/assembler/assemblyService';
import { findCourseHaltPc, imageSegmentWords, wordsToHexText } from '../core/assembler/artifacts';
import { sourceUnitFingerprint } from '../core/programImage';

import { builtinAssemblerEngineArtifact } from '../replay/builtinAssemblerEngineArtifact';
import { captureSourceGraph, defaultSourceCaptureLimits, SourceGraphBundle } from '../replay/sourceBundle';
import { writeFileAtomicReplace } from '../replay/atomicFile';
import { readBoundedRegularFile } from '../replay/boundedFile';
import type { WorkerJob, WorkerOutboundMessage } from '../host/workerProtocol';

/** Phase-5 assembler descriptor; same engine id as the executor, assembler role. */
export const BUILTIN_TS_ASSEMBLER_DESCRIPTOR = Object.freeze({
  ...BUILTIN_TS_DESCRIPTOR,
  kind: 'assembler' as const,
  build: 'in-extension pure TypeScript course assembler (phase 5)',
  semanticsRevision: courseAssemblerSemanticsRevision,
  capabilitiesRevision: 1
});

export const BUILTIN_TS_ASSEMBLER_CAPABILITIES: EngineCapabilities = {
  profiles: ['P3', 'P4', 'P5', 'P6', 'P7'],
  instructionLayers: Object.fromEntries(
    (['required', 'commonExtensions', 'marsCompatibility'] as const).map((layer) => [
      layer,
      [...new Set(isaInstructions
        .filter((instruction) => instruction.layer === layer)
        .map((instruction) => instruction.mnemonic))].sort()
    ])
  ),
  assembly: {
    directives: [
      '.align', '.ascii', '.asciiz', '.byte', '.data', '.double', '.eqv',
      '.extern', '.float', '.globl', '.half', '.include', '.ktext', '.macro',
      '.end_macro', '.set', '.space', '.text', '.word'
    ],
    pseudoInstructions: 'course',
    macros: true,
    includes: true
  },
  syscalls: { modes: ['course-exception'], deterministic: false },
  devices: ['cp0', 'timer', 'external-interrupt-generator'],
  console: { deterministicInput: false, deterministicOutput: false, interactive: false },
  executionFeatures: [],
  catalogRevision: 1,
  normalizerRevision: 1,
  eventSchemaRevision: 1,
  courseContractRevision: 1
};

export interface BuiltinAssemblerWorkerRuntime {
  runJob(
    job: WorkerJob,
    options?: { signal?: AbortSignal; onProgress?: (batch: unknown[]) => void | Promise<void> }
  ): Promise<WorkerOutboundMessage>;
}

interface BuiltinAssembleSnapshot {
  readonly requestFingerprint: string;
  readonly sourceUri: vscode.Uri;
  readonly targetKind: 'userText' | 'kernelText';
  readonly outputFile?: vscode.Uri;
  readonly courseTrace: boolean;
  readonly p7RiInstruction: boolean;
  readonly profile: CourseProfile;
  readonly signal?: AbortSignal;
  readonly layers: readonly string[];
  readonly sourceGraphInput?: NonNullable<AssembleRequest['sourceGraphInput']>;
}

export class BuiltinTsAssemblerProvider implements MipsAssemblerProvider {
  readonly descriptor = BUILTIN_TS_ASSEMBLER_DESCRIPTOR;
  readonly capabilities = BUILTIN_TS_ASSEMBLER_CAPABILITIES;

  private readonly preflightFingerprints = new WeakMap<AssembleRequest, string>();

  constructor(private readonly workerRuntime?: BuiltinAssemblerWorkerRuntime) {}

  async preflight(request: AssembleRequest): Promise<ProviderPreflight> {
    const requestFingerprint = builtinAssembleRequestFingerprint(request);
    const diagnostics: CapabilityDiagnostic[] = [];
    if (request.sourceUri.scheme !== 'file') {
      diagnostics.push({
        code: 'builtin-ts-assembler.source-uri-unsupported',
        capability: 'source-input',
        message: 'builtin assembler 只接受 file scheme 的 ASM 源文件'
      });
    }
    const resolvedProfile = getProfile(request.sourceUri);
    const profile = (request.requirements?.profile
      ?? (['P3', 'P4', 'P5', 'P6', 'P7'].includes(resolvedProfile) ? resolvedProfile : undefined)) as CourseProfile | undefined;
    if (!profile) {
      diagnostics.push({
        code: 'builtin-ts-assembler.profile-required',
        capability: 'profile',
        message: `builtin assembler 需要具体课程 profile，当前工作区解析为 ${resolvedProfile}`
      });
    }
    diagnostics.push(...capabilityRequirementDiagnostics(
      this.descriptor,
      this.capabilities,
      request.requirements,
      profile
    ));
    const sourceGraphIssue = assembleSourceGraphIssue(request);
    if (sourceGraphIssue) {
      diagnostics.push({
        code: 'builtin-ts-assembler.source-graph-invalid',
        capability: 'source-input',
        message: sourceGraphIssue
      });
    }
    if (!diagnostics.length && request.sourceUri.scheme === 'file') {
      try {
        const stat = await fs.promises.stat(request.sourceUri.fsPath);
        if (!stat.isFile()) {
          diagnostics.push({
            code: 'builtin-ts-assembler.source-unreadable',
            capability: 'source-input',
            message: `ASM 源文件不存在或不是普通文件：${request.sourceUri.fsPath}`
          });
        }
      } catch {
        diagnostics.push({
          code: 'builtin-ts-assembler.source-unreadable',
          capability: 'source-input',
          message: `无法读取 ASM 源文件：${request.sourceUri.fsPath}`
        });
      }
    }
    if (requestFingerprint !== builtinAssembleRequestFingerprint(request)) {
      diagnostics.push({
        code: 'builtin-ts-assembler.request-changed-during-preflight',
        capability: 'immutable-preflight',
        message: 'assemble request 在 preflight 期间发生变化；已拒绝绑定过期快照'
      });
    }
    if (diagnostics.length) {
      this.preflightFingerprints.delete(request);
      return failedPreflight(this.descriptor, diagnostics);
    }
    this.preflightFingerprints.set(request, requestFingerprint);
    return okPreflight(this.descriptor);
  }

  async assemble(request: AssembleRequest, context?: ProviderRunContext): Promise<AssembleResult> {
    const snapshot = snapshotAssembleRequest(request, context?.signal);
    const expectedFingerprint = this.preflightFingerprints.get(request);
    this.preflightFingerprints.delete(request);
    if (expectedFingerprint === undefined) {
      const preflight = await this.preflight(request);
      if (!preflight.ok) return this.preflightFailure(preflight.diagnostics);
      this.preflightFingerprints.delete(request);
    } else if (expectedFingerprint !== snapshot.requestFingerprint) {
      return this.preflightFailure([{
        code: 'builtin-ts-assembler.request-changed-after-preflight',
        capability: 'immutable-preflight',
        message: 'assemble request 在 preflight 后发生变化；已拒绝执行'
      }]);
    }
    const started = Date.now();
    let stageDir: string | undefined;
    try {
      let units: readonly SourceUnit[];
      let includes: readonly AssemblerServiceInclude[];
      if (snapshot.sourceGraphInput) {
        const graph = snapshot.sourceGraphInput;
        const rootIndex = graph.sources.findIndex((source) => source.id === graph.rootId);
        units = [
          graph.sources[rootIndex],
          ...graph.sources.slice(0, rootIndex),
          ...graph.sources.slice(rootIndex + 1)
        ];
        includes = graph.includes;
      } else {
        stageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-builtin-assemble-'));
        await fs.promises.chmod(stageDir, 0o700).catch(() => undefined);
        const allowedRoot = vscode.workspace?.getWorkspaceFolder?.(snapshot.sourceUri)?.uri.fsPath
          ?? path.dirname(snapshot.sourceUri.fsPath);
        const captured = await captureSourceGraph(
          snapshot.sourceUri.fsPath,
          stageDir,
          undefined,
          { ...defaultSourceCaptureLimits },
          { allowedRoot }
        );
        units = await loadCapturedSourceUnits(stageDir, captured.graph);
        includes = captured.graph.edges.map((edge): AssemblerServiceInclude => ({
          fromId: edge.from,
          specifier: edge.requestedPath,
          toId: edge.to
        }));
      }
      const result = await this.runAssembly(snapshot, units, includes);

      if (!result.ok || !result.image) {
        return this.failureResult(
          started,
          snapshot,
          result.diagnostics.map((diagnostic) => `[${diagnostic.code}] ${diagnostic.message}`).join('\n')
        );
      }

      const segmentName = snapshot.targetKind === 'kernelText' ? 'ktext' : 'text';
      const words = imageSegmentWords(result.image, segmentName);
      const haltPc = snapshot.courseTrace && snapshot.targetKind === 'userText'
        ? findCourseHaltPc(result.image, snapshot.profile)
        : undefined;
      if (snapshot.courseTrace && snapshot.targetKind === 'userText' && haltPc === undefined) {
        return this.failureResult(
          started,
          snapshot,
          '[builtin-ts-assembler.halt-loop-missing] 课程 user-text 汇编结果未包含标准停机自环'
        );
      }
      const outputFile = snapshot.outputFile
        ?? this.defaultOutputFile(snapshot.sourceUri, snapshot.targetKind);
      await writeFileAtomicReplace(outputFile.fsPath, Buffer.from(wordsToHexText(words), 'utf8'));

      const resolvedRun: ResolvedEngineRun = {
        profile: snapshot.profile,
        memoryConfiguration: 'course-contract-v1',
        runtime: { kind: 'builtin-ts' },
        wallClockMs: Math.max(1, Date.now() - started),
        p7RiInstruction: snapshot.p7RiInstruction
      };
      return {
        ok: true,
        outputFile,
        ...(haltPc === undefined ? {} : { courseHaltPc: haltPc }),
        status: {
          ok: true,
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          stopReason: 'completed'
        },
        descriptor: this.descriptor,
        engineArtifact: builtinAssemblerEngineArtifact().identity,
        resolvedRun,
        image: result.image
      };
    } catch (error) {
      return this.failureResult(
        started,
        snapshot,
        `builtin-ts-assembler.private-assembly-failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (stageDir) {
        await fs.promises.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async runAssembly(
    snapshot: BuiltinAssembleSnapshot,
    units: readonly SourceUnit[],
    includes: readonly AssemblerServiceInclude[]
  ): Promise<AssemblerServiceResult> {
    const payload = {
      profile: snapshot.profile,
      sources: units as readonly AssemblerServiceSource[],
      includes,
      layers: snapshot.layers,
      p7RiInstruction: snapshot.p7RiInstruction
    };
    if (!this.workerRuntime) {
      return assembleProgramForService({
        profile: snapshot.profile,
        sources: payload.sources,
        includes,
        layers: snapshot.layers as readonly ('required' | 'commonExtensions' | 'marsCompatibility')[],
        p7RiInstruction: snapshot.p7RiInstruction
      });
    }
    const message = await this.workerRuntime.runJob({
      kind: 'assembler-assemble',
      payload
    }, { signal: snapshot.signal });
    if (message.kind !== 'result') {
      throw new Error('builtin assembler worker returned progress as its terminal message');
    }
    if (!message.ok) {
      throw new Error(message.cancelled ? 'cancelled' : (message.error ?? 'worker assembly failed'));
    }
    return message.payload as AssemblerServiceResult;
  }

  private preflightFailure(diagnostics: readonly CapabilityDiagnostic[]): AssembleResult {
    return {
      ok: false,
      status: {
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: diagnostics.map((item) => `[${item.code}] ${item.message}`).join('\n'),
        timedOut: false,
        stopReason: 'engine-error'
      },
      descriptor: this.descriptor
    };
  }

  private failureResult(started: number, snapshot: BuiltinAssembleSnapshot, stderr: string): AssembleResult {
    return {
      ok: false,
      status: {
        ok: false,
        exitCode: null,
        stdout: '',
        stderr,
        timedOut: false,
        stopReason: 'engine-error'
      },
      descriptor: this.descriptor,
      resolvedRun: {
        profile: snapshot.profile,
        memoryConfiguration: 'course-contract-v1',
        runtime: { kind: 'builtin-ts' },
        wallClockMs: Math.max(1, Date.now() - started),
        p7RiInstruction: snapshot.p7RiInstruction
      }
    };
  }

  private defaultOutputFile(sourceUri: vscode.Uri, targetKind: 'userText' | 'kernelText'): vscode.Uri {
    if (targetKind === 'kernelText') {
      return vscode.Uri.file(path.join(
        path.dirname(sourceUri.fsPath),
        `${path.basename(sourceUri.fsPath, path.extname(sourceUri.fsPath))}.kernel.txt`
      ));
    }
    return vscode.Uri.file(path.join(path.dirname(sourceUri.fsPath), 'code.txt'));
  }
}

function snapshotAssembleRequest(request: AssembleRequest, signal: AbortSignal | undefined): BuiltinAssembleSnapshot {
  const resolvedProfile = getProfile(request.sourceUri) as CourseProfile;
  const profile = (request.requirements?.profile as CourseProfile | undefined)
    ?? (['P3', 'P4', 'P5', 'P6', 'P7'].includes(resolvedProfile) ? resolvedProfile : 'P5');
  return {
    requestFingerprint: builtinAssembleRequestFingerprint(request),
    sourceUri: request.sourceUri,
    targetKind: request.target.kind,
    ...(request.target.outputFile ? { outputFile: request.target.outputFile } : {}),
    courseTrace: request.courseTrace ?? false,
    p7RiInstruction: request.p7RiInstruction ?? false,
    profile,
    ...(signal ? { signal } : {}),
    layers: request.requirements?.instructionLayers ?? ['required', 'commonExtensions', 'marsCompatibility'],
    ...(request.sourceGraphInput ? {
      sourceGraphInput: {
        rootId: request.sourceGraphInput.rootId,
        sources: request.sourceGraphInput.sources.map((source) => ({ ...source })),
        includes: request.sourceGraphInput.includes.map((edge) => ({ ...edge }))
      }
    } : {})
  };
}

async function loadCapturedSourceUnits(stageDir: string, graph: SourceGraphBundle): Promise<SourceUnit[]> {
  return await Promise.all(graph.units.map(async (unit) => {
    const blob = path.join(stageDir, ...unit.blobPath.split('/'));
    const bytes = await readBoundedRegularFile(blob, {
      maximumBytes: graph.limits.maxBytes,
      expectedBytes: unit.bytes,
      label: `captured source unit ${unit.id}`
    });
    return {
      id: unit.id,
      uri: unit.provenanceUri,
      text: bytes.toString('utf8')
    };
  }));
}

function builtinAssembleRequestFingerprint(request: AssembleRequest): string {
  return JSON.stringify({
    sourceUri: request.sourceUri.toString(),
    target: {
      kind: request.target.kind,
      ...(request.target.outputFile ? { outputFile: request.target.outputFile.toString() } : {})
    },
    courseTrace: request.courseTrace ?? false,
    p7RiInstruction: request.p7RiInstruction ?? false,
    requirements: request.requirements ?? null,
    inputGraph: request.inputGraph ?? null,
    sourceGraphInput: request.sourceGraphInput ?? null
  });
}

function assembleSourceGraphIssue(request: AssembleRequest): string | undefined {
  const graph = request.sourceGraphInput;
  if (!graph) return undefined;
  const ids = graph.sources.map((source) => source.id);
  const idSet = new Set(ids);
  if (!graph.rootId || !idSet.has(graph.rootId) || idSet.size !== ids.length) {
    return 'verified source graph has an invalid root or duplicate source id';
  }
  if (graph.includes.some((edge) => !idSet.has(edge.fromId) || !idSet.has(edge.toId) || !edge.specifier)) {
    return 'verified source graph contains an invalid include edge';
  }
  if (request.inputGraph) {
    const expected = request.inputGraph.map((unit) => ({
      id: unit.id,
      contentHash: unit.contentHash.toLowerCase()
    }));
    const actual = graph.sources.map((source) => {
      const fingerprint = sourceUnitFingerprint(source);
      return { id: fingerprint.id, contentHash: fingerprint.contentHash };
    });
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return 'verified source graph does not match the request inputGraph';
    }
  }
  return undefined;
}
