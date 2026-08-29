// @index course-testing — phase-6 full-stack shadow：builtin assemble+execute 对固定 legacy full-stack

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import type { AsmCase } from '../asmCaseStore';
import type { AppServices } from '../types';
import { courseInstructionImageWords } from '../mips/core/assembler/artifacts';
import type { ProgramImage, SourceUnit, SourceUnitFingerprint } from '../mips/core/api';
import { canonicalJson, sha256Canonical, type CanonicalJson } from '../mips/replay/canonical';
import { writeFileAtomicReplace } from '../mips/replay/atomicFile';
import { materializeSourceGraph } from '../mips/replay/sourceBundle';
import { parseStrictHexTextWords, serializeProgramImage } from '../mips/replay/programImage';
import {
  maximumReplayMachineCodeBytes,
  readBoundedRegularFile
} from '../mips/replay/boundedFile';
import {
  preflightFailureMessage,
  resolveAssemblerProviderById,
  resolveExecutionProviderById
} from '../mips/providers/providerResolver';
import {
  fixedMarsCourseExecutorRole,
  verifyConfiguredFixedMarsReference
} from '../mips/providers/fixedMarsReference';
import {
  BUILTIN_TS_DESCRIPTOR,
  LEGACY_MARS_DESCRIPTOR,
  type AssembleResult,
  type EngineArtifactIdentity,
  type ExecuteRequest,
  type ExecuteResult
} from '../mips/providers/contracts';
import { engineRunWasCancelled } from '../courseTestMessages';
import {
  compareExecutorShadow,
  type ExecutorShadowDifferential
} from './oracle/differentialRunner';
import {
  registeredShadowDivergences,
  type ShadowDisposition
} from './oracle/shadowPolicy';
import { copyShadowCaseSourceClosure } from './shadowBundleArtifacts';
import { isManifestV2 } from './manifestCodec';

export interface FullStackAssemblyDifferential {
  readonly matched: boolean;
  readonly builtinWords: number;
  readonly legacyWords: number;
  readonly firstDiffIndex?: number;
  readonly builtinWord?: number;
  readonly legacyWord?: number;
  readonly disposition: ShadowDisposition;
  readonly contractId?: string;
  readonly message: string;
}

export interface FullStackShadowOutcome {
  readonly evidenceKind: 'full-stack';
  readonly status: ShadowDisposition;
  readonly message: string;
  readonly bundleDir: string;
  readonly resultFile: string;
  readonly assembly: FullStackAssemblyDifferential;
  readonly execution?: ExecutorShadowDifferential;
  readonly legacyAssembly?: AssembleResult;
  readonly legacyExecution?: ExecuteResult;
}

export interface RunFullStackShadowOptions {
  readonly profile: string;
  readonly builtinAssembly: AssembleResult;
  readonly builtinExecution: ExecuteResult;
  readonly maxSteps: number;
  readonly haltPc: number;
  readonly interruptSchedule?: readonly number[];
  readonly p7RiInstruction?: boolean;
  readonly outputRoot: string;
  /** SHA-256 verified against the application-owned legacy-course-executor role. */
  readonly expectedLegacySha256?: string;
  readonly signal?: AbortSignal;
  readonly now?: Date;
}

/**
 * Run a genuinely independent legacy full stack from the same immutable source
 * closure. The legacy assembler feeds the legacy executor; the builtin image is
 * never adapted into MARS, so assembler-only and executor-only evidence cannot
 * accidentally be reported as full-stack evidence.
 */
