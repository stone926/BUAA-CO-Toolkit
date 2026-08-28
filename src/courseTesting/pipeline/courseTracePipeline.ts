// @index course-testing-pipeline — 可注入的课程 Trace 流水线：image policy、oracle shadow 执行与差分比较

import type * as vscode from 'vscode';

import type { ProgramImage } from '../../mips/core/api';
import type { CourseProfile } from '../../mips/core/generated/isaCatalog';
import type { ExecuteResult, ProviderRunContext } from '../../mips/providers/contracts';
import type { compareTraceIterables } from '../../language/mips/traceCompare';
import type {
  LogisimCliTraceRun,
  P3LogisimTraceSetup
} from '../../courseTestLogisim';
import type { executeWithPreflight } from '../../mips/providers/providerResolver';
import type { runIsim } from '../../verilog';
import type { AppServices } from '../../types';
import type {
  AsmCase,
  copyAsmCaseArtifact,
  createAsmCaseFromAsm,
  prepareAsmCaseMachineCode,
  recordAsmCaseOracleResult,
  updateAsmCaseArtifacts
} from '../../asmCaseStore';
import {
  compareExecutorShadow,
  type ExecutorShadowDifferential
} from '../oracle/differentialRunner';
import {
  ExecutionAssertionObserver,
  type CourseAssertion,
  type CourseWatchpoint,
  type ExecutionObservation
} from '../oracle/executionAssertions';
import {
  courseProgramImagePolicyIssues,
  type CourseImagePolicyIssue
} from './courseImagePolicy';

/**
 * Phase-4 pipeline object. Assembler/DUT/case-store injection follows the same
 * shape as the already-provider-neutral traceRunner stages; the shadow lane is
 * the first orchestration to live behind this interface so callers can swap
 * engines without touching the comparison/policy logic.
 */
export interface BuiltinOracleExecution {
  readonly profile: string;
  readonly image: ProgramImage;
  readonly maxSteps: number;
  readonly haltPc: number;
  readonly interruptSchedule?: readonly number[];
  readonly trace?: { readonly kind: 'architectural-writes'; readonly courseCorrect: true };
  readonly watchpoints?: readonly CourseWatchpoint[];
  readonly assertions?: readonly CourseAssertion[];
}

export interface CourseTracePipelineDependencies {
  /** Resolve and execute the builtin oracle; the resolver stays host-side. */
  executeBuiltinOracle?: (
    request: BuiltinOracleExecution,
    context?: ProviderRunContext
  ) => Promise<ExecuteResult>;

  // ── Full course-trace stages (phase 4). traceRunner supplies defaults; tests
  //    can inject one stage without replacing unrelated orchestration. ──
  createCase?: typeof createAsmCaseFromAsm;
  prepareProgram?: typeof prepareAsmCaseMachineCode;
  runOracle?: typeof executeWithPreflight;
  runDut?: typeof runIsim;
  /** P3 Logisim-specific DUT runner; P4-P7 use `runDut` (ISim). */
  runLogisimDut?: (
    services: AppServices,
    setup: P3LogisimTraceSetup,
    circuit: vscode.Uri,
    haltPcHex: string,
    resource: vscode.Uri,
    streamOutput?: boolean,
    signal?: AbortSignal
  ) => Promise<LogisimCliTraceRun>;
  compareTraces?: typeof compareTraceIterables;
  recordOracle?: typeof recordAsmCaseOracleResult;
  updateArtifacts?: typeof updateAsmCaseArtifacts;
  copyArtifact?: typeof copyAsmCaseArtifact;

  /** Swap point for differential comparison (kept pure in oracle/differentialRunner). */
  compareShadow?: typeof compareExecutorShadow;
}

function missingStage(stage: string): Error {
  return new Error(`CourseTracePipeline stage is not injected: ${stage}`);
}

export interface ExecutorShadowPipelineResult {
  readonly builtin: ExecuteResult;
  readonly differential: ExecutorShadowDifferential;
  readonly observation: ExecutionObservation;
}

export class CourseTracePipeline {
  private readonly compareShadow: typeof compareExecutorShadow;

  constructor(private readonly dependencies: CourseTracePipelineDependencies) {
    this.compareShadow = dependencies.compareShadow ?? compareExecutorShadow;
  }

  createCase(...args: Parameters<typeof createAsmCaseFromAsm>): ReturnType<typeof createAsmCaseFromAsm> {
    const stage = this.dependencies.createCase;
    if (!stage) throw missingStage('createCase');
    return stage(...args);
  }

