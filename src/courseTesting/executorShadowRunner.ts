// @index course-testing — phase-4 executor shadow：legacy + builtin 双跑、分类并保存完整复现 bundle

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import type { AsmCase } from '../asmCaseStore';
import { AppServices } from '../types';
import type { ProgramImage } from '../mips/core/api';
import { commitEventsCanonical } from '../mips/core/events/commitEvent';
import { serializeProgramImage } from '../mips/replay/programImage';
import { canonicalJson, sha256Canonical, type CanonicalJson } from '../mips/replay/canonical';
import { writeFileAtomicReplace } from '../mips/replay/atomicFile';
import {
  resolveBuiltinExecutionProvider,
  preflightFailureMessage
} from '../mips/providers/providerResolver';
import {
  BUILTIN_TS_DESCRIPTOR,
  type ExecuteResult,
  type ExecuteRequest,
  type MipsExecutionProvider
} from '../mips/providers/contracts';
import {
  compareExecutorShadow,
  ExecutorShadowDifferential
} from './oracle/differentialRunner';
import type {
  CourseAssertion,
  CourseWatchpoint,
  ExecutionObservation
} from './oracle/executionAssertions';
import { registeredShadowDivergences } from './oracle/shadowPolicy';
import { isManifestV2 } from './manifestCodec';
import { CourseTracePipeline } from './pipeline/courseTracePipeline';
import { engineRunWasCancelled } from '../courseTestMessages';
import { copyShadowCaseSourceClosure } from './shadowBundleArtifacts';

export type ExecutorShadowStatus =
  | 'matched'
  | 'not-comparable'
  | 'course-correct'
  | 'mars-compatible'
  | 'inconclusive';

export interface ExecutorShadowOutcome {
  readonly status: ExecutorShadowStatus;
  readonly differential: ExecutorShadowDifferential;
  readonly bundleDir?: string;
  readonly resultFile?: string;
  readonly message: string;
  readonly builtinResult?: ExecuteResult;
  readonly observation?: ExecutionObservation;
}

export interface RunExecutorShadowOptions {
  readonly profile: string;
  readonly image: ProgramImage;
  readonly maxSteps: number;
  readonly haltPc: number;
  readonly interruptSchedule?: readonly number[];
  readonly legacy: ExecuteResult;
  readonly outputRoot: string;
  readonly signal?: AbortSignal;
  readonly now?: Date;
  /** Write the builtin raw trace into the case/output tree before bundle capture. */
  readonly builtinTraceUri?: vscode.Uri;
  readonly watchpoints?: readonly CourseWatchpoint[];
  readonly assertions?: readonly CourseAssertion[];
}