export async function runFullStackShadow(
  services: AppServices,
  asmCase: AsmCase,
  options: RunFullStackShadowOptions
): Promise<FullStackShadowOutcome> {
  if (options.builtinAssembly.descriptor.id !== BUILTIN_TS_DESCRIPTOR.id
    || options.builtinExecution.descriptor.id !== BUILTIN_TS_DESCRIPTOR.id
    || !options.builtinAssembly.ok
    || !options.builtinExecution.ok
    || !options.builtinAssembly.image) {
    throw new Error('full-stack shadow requires completed builtin assembler and executor results');
  }
  const expectedLegacySha256 = normalizeExpectedLegacySha256(options.expectedLegacySha256);

  if (!isManifestV2(asmCase.manifest)) {
    throw new Error('full-stack shadow requires a v2 case manifest');
  }
  const graphReference = asmCase.manifest.program.sourceGraph;
  if (!graphReference) {
    throw new Error('full-stack shadow requires a v2 case source graph');
  }
  const builtinWords = courseInstructionImageWords(options.builtinAssembly.image);
  const root = path.resolve(options.outputRoot);
  await fs.promises.mkdir(root, { recursive: true });
  const now = options.now ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const destination = path.join(root, `${asmCase.id}-full-stack-${stamp}-${crypto.randomUUID().slice(0, 8)}`);
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.promises.mkdir(temporary, { recursive: false });

  let legacyAssembly: AssembleResult | undefined;
  let legacyExecution: ExecuteResult | undefined;
  let execution: ExecutorShadowDifferential | undefined;
  let assembly: FullStackAssemblyDifferential;
  let status: ShadowDisposition;
  let message: string;

  try {
    const caseSourceDir = path.join(temporary, 'case-source');
    await copyShadowCaseSourceClosure(asmCase, caseSourceDir, { requireCompleteV2: true });
    // The legacy provider re-captures `sourceUri`, so point it at a fresh tree
    // derived from the copied immutable blobs.  Passing sourceGraphInput alone
    // is insufficient because a source-reassembling provider does not consume
    // it as its actual filesystem input.
    const materialized = await materializeSourceGraph(
      caseSourceDir,
      graphReference.path,
      path.join(temporary, 'legacy-source')
    );
    const expectedInputGraph = materialized.graph.units.map((unit) => ({
      id: unit.id,
      contentHash: unit.contentHash
    }));
    const builtinInputIssue = programImageInputGraphIssue(
      options.builtinAssembly.image,
      expectedInputGraph
    );
    if (builtinInputIssue) {
      throw new Error(`builtin ProgramImage 不属于已校验 source closure：${builtinInputIssue}`);
    }
    await writeAtomic(
      path.join(temporary, 'builtin-program-image.json'),
      serializeProgramImage(options.builtinAssembly.image)
    );
    await writeAtomic(
      path.join(temporary, 'builtin-trace.out'),
      Buffer.from(options.builtinExecution.trace?.rawText ?? '', 'utf8')
    );

    const legacyCodeUri = vscode.Uri.file(path.join(temporary, 'legacy-code.txt'));
    const assemblyRequest = {
      sourceUri: vscode.Uri.file(materialized.rootFile),
      inputGraph: materialized.graph.units.map((unit) => ({
        id: unit.id,
        contentHash: unit.contentHash
      })),
      sourceGraphInput: materialized.sourceGraphInput,
      target: { kind: 'userText' as const, outputFile: legacyCodeUri },
      courseTrace: true,
      p7RiInstruction: options.p7RiInstruction,
      requirements: {
        profile: options.profile,
        instructionLayers: ['required', 'commonExtensions', 'marsCompatibility'] as const,
        pseudoInstructions: true,
        eventSchemaRevision: 1
      }
    };
    const referenceBeforeAssembly = await verifyFixedReference(
      asmCase.asm,
      expectedLegacySha256,
      options.signal
    );
    if (!referenceBeforeAssembly.ok) {
      assembly = assemblyFailure(
        options.builtinAssembly.image,
        materialized.sourceGraphInput.sources,
        referenceBeforeAssembly.message,
        {
          allowRegisteredDifference: false,
          disposition: referenceBeforeAssembly.cancelled ? 'not-comparable' : 'inconclusive'
        }
      );
    } else {
      try {
        const resolvedAssembler = await resolveAssemblerProviderById(
          services,
          LEGACY_MARS_DESCRIPTOR.id,
          assemblyRequest
        );
        if (!resolvedAssembler.preflight.ok) {
          assembly = assemblyFailure(
            options.builtinAssembly.image,
            materialized.sourceGraphInput.sources,
            preflightFailureMessage(resolvedAssembler.preflight),
            { allowRegisteredDifference: false }
          );
        } else {
          legacyAssembly = await resolvedAssembler.provider.assemble(
            assemblyRequest,
            { signal: options.signal }
          );
          const cancelled = engineRunWasCancelled(legacyAssembly.status, options.signal);
          const referenceAfterAssembly = cancelled
            ? undefined
            : await verifyFixedReference(asmCase.asm, expectedLegacySha256, options.signal);
          const identityIssue = legacyEngineIdentityIssue(
            'assembler',
            legacyAssembly,
            expectedLegacySha256
          );
          if (cancelled) {
            assembly = assemblyFailure(
              options.builtinAssembly.image,
              materialized.sourceGraphInput.sources,
              legacyAssembly.status.stderr || '固定 legacy assembler 已取消',
              { allowRegisteredDifference: false, disposition: 'not-comparable' }
            );
          } else if (referenceAfterAssembly && !referenceAfterAssembly.ok) {
            assembly = assemblyFailure(
              options.builtinAssembly.image,
              materialized.sourceGraphInput.sources,
              referenceAfterAssembly.message,
              { allowRegisteredDifference: false }
            );
          } else if (identityIssue) {
            assembly = assemblyFailure(
              options.builtinAssembly.image,
              materialized.sourceGraphInput.sources,
              identityIssue,
              { allowRegisteredDifference: false }
            );
          } else if (!legacyAssembly.ok) {
            assembly = assemblyFailure(
              options.builtinAssembly.image,
              materialized.sourceGraphInput.sources,
              legacyAssembly.status.stderr || '固定 legacy assembler 汇编失败'
            );
          } else if (!legacyAssembly.outputFile || !legacyAssembly.image) {
            assembly = assemblyFailure(
              options.builtinAssembly.image,
              materialized.sourceGraphInput.sources,
              '固定 legacy assembler 未生成完整 ProgramImage',
              { allowRegisteredDifference: false }
            );
          } else {
            try {
              const legacyDump = await readBoundedRegularFile(legacyAssembly.outputFile.fsPath, {
                maximumBytes: maximumReplayMachineCodeBytes,
                label: 'full-stack legacy assembler HexText'
              });
              // Keep the bundle self-contained even if a test/provider returns
              // an output URI other than the requested in-bundle target.
              if (!sameLocalFile(legacyAssembly.outputFile.fsPath, legacyCodeUri.fsPath)) {
                await writeAtomic(legacyCodeUri.fsPath, Buffer.from(legacyDump));
              }
              const dumpWords = parseStrictHexTextWords(legacyDump.toString('utf8'));
              const legacyImageWords = courseInstructionImageWords(legacyAssembly.image);
              const legacyInputIssue = programImageInputGraphIssue(
                legacyAssembly.image,
                expectedInputGraph
              );
              if (legacyInputIssue) {
                throw new Error(`legacy ProgramImage 不属于已校验 source closure：${legacyInputIssue}`);
              }
              await writeAtomic(
                path.join(temporary, 'legacy-program-image.json'),
                serializeProgramImage(legacyAssembly.image)
              );
              const outputIssue = exactWordArrayIssue(dumpWords, legacyImageWords);
              assembly = outputIssue
                ? assemblyFailure(
                  options.builtinAssembly.image,
                  materialized.sourceGraphInput.sources,
                  `固定 legacy assembler 的 HexText 与其 ProgramImage 不一致：${outputIssue}`,
                  { allowRegisteredDifference: false }
                )
                : compareAssemblyWords(builtinWords, legacyImageWords);
            } catch (error) {
              assembly = assemblyFailure(
                options.builtinAssembly.image,
                materialized.sourceGraphInput.sources,
                `固定 legacy assembler 产物无效：${errorMessage(error)}`,
                { allowRegisteredDifference: false }
              );
            }
          }
        }
      } catch (error) {
        assembly = assemblyFailure(
          options.builtinAssembly.image,
          materialized.sourceGraphInput.sources,
          `固定 legacy assembler 调用失败：${errorMessage(error)}`,
          {
            allowRegisteredDifference: false,
            disposition: isCancellationError(error, options.signal)
              ? 'not-comparable'
              : 'inconclusive'
          }
        );
      }
    }

    if (assembly.matched && legacyAssembly?.image) {
      const bindingIssue = legacyExecutionBindingIssue(
        legacyAssembly,
        materialized.rootFile
      );
      if (bindingIssue) {
        status = 'inconclusive';
        message = `Full-stack shadow 无法执行独立 legacy image：${bindingIssue}`;
      } else {
      const legacyTraceUri = vscode.Uri.file(path.join(temporary, 'legacy-trace.out'));
      const executionRequest: ExecuteRequest = {
        image: legacyAssembly.image,
        executionBinding: legacyAssembly.executionBinding!,
        profile: options.profile,
        trace: { kind: 'architectural-writes', courseCorrect: true },
        maxSteps: options.maxSteps,
        haltPc: legacyAssembly.courseHaltPc ?? options.haltPc,
        interruptSchedule: options.interruptSchedule ? [...options.interruptSchedule] : undefined,
        p7RiInstruction: options.p7RiInstruction,
        runOutputFile: legacyTraceUri,
        courseTrace: true,
        requirements: {
          profile: options.profile,
          instructionLayers: ['required', 'commonExtensions', 'marsCompatibility'],
          syscallMode: options.profile === 'P7' ? 'course-exception' : undefined,
          devices: options.profile === 'P7' ? ['cp0', 'timer', 'external-interrupt-generator'] : [],
          eventSchemaRevision: 1
        }
      };
        const referenceBeforeExecution = await verifyFixedReference(
          asmCase.asm,
          expectedLegacySha256,
          options.signal
        );
        if (!referenceBeforeExecution.ok) {
          status = referenceBeforeExecution.cancelled ? 'not-comparable' : 'inconclusive';
          message = referenceBeforeExecution.message;
        } else {
          try {
            const resolvedExecutor = await resolveExecutionProviderById(
              services,
              LEGACY_MARS_DESCRIPTOR.id,
              executionRequest
            );
            if (!resolvedExecutor.preflight.ok) {
              message = `固定 legacy executor preflight 失败: ${preflightFailureMessage(resolvedExecutor.preflight)}`;
              status = 'inconclusive';
            } else {
              legacyExecution = await resolvedExecutor.provider.execute(
                executionRequest,
                { signal: options.signal }
              );
              await writeAtomic(
                legacyTraceUri.fsPath,
                Buffer.from(legacyExecution.trace?.rawText ?? '', 'utf8')
              );
              const cancelled = engineRunWasCancelled(legacyExecution.status, options.signal);
              const referenceAfterExecution = cancelled
                ? undefined
                : await verifyFixedReference(asmCase.asm, expectedLegacySha256, options.signal);
              const identityIssue = legacyEngineIdentityIssue(
                'executor',
                legacyExecution,
                expectedLegacySha256
              ) ?? legacyArtifactContinuityIssue(legacyAssembly, legacyExecution);
              if (cancelled) {
                status = 'not-comparable';
                message = legacyExecution.status.stderr || '固定 legacy executor 已取消';
              } else if (referenceAfterExecution && !referenceAfterExecution.ok) {
                status = 'inconclusive';
                message = referenceAfterExecution.message;
              } else if (identityIssue) {
                status = 'inconclusive';
                message = identityIssue;
              } else {
                execution = compareExecutorShadow(
                  {
                    engineId: legacyExecution.descriptor.id,
                    ok: legacyExecution.ok,
                    rawText: legacyExecution.trace?.rawText ?? '',
                    traceEvents: legacyExecution.trace?.events,
                    stopKind: legacyExecution.stop?.kind,
                    diagnosticCode: /\[([^\]]+)\]/.exec(legacyExecution.status.stderr)?.[1],
                    diagnosticMessage: legacyExecution.status.stderr
                  },
                  {
                    engineId: options.builtinExecution.descriptor.id,
                    ok: options.builtinExecution.ok,
                    rawText: options.builtinExecution.trace?.rawText ?? '',
                    traceEvents: options.builtinExecution.trace?.events,
                    events: options.builtinExecution.events,
                    eventDigest: options.builtinExecution.eventDigest,
                    finalStateDigest: options.builtinExecution.finalStateDigest,
                    stopKind: options.builtinExecution.stop?.kind,
                    diagnosticCode: /\[([^\]]+)\]/.exec(options.builtinExecution.status.stderr)?.[1],
                    diagnosticMessage: options.builtinExecution.status.stderr
                  },
                  { profile: options.profile, retainedDiffEntries: 1 }
                );
                status = execution.disposition;
                message = fullStackMessage(assembly, execution);
              }
            }
          } catch (error) {
            status = isCancellationError(error, options.signal) ? 'not-comparable' : 'inconclusive';
            message = `固定 legacy executor 调用失败：${errorMessage(error)}`;
          }
        }
      }
    } else {
      status = assembly.disposition;
      message = assembly.message;
    }

    const result = {
      schemaRevision: 1,
      kind: 'course-full-stack-shadow',
      evidenceKind: 'full-stack',
      createdAt: now.toISOString(),
      profile: options.profile,
      caseId: asmCase.id,
      input: {
        maxSteps: options.maxSteps,
        haltPc: options.haltPc >>> 0,
        interruptSchedule: (options.interruptSchedule ?? []).map((pc) => pc >>> 0),
        sourceGraph: {
          path: graphReference.path,
          sha256: graphReference.sha256,
          bytes: graphReference.bytes,
          fingerprint: materialized.graph.graphFingerprint
        },
        builtinImageFingerprint: options.builtinAssembly.image.fingerprint,
        legacyImageFingerprint: legacyAssembly?.image?.fingerprint ?? null,
        fixedReferenceSha256: expectedLegacySha256
      },
      engines: {
        builtinAssembler: engineEvidence(options.builtinAssembly),
        builtinExecutor: engineEvidence(options.builtinExecution),
        legacyAssembler: legacyAssembly ? engineEvidence(legacyAssembly) : null,
        legacyExecutor: legacyExecution ? engineEvidence(legacyExecution) : null
      },
      status,
      message,
      assembly,
      execution: execution ?? null,
      contracts: registeredShadowDivergences,
      contractsDigest: sha256Canonical(registeredShadowDivergences as unknown as CanonicalJson)
    };
    const resultFile = path.join(temporary, 'full-stack-result.json');
    await writeAtomic(
      resultFile,
      Buffer.from(`${canonicalJson(result as unknown as CanonicalJson)}\n`, 'utf8')
    );
    await fs.promises.rename(temporary, destination);
    const finalResult = path.join(destination, 'full-stack-result.json');
    services.output.appendLine(message);
    return {
      evidenceKind: 'full-stack',
      status,
      message,
      bundleDir: destination,
      resultFile: finalResult,
      assembly,
      ...(execution ? { execution } : {}),
      ...(legacyAssembly ? { legacyAssembly } : {}),
      ...(legacyExecution ? { legacyExecution } : {})
    };
  } catch (error) {
    await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function compareAssemblyWords(
  builtin: readonly number[],
  legacy: readonly number[]
): FullStackAssemblyDifferential {
  const count = Math.max(builtin.length, legacy.length);
  let firstDiffIndex = -1;
  for (let index = 0; index < count; index++) {
    // Do not coerce a missing entry with `>>> 0`: JavaScript would turn it
    // into zero and hide a missing trailing zero word.
    if (index >= builtin.length
      || index >= legacy.length
      || (builtin[index] >>> 0) !== (legacy[index] >>> 0)) {
      firstDiffIndex = index;
      break;
    }
  }
  if (firstDiffIndex < 0) {
    return {
      matched: true,
      builtinWords: builtin.length,
      legacyWords: legacy.length,
      disposition: 'matched',
      message: `Full-stack assembly image 一致（${builtin.length} words）`
    };
  }
  const compactBoundary = builtin.length === 4096
    && legacy.length === 4095
    && firstDiffIndex === 4095;
  return {
    matched: false,
    builtinWords: builtin.length,
    legacyWords: legacy.length,
    firstDiffIndex,
    ...(builtin[firstDiffIndex] === undefined ? {} : { builtinWord: builtin[firstDiffIndex] >>> 0 }),
    ...(legacy[firstDiffIndex] === undefined ? {} : { legacyWord: legacy[firstDiffIndex] >>> 0 }),
    disposition: compactBoundary ? 'course-correct' : 'inconclusive',
    ...(compactBoundary ? { contractId: 'MARS-DIV-COMPACT-001' } : {}),
    message: compactBoundary
      ? '固定 MARS 的 Compact 文本排他上界与课程 4096-word IM 契约不同 [MARS-DIV-COMPACT-001]'
      : `Full-stack assembly image 在 word ${firstDiffIndex} 出现未登记差异`
  };
}

interface AssemblyFailureOptions {
  readonly allowRegisteredDifference?: boolean;
  readonly disposition?: 'inconclusive' | 'not-comparable';
}

function assemblyFailure(
  builtinImage: ProgramImage,
  sources: readonly SourceUnit[],
  diagnostic: string,
  options: AssemblyFailureOptions = {}
): FullStackAssemblyDifferential {
  const builtinWords = courseInstructionImageWords(builtinImage).length;
  const allowRegisteredDifference = options.allowRegisteredDifference ?? true;
  const rawTextWord = allowRegisteredDifference
    && sourceUsesInstructionWordDirective(sources)
    && diagnosticIndicatesRawInstructionWordRejection(diagnostic);
  const compactBoundary = allowRegisteredDifference
    && builtinWords === 4096
    && diagnosticIndicatesCompactBoundaryRejection(diagnostic);
  const contractId: string | undefined = rawTextWord
    ? 'MARS-DIV-RAW-TEXT-WORD-001'
    : compactBoundary
      ? 'MARS-DIV-COMPACT-001'
      : undefined;
  const disposition = contractId ? 'course-correct' : options.disposition ?? 'inconclusive';
  return {
    matched: false,
    builtinWords,
    legacyWords: 0,
    disposition,
    ...(contractId ? { contractId } : {}),
    message: contractId
      ? `固定 MARS 汇编失败属于已登记课程差异 [${contractId}]：${diagnostic}`
      : disposition === 'not-comparable'
        ? `固定 MARS 汇编未完成比较：${diagnostic}`
        : `固定 MARS 汇编失败且无登记差异：${diagnostic}`
  };
}

function diagnosticIndicatesRawInstructionWordRejection(diagnostic: string): boolean {
  if (diagnostic.includes('MARS-DIV-RAW-TEXT-WORD-001')) return true;
  const compact = diagnostic.replace(/\s+/g, ' ');
  const rejection = String.raw`(?:cannot|can't|may not|not (?:be )?(?:allowed|permitted)|invalid|unsupported|illegal)`;
  return new RegExp(String.raw`\.word.{0,160}${rejection}.{0,160}\b(?:text|ktext)\b`, 'i').test(compact)
    || new RegExp(String.raw`\b(?:text|ktext)\b.{0,160}\.word.{0,160}${rejection}`, 'i').test(compact);
}

function diagnosticIndicatesCompactBoundaryRejection(diagnostic: string): boolean {
  if (diagnostic.includes('MARS-DIV-COMPACT-001')) return true;
  const compact = diagnostic.replace(/\s+/g, ' ');
  return /(?:compact|0x0*6ffc).{0,160}(?:exclusive|out of range|overflow|exceed|too large|limit|bound)/i.test(compact)
    || /(?:text|instruction).{0,160}(?:address|segment|program).{0,80}(?:out of range|overflow|exceed|too large)/i.test(compact);
}

type FixedReferenceCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly cancelled: boolean };