  prepareProgram(...args: Parameters<typeof prepareAsmCaseMachineCode>): ReturnType<typeof prepareAsmCaseMachineCode> {
    const stage = this.dependencies.prepareProgram;
    if (!stage) throw missingStage('prepareProgram');
    return stage(...args);
  }

  runOracle(...args: Parameters<typeof executeWithPreflight>): ReturnType<typeof executeWithPreflight> {
    const stage = this.dependencies.runOracle;
    if (!stage) throw missingStage('runOracle');
    return stage(...args);
  }

  runDut(...args: Parameters<typeof runIsim>): ReturnType<typeof runIsim> {
    const stage = this.dependencies.runDut;
    if (!stage) throw missingStage('runDut');
    return stage(...args);
  }

  runLogisimDut(
    services: AppServices,
    setup: P3LogisimTraceSetup,
    circuit: vscode.Uri,
    haltPcHex: string,
    resource: vscode.Uri,
    streamOutput = true,
    signal?: AbortSignal
  ): Promise<LogisimCliTraceRun> {
    const stage = this.dependencies.runLogisimDut;
    if (!stage) throw missingStage('runLogisimDut');
    return stage(services, setup, circuit, haltPcHex, resource, streamOutput, signal);
  }

  compareTraces(...args: Parameters<typeof compareTraceIterables>): ReturnType<typeof compareTraceIterables> {
    const stage = this.dependencies.compareTraces;
    if (!stage) throw missingStage('compareTraces');
    return stage(...args);
  }

  recordOracle(...args: Parameters<typeof recordAsmCaseOracleResult>): ReturnType<typeof recordAsmCaseOracleResult> {
    const stage = this.dependencies.recordOracle;
    if (!stage) throw missingStage('recordOracle');
    return stage(...args);
  }

  updateArtifacts(...args: Parameters<typeof updateAsmCaseArtifacts>): ReturnType<typeof updateAsmCaseArtifacts> {
    const stage = this.dependencies.updateArtifacts;
    if (!stage) throw missingStage('updateArtifacts');
    return stage(...args);
  }

  copyArtifact(...args: Parameters<typeof copyAsmCaseArtifact>): ReturnType<typeof copyAsmCaseArtifact> {
    const stage = this.dependencies.copyArtifact;
    if (!stage) throw missingStage('copyArtifact');
    return stage(...args);
  }

  validateProgram(
    profile: string,
    image: ProgramImage,
    haltPc: number
  ): readonly CourseImagePolicyIssue[] {
    return courseProgramImagePolicyIssues(profile as CourseProfile, image, haltPc);
  }

  /**
   * Execute the builtin lane and compare it with an already-captured legacy
   * `ExecuteResult`. The caller remains responsible for preflight messaging and
   * bundle persistence; this class only owns policy + engine-neutral comparison.
   */
  async runExecutorComparison(
    legacy: ExecuteResult,
    execution: BuiltinOracleExecution,
    signal?: AbortSignal
  ): Promise<ExecutorShadowPipelineResult> {
    const executeBuiltinOracle = this.dependencies.executeBuiltinOracle;
    if (!executeBuiltinOracle) throw missingStage('executeBuiltinOracle');
    const observer = new ExecutionAssertionObserver(
      execution.watchpoints ?? [],
      execution.assertions ?? []
    );
    const builtin = await executeBuiltinOracle(execution, {
      signal,
      onCommitEvent: (event) => observer.observe(event)
    });
    const observation = observer.finish();
    const differential = this.compareShadow(
      {
        engineId: legacy.descriptor.id,
        ok: legacy.ok,
        rawText: legacy.trace?.rawText ?? '',
        traceEvents: legacy.trace?.events,
        stopKind: legacy.stop?.kind
      },
      {
        engineId: builtin.descriptor.id,
        ok: builtin.ok,
        rawText: builtin.trace?.rawText ?? '',
        traceEvents: builtin.trace?.events,
        events: builtin.events,
        eventDigest: builtin.eventDigest,
        finalStateDigest: builtin.finalStateDigest,
        stopKind: builtin.stop?.kind,
        diagnosticCode: /\[([^\]]+)\]/.exec(builtin.status.stderr)?.[1],
        diagnosticMessage: builtin.status.stderr
      },
      { profile: execution.profile, retainedDiffEntries: 1 }
    );
    return { builtin, differential, observation };
  }
}