export async function runExecutorShadow(
  services: AppServices,
  asmCase: AsmCase,
  options: RunExecutorShadowOptions
): Promise<ExecutorShadowOutcome> {
  let builtinExecution: { provider: MipsExecutionProvider; preflight: { ok: boolean } } | undefined;
  const pipeline = new CourseTracePipeline({
    executeBuiltinOracle: async (_request, context) => {
      if (!builtinExecution) throw new Error('builtin provider was not resolved before execution');
      return await builtinExecution.provider.execute(builtinRequest, context);
    }
  });
  const imagePolicyIssues = pipeline.validateProgram(
    options.profile as 'P3' | 'P4' | 'P5' | 'P6' | 'P7',
    options.image,
    options.haltPc
  );
  if (imagePolicyIssues.length) {
    const message = `shadow 输入未通过课程 image policy: ${imagePolicyIssues[0].message}`;
    const differential: ExecutorShadowDifferential = {
      matched: false,
      disposition: 'not-comparable',
      legacyTraceDigest: legacyTraceDigest(options.legacy),
      builtinTraceDigest: '',
      legacyEvents: options.legacy.trace?.events.length ?? 0,
      builtinEvents: 0,
      notComparableReason: message
    };
    const bundleDir = await writeExecutorShadowBundle(
      asmCase,
      options,
      undefined,
      differential,
      options.now ?? new Date(),
      undefined,
      'not-comparable'
    );
    const persistedMessage = `${message}，已保存 ${bundleDir}`;
    services.output.appendLine(persistedMessage);
    return {
      status: 'not-comparable',
      message: persistedMessage,
      differential,
      bundleDir,
      resultFile: path.join(bundleDir, 'shadow-result.json')
    };
  }
  const builtinTraceUri = options.builtinTraceUri
    ?? vscode.Uri.file(path.join(options.outputRoot, 'builtin', `${asmCase.id}.builtin.out`));
  const builtinRequest: ExecuteRequest = {
    image: options.image,
    profile: options.profile,
    trace: { kind: 'architectural-writes', courseCorrect: true },
    maxSteps: options.maxSteps,
    haltPc: options.haltPc,
    interruptSchedule: options.interruptSchedule ? [...options.interruptSchedule] : undefined,
    runOutputFile: builtinTraceUri,
    courseTrace: true,
    requirements: {
      profile: options.profile,
      instructionLayers: ['required', 'commonExtensions', 'marsCompatibility'],
      syscallMode: options.profile === 'P7' ? 'course-exception' : undefined,
      devices: options.profile === 'P7' ? ['cp0', 'timer', 'external-interrupt-generator'] : [],
      eventSchemaRevision: 1
    }
  };
  const invocation = await resolveBuiltinExecutionProvider(services, builtinRequest);
  if (!invocation.preflight.ok) {
    const message = `builtin oracle preflight 失败: ${preflightFailureMessage(invocation.preflight)}`;
    const differential: ExecutorShadowDifferential = {
      matched: false,
      disposition: 'not-comparable',
      legacyTraceDigest: legacyTraceDigest(options.legacy),
      builtinTraceDigest: '',
      legacyEvents: options.legacy.trace?.events.length ?? 0,
      builtinEvents: 0,
      notComparableReason: message
    };
    const bundleDir = await writeExecutorShadowBundle(
      asmCase,
      options,
      undefined,
      differential,
      options.now ?? new Date(),
      undefined,
      'not-comparable'
    );
    const persistedMessage = `${message}，已保存 ${bundleDir}`;
    services.output.appendLine(persistedMessage);
    return {
      status: 'not-comparable',
      message: persistedMessage,
      differential,
      bundleDir,
      resultFile: path.join(bundleDir, 'shadow-result.json')
    };
  }
  builtinExecution = { provider: invocation.provider, preflight: invocation.preflight };
  const { builtin, differential, observation } = await pipeline.runExecutorComparison(
    options.legacy,
    {
      profile: options.profile,
      image: options.image,
      maxSteps: options.maxSteps,
      haltPc: options.haltPc,
      ...(options.interruptSchedule ? { interruptSchedule: options.interruptSchedule } : {}),
      trace: { kind: 'architectural-writes', courseCorrect: true },
      watchpoints: options.watchpoints,
      assertions: [
        { id: 'executor-shadow.halt-pc', kind: 'halt-pc', haltPc: options.haltPc },
        ...(options.assertions ?? [])
      ]
    },
    options.signal
  );

  const now = options.now ?? new Date();
  const cancelled = builtin.stop?.kind === 'cancelled'
    || engineRunWasCancelled(builtin.status, options.signal);
  const assertionFailed = builtin.ok && observation.assertionFailures.length > 0;
  const status: ExecutorShadowStatus = assertionFailed ? 'inconclusive' : differential.disposition;
  const bundleDir = cancelled
    ? undefined
    : await writeExecutorShadowBundle(asmCase, options, builtin, differential, now, observation, status);
  const message = shadowMessage(differential, bundleDir, observation, assertionFailed, cancelled);
  services.output.appendLine(message);
  return {
    status,
    differential,
    ...(bundleDir ? { bundleDir } : {}),
    ...(bundleDir ? { resultFile: path.join(bundleDir, 'shadow-result.json') } : {}),
    message,
    builtinResult: builtin,
    observation
  };
}