function normalizeExpectedLegacySha256(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error('full-stack shadow requires a previously verified fixed MARS SHA-256');
  }
  return value.toLowerCase();
}

async function verifyFixedReference(
  resource: vscode.Uri,
  expectedSha256: string,
  signal?: AbortSignal
): Promise<FixedReferenceCheck> {
  try {
    const verification = await verifyConfiguredFixedMarsReference(resource, { signal });
    if (!verification.ok) {
      return {
        ok: false,
        message: `[${verification.diagnostic.code}] ${verification.diagnostic.message}`,
        cancelled: verification.diagnostic.code === 'fixed-mars-reference.cancelled'
      };
    }
    if (verification.identity.role !== fixedMarsCourseExecutorRole) {
      return {
        ok: false,
        message: `固定 MARS reference role 不是 ${fixedMarsCourseExecutorRole}`,
        cancelled: false
      };
    }
    if (verification.identity.sha256.toLowerCase() !== expectedSha256) {
      return {
        ok: false,
        message: '固定 MARS reference 在上游校验后发生 SHA-256 身份变化',
        cancelled: false
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: `固定 MARS reference 二次校验失败：${errorMessage(error)}`,
      cancelled: isCancellationError(error, signal)
    };
  }
}

function legacyEngineIdentityIssue(
  stage: 'assembler' | 'executor',
  result: AssembleResult | ExecuteResult,
  expectedSha256: string
): string | undefined {
  if (result.descriptor.id !== LEGACY_MARS_DESCRIPTOR.id) {
    return `固定 legacy ${stage} 返回了错误 provider id：${result.descriptor.id}`;
  }
  if (!result.engineArtifact || !/^[0-9a-f]{64}$/i.test(result.engineArtifact.sha256)) {
    return `固定 legacy ${stage} 未提供有效 engineArtifact SHA-256`;
  }
  if (result.engineArtifact.sha256.toLowerCase() !== expectedSha256) {
    return `固定 legacy ${stage} engineArtifact 与已校验 fixed reference 不一致`;
  }
  if (result.ok !== result.status.ok) {
    return `固定 legacy ${stage} 的 result/status 成功状态不一致`;
  }
  return undefined;
}

function legacyArtifactContinuityIssue(
  assembly: AssembleResult,
  execution: ExecuteResult
): string | undefined {
  if (!assembly.engineArtifact || !execution.engineArtifact) return undefined;
  return engineArtifactKey(assembly.engineArtifact) === engineArtifactKey(execution.engineArtifact)
    ? undefined
    : '固定 MARS assembler/executor 使用了不同的 runtime artifact closure';
}

function engineArtifactKey(identity: EngineArtifactIdentity): string {
  return canonicalJson({
    sha256: identity.sha256.toLowerCase(),
    role: identity.role ?? null,
    fileName: identity.fileName ?? null,
    dependencies: (identity.dependencies ?? []).map((dependency) => ({
      sha256: dependency.sha256.toLowerCase(),
      role: dependency.role ?? null,
      fileName: dependency.fileName ?? null
    }))
  });
}

function legacyExecutionBindingIssue(
  assembly: AssembleResult,
  expectedSourceFile: string
): string | undefined {
  const binding = assembly.executionBinding;
  if (!binding) return 'assembler 未返回 source-reassembly executionBinding';
  if (binding.providerId !== LEGACY_MARS_DESCRIPTOR.id) {
    return `executionBinding providerId 错误：${binding.providerId}`;
  }
  if (!assembly.image || binding.imageFingerprint.toLowerCase() !== assembly.image.fingerprint.toLowerCase()) {
    return 'executionBinding imageFingerprint 与 legacy ProgramImage 不一致';
  }
  if (binding.sourceUri.scheme !== 'file'
    || !sameLocalFile(binding.sourceUri.fsPath, expectedSourceFile)) {
    return 'executionBinding sourceUri 不指向隔离后的已校验 source closure';
  }
  return undefined;
}

function exactWordArrayIssue(
  actual: readonly number[],
  expected: readonly number[]
): string | undefined {
  if (actual.length !== expected.length) {
    return `word count ${actual.length} != ${expected.length}`;
  }
  for (let index = 0; index < expected.length; index++) {
    if ((actual[index] >>> 0) !== (expected[index] >>> 0)) {
      return `word ${index} 0x${(actual[index] >>> 0).toString(16).padStart(8, '0')} != 0x${(expected[index] >>> 0).toString(16).padStart(8, '0')}`;
    }
  }
  return undefined;
}

function programImageInputGraphIssue(
  image: ProgramImage,
  expected: readonly SourceUnitFingerprint[]
): string | undefined {
  if (image.inputGraph.length !== expected.length) {
    return `unit count ${image.inputGraph.length} != ${expected.length}`;
  }
  for (let index = 0; index < expected.length; index++) {
    const actualUnit = image.inputGraph[index];
    const expectedUnit = expected[index];
    if (actualUnit.id !== expectedUnit.id
      || actualUnit.contentHash.toLowerCase() !== expectedUnit.contentHash.toLowerCase()) {
      return `unit ${index} identity mismatch`;
    }
  }
  return undefined;
}

function sameLocalFile(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceUsesInstructionWordDirective(sources: readonly SourceUnit[]): boolean {
  return sources.some((source) => {
    let instructionSegment = true;
    for (const rawLine of source.text.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (/^\.(?:text|ktext)\b/i.test(line)) instructionSegment = true;
      if (/^\.(?:data|kdata)\b/i.test(line)) instructionSegment = false;
      if (instructionSegment && /^\.word\b/i.test(line)) return true;
    }
    return false;
  });
}

function engineEvidence(result: AssembleResult | ExecuteResult): CanonicalJson {
  const imageFingerprint = 'image' in result ? result.image?.fingerprint : undefined;
  return {
    id: result.descriptor.id,
    build: result.descriptor.build,
    semanticsRevision: result.descriptor.semanticsRevision,
    capabilitiesRevision: result.descriptor.capabilitiesRevision,
    artifact: (result.engineArtifact ?? null) as unknown as CanonicalJson,
    resolvedRun: (result.resolvedRun ?? null) as unknown as CanonicalJson,
    ok: result.ok,
    imageFingerprint: imageFingerprint ?? null
  };
}

function fullStackMessage(
  assembly: FullStackAssemblyDifferential,
  execution: ExecutorShadowDifferential
): string {
  if (!assembly.matched) return assembly.message;
  switch (execution.disposition) {
    case 'matched':
      return 'Full-stack shadow 通过：两端独立汇编 image 与架构 trace 均一致';
    case 'course-correct':
      return `Full-stack shadow 出现已登记 course-correct 差异${execution.classification?.contractId
        ? ` [${execution.classification.contractId}]` : ''}`;
    case 'mars-compatible':
      return 'Full-stack shadow 出现已登记 mars-compatible 差异';
    case 'not-comparable':
      return `Full-stack shadow 不可比较：${execution.notComparableReason ?? 'unknown'}`;
    case 'inconclusive':
      return 'Full-stack shadow 出现未登记执行差异，已阻断默认切换证据';
  }
}

const writeAtomic = writeFileAtomicReplace;