export async function writeExecutorShadowBundle(
  asmCase: AsmCase,
  options: RunExecutorShadowOptions,
  builtin: ExecuteResult | undefined,
  differential: ExecutorShadowDifferential,
  now = new Date(),
  observation?: ExecutionObservation,
  status: ExecutorShadowStatus = differential.disposition
): Promise<string> {
  const root = path.resolve(options.outputRoot);
  await fs.promises.mkdir(root, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const destination = path.join(root, `${asmCase.id}-shadow-${stamp}-${crypto.randomUUID().slice(0, 8)}`);
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.promises.mkdir(temporary, { recursive: false });

    // Full reproduction closure: source blobs are copied from the immutable v2
    // case, so the bundle remains usable after the original workspace moves.
    await copyShadowCaseSourceClosure(asmCase, path.join(temporary, 'case-source'));
    const imageBytes = serializeProgramImage(options.image);
    await writeAtomic(path.join(temporary, 'program-image.json'), imageBytes);
    await writeAtomic(
      path.join(temporary, 'legacy-trace.out'),
      Buffer.from(options.legacy.trace?.rawText ?? '', 'utf8')
    );
    await writeAtomic(
      path.join(temporary, 'builtin-trace.out'),
      Buffer.from(builtin?.trace?.rawText ?? '', 'utf8')
    );
    if (builtin?.events) {
      await writeAtomic(
        path.join(temporary, 'builtin-events.json'),
        Buffer.from(`${canonicalJson({
          schemaRevision: 1,
          eventSchema: 'buaa-co-commit-event-v1',
          events: commitEventsCanonical(builtin.events) as CanonicalJson,
          eventCount: builtin.eventCount ?? builtin.events.length,
          eventDigest: builtin.eventDigest ?? null,
          finalStateDigest: builtin.finalStateDigest ?? null
        } as unknown as CanonicalJson)}\n`, 'utf8')
      );
    }
    const result = {
      schemaRevision: 1,
      kind: 'executor-shadow',
      evidenceKind: 'executor-only',
      createdAt: now.toISOString(),
      profile: options.profile,
      imageFingerprint: options.image.fingerprint,
      input: {
        maxSteps: options.maxSteps,
        haltPc: options.haltPc >>> 0,
        interruptSchedule: (options.interruptSchedule ?? []).map((pc) => pc >>> 0),
        stdinSha256: asmCase.manifest.stdin?.sha256 ?? null,
        sourceGraph: isManifestV2(asmCase.manifest) && asmCase.manifest.program
          ? {
            path: asmCase.manifest.program.sourceGraph?.path ?? null,
            sha256: asmCase.manifest.program.sourceGraph?.sha256 ?? null,
            bytes: asmCase.manifest.program.sourceGraph?.bytes ?? null
          }
          : null
      },
      engines: {
        legacy: {
          id: options.legacy.descriptor.id,
          build: options.legacy.descriptor.build,
          semanticsRevision: options.legacy.descriptor.semanticsRevision,
          capabilitiesRevision: options.legacy.descriptor.capabilitiesRevision,
          artifact: options.legacy.engineArtifact ?? null
        },
        builtin: {
          id: builtin?.descriptor.id ?? BUILTIN_TS_DESCRIPTOR.id,
          build: builtin?.descriptor.build ?? BUILTIN_TS_DESCRIPTOR.build,
          semanticsRevision: builtin?.descriptor.semanticsRevision
            ?? BUILTIN_TS_DESCRIPTOR.semanticsRevision,
          capabilitiesRevision: builtin?.descriptor.capabilitiesRevision
            ?? BUILTIN_TS_DESCRIPTOR.capabilitiesRevision,
          artifact: builtin?.engineArtifact ?? null,
          completed: builtin !== undefined
        }
      },
      status,
      observation: observation ?? null,
      differential,
      contracts: registeredShadowDivergences,
      contractsDigest: sha256Canonical(registeredShadowDivergences as unknown as CanonicalJson)
    };
    await writeAtomic(
      path.join(temporary, 'shadow-result.json'),
      Buffer.from(`${canonicalJson(result as unknown as CanonicalJson)}\n`, 'utf8')
    );
    await fs.promises.rename(temporary, destination);
    return destination;
  } catch (error) {
    await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function shadowMessage(
  differential: ExecutorShadowDifferential,
  bundleDir: string | undefined,
  observation?: ExecutionObservation,
  assertionFailed = false,
  cancelled = false
): string {
  if (cancelled) {
    return 'Executor shadow 已取消';
  }
  if (assertionFailed) {
    return `Executor shadow 断言失败，结果 inconclusive：${observation?.assertionFailures[0]?.message ?? 'unknown'}，已保存 ${bundleDir}`;
  }
  switch (differential.disposition) {
    case 'matched':
      return `Executor shadow 通过：legacy 与 builtin 的架构写 trace/最终摘要一致，已保存 ${bundleDir}`;
    case 'not-comparable':
      return `Executor shadow 不可比较：${differential.notComparableReason ?? 'unknown'}，已保存 ${bundleDir}`;
    case 'inconclusive':
      return `Executor shadow 发现未登记差异，已保存 ${bundleDir}`;
    case 'course-correct':
      return `Executor shadow 发现已登记 course-correct 差异${differential.classification?.contractId
        ? ` [${differential.classification.contractId}]` : ''}，已保存 ${bundleDir}`;
    case 'mars-compatible':
      return `Executor shadow 发现已登记 mars-compatible 差异，已保存 ${bundleDir}`;
  }
}

function legacyTraceDigest(result: ExecuteResult): string {
  const text = result.trace?.rawText ?? '';
  return crypto.createHash('sha256').update(text).digest('hex');
}

const writeAtomic = writeFileAtomicReplace;
