// @index course-trace-runner — 单个课程 Trace case 的 provider-neutral oracle/DUT 执行与比较
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getMemoryConfiguration,
  getProfile,
  type MipsEngineMode
} from '../config';
import { P7ProbeMetadata } from './builtinAsmGenerator';
import { findCourseHaltPc } from '../mips/core/assembler/artifacts';
import { checkP7Probe } from './p7ProbeCheck';
import { concludeP7Probe, isP7ObservationLimit, observedP7Halt } from './p7ProbeCompletion';
import { firstDmStoreDifference } from './dmStoreCheck';
import {
  compareTraceIterables,
  firstTraceDiffSnapshot
} from '../language/mips/traceCompare';
import {
  iterCpuTraceEvents
} from '../language/mips/traceParser';
import { parseSimOutput } from '../language/verilog/traceParser';
import { executeWithPreflight, preflightFailureMessage } from '../mips/providers/providerResolver';
import { resolveCourseEnginePlan } from '../mips/providers/courseEnginePolicy';
import { verifyConfiguredFixedMarsReference } from '../mips/providers/fixedMarsReference';
import {
  runVerilogSimulation,
  verilogSimulationFailure,
  verilogSimulationTerminalResult
} from '../verilog/simulationRunner';
import type { VerilogSimulationRunOutput } from '../verilog/simulationRunner';
import { verilogSimulationFailureMessage } from '../verilog/simulationDiagnostic';
import { privateDmStoreContractFailure } from '../verilog/dmStoreContractDiagnostic';
import { AppServices } from '../types';
import { readTextFile, workspaceFolderFor } from '../fsUtil';
import { normalizePathKey } from '../pathUtils';
import {
  courseExecutionInstructionBudget,
  courseExecutionInstructionBudgetFromCount,
  courseTraceSimulationTime,
  p7ProbeExecutionInstructionBudget,
  userAsmSimulationTiming
} from './pipeline/executionBudget';
import { CourseTracePipeline, type CourseTracePipelineDependencies } from './pipeline/courseTracePipeline';
import {
  AsmCase,
  asmCaseArtifactUri,
  asmCaseSourceSnapshotIssue,
  copyAsmCaseArtifact,
  createAsmCaseFromAsm,
  prepareAsmCaseMachineCode,
  readAsmCaseStdinSnapshot,
  readAsmCaseManifestForAsm,
  recordAsmCaseOracleResult,
  updateAsmCaseArtifacts
} from '../asmCaseStore';
import {
  manifestMachineCodeOf,
  manifestP7Of,
  manifestSourceOf
} from './manifestCodec';
import {
  asmCaseSourceFromBatchSource,
  caseResultFields,
  failedAssemblyCase,
  failedCase
} from '../courseTestCases';
import type { CourseTraceCaseInput } from '../courseTestCases';
import type {
  CourseTraceBatchSource,
  CourseTraceShadowSummary,
  NeutralCourseTraceCaseResult
} from '../courseTestReport';
import {
  courseTraceOutputDirectory,
  oracleOutputFileNameForCase,
  simOutputFileNameForCase
} from '../courseTestTraceFiles';
import { diffMessage, engineRunWasCancelled, engineStageFailureMessage, p7ProbeKindLabel } from '../courseTestMessages';
import { runExecutorShadow, type ExecutorShadowOutcome } from './executorShadowRunner';
import { runFullStackShadow, type FullStackShadowOutcome } from './fullStackShadowRunner';
import { runP3LogisimTraceCase } from '../courseTestLogisim';
import type { P3LogisimTraceSetup } from '../courseTestLogisim';
import { automaticTestEngineMode } from './automaticTestPolicy';
import type { EngineArtifactIdentity } from '../mips/providers/contracts';

const batchTraceCompareRetainedEntries = 1;

export type CourseTracePhase = 'prepare' | 'assemble' | 'oracle' | 'compile' | 'simulate' | 'compare';

export interface CourseTraceRunOptions {
  cpuResource?: vscode.Uri;
  sourceRoot?: vscode.Uri;
  engineResource?: vscode.Uri;
  expectedEngineArtifact?: EngineArtifactIdentity;
  revealOutput?: boolean;
  source?: CourseTraceBatchSource;
  logisim?: P3LogisimTraceSetup;
  artifactOutputMode?: 'workspace' | 'case';
  /** Fixed isolated simulator slot owned by the continuous scheduler. */
  automaticRunSlot?: number;
  /** Internal engine policy. Auto resolves the workspace instruction source before assembly. */
  engineMode?: MipsEngineMode;
  /** Phase-4 executor shadow: run legacy + builtin and adjudicate the difference. */
  oracleMode?: 'verify-both';
  /** Trusted root for shadow bundles; defaults to the immutable ASM case directory. */
  shadowOutputRoot?: vscode.Uri;
  /** Phase-4 full-trace stage injection; tests and future lanes can replace one stage. */
  pipeline?: CourseTracePipeline;
  /** Cancels the oracle and DUT processes as one logical course-test job. */
  signal?: AbortSignal;
  onPhase?: (phase: CourseTracePhase) => void | Promise<void>;
}

export async function runCourseTraceCase(
  services: AppServices,
  item: CourseTraceCaseInput,
  options: CourseTraceRunOptions = {}
): Promise<NeutralCourseTraceCaseResult> {
  const asm = item.asm;
  const resource = options.cpuResource ?? asm;
  const engineResource = options.engineResource ?? asm;
  const profile = getProfile(resource);
  if (profile === 'P3') {
    return await runP3LogisimTraceCase(services, item, options);
  }
  const automatic = options.source?.kind === 'generator';
  let enginePlan = resolveCourseEnginePlan(
    // Every generated case shares the private automatic stack. Besides keeping rollback modes
    // out of the public workflow, this is required for raw `.word` RI cases that course MARS
    // intentionally rejects in text/ktext. Manual and replay cases still honor their engine plan.
    automatic ? automaticTestEngineMode : options.engineMode ?? 'auto',
    profile,
    { deterministicConsole: item.stdin !== undefined }
  );
  if (enginePlan.mode === 'verify-both' && item.stdin) {
    return failedCase(
      item,
      'oracle',
      '固定版本 MARS 的完整流程验证尚不支持带标准输入的用例'
    );
  }
  const fixedMars = enginePlan.mode === 'verify-both'
    ? await verifyConfiguredFixedMarsReference(asm, { signal: options.signal })
    : undefined;
  if (fixedMars && !fixedMars.ok) {
    return failedCase(
      item,
      'oracle',
      `[${fixedMars.diagnostic.code}] ${fixedMars.diagnostic.message}`
    );
  }
  const pipeline = options.pipeline ?? defaultCourseTracePipeline();

  services.output.appendLine(automatic ? '正在运行自动测试点' : '完整课程写回记录测试');
  if (!automatic) {
    services.output.appendLine(`汇编文件：${asm.fsPath}`);
  }
  if (item.stdin && !automatic) {
    services.output.appendLine(`标准输入: ${item.stdin.fsPath}`);
  }

  await options.onPhase?.('prepare');
  let asmCase: AsmCase;
  try {
    asmCase = item.asmCase ?? await pipeline.createCase(asm, {
      source: asmCaseSourceFromBatchSource(options.source ?? { kind: 'selected', asmFiles: [asm.fsPath] }),
      stdin: item.stdin,
      resource,
      engineResource,
      sourceRoot: options.sourceRoot,
      metadata: { 'test.cpuResource': resource.fsPath, 'test.engineResource': engineResource.fsPath },
      enginePlan,
      p7: await p7MetadataFromManifest(asm)
    });
  } catch (error) {
    return failedCase(item, 'assemble',
      `测试点准备失败：${error instanceof Error ? error.message : String(error)}`,
      undefined, undefined, undefined, options.signal?.aborted);
  }
  const caseOutputMode = options.artifactOutputMode === 'case';
  if (!automatic) {
    services.output.appendLine(`汇编用例：${asmCase.manifestUri.fsPath}`);
  }

  if (item.asmCase && item.stdin
    && normalizePathKey(item.stdin.fsPath) !== normalizePathKey(asmCase.manifest.stdin?.originalPath ?? '')) {
    return failedCase(
      item,
      'oracle',
      '测试中止：已有汇编用例不能改用另一个标准输入；请创建新用例',
      undefined,
      undefined,
      asmCase
    );
  }

  await options.onPhase?.('assemble');
  let dump: Awaited<ReturnType<CourseTracePipeline['prepareProgram']>>;
  try {
    dump = await pipeline.prepareProgram(services, asmCase, {
      showMessages: false,
      revealOutput: options.revealOutput,
      nonInteractive: automatic ? true : undefined,
      courseTrace: true,
      resource,
      engineResource,
      expectedEngineArtifact: options.expectedEngineArtifact,
      enginePlan,
      signal: options.signal
    });
  } catch (error) {
    return failedCase(
      item,
      'assemble',
      `测试中止：测试点准备异常：${error instanceof Error ? error.message : String(error)}`,
      undefined,
      undefined,
      asmCase
    );
  }
  if (!dump?.ok || !dump.outputFile) {
    return failedAssemblyCase(item, asmCase, dump, options.signal);
  }
  enginePlan = dump.enginePlan ?? enginePlan;
  if (!automatic) {
    services.output.appendLine(`机器码: ${asmCase.machineCode.fsPath}`);
  }

  const interruptSchedule = resolveCaseInterruptScheduleFromCase(asmCase);
  if (interruptSchedule && !automatic) {
    services.output.appendLine(`外部中断目标 PC: ${interruptSchedule.map((pc) => `0x${(pc >>> 0).toString(16)}`).join(', ')}`);
  }
  const probe = resolveCaseProbeMetadataFromCase(asmCase);
  const haltPc = manifestMachineCodeOf(asmCase.manifest)?.haltPc
    ?? (probe && asmCase.manifest.version === 1 && dump.image ? findCourseHaltPc(dump.image, 'P7') : undefined);
  if (haltPc === undefined || !Number.isSafeInteger(haltPc)) {
    return failedCase(item, 'assemble', '测试中止：最终导出的用户 .text 段未记录已验证的标准停机 PC', asmCase.machineCode, undefined, asmCase);
  }
  if (!dump.image) {
    return failedCase(item, 'assemble', '测试中止：汇编器未返回权威程序映像（ProgramImage）', asmCase.machineCode, undefined, asmCase);
  }
  const imagePolicyIssues = pipeline.validateProgram(profile, dump.image, haltPc);
  if (imagePolicyIssues.length) {
    return failedCase(
      item,
      'assemble',
      `测试中止：程序映像（ProgramImage）不符合课程硬件约定：[${imagePolicyIssues[0].code}] ${imagePolicyIssues[0].message}`,
      asmCase.machineCode,
      undefined,
      asmCase
    );
  }
  const onSimulationStart = options.onPhase && (() => options.onPhase?.('simulate'));
  if (probe) {
    if (enginePlan.mode === 'verify-both') {
      return failedCase(
        item,
        'oracle',
        '完整流程交叉验证不可比较：P7 定向检查仅验证待测 CPU 的可观察行为，不产生可用于比较的参考执行结果',
        asmCase.machineCode,
        undefined,
        asmCase
      );
    }
    if (!automatic) {
      services.output.appendLine(`P7 定向检查场景： ${probe.scenarios.map((scenario) => `${scenario.id}:${p7ProbeKindLabel(scenario.kind)}`).join(', ')}`);
    }
    await options.onPhase?.('compile');
    const dut = await pipeline.runDut(services, {
      resource,
      showMessages: false,
      revealOutput: options.revealOutput,
      asmCase,
      simOutputFileName: simOutputFileNameForCase(item),
      simOutputUri: caseOutputMode ? asmCaseArtifactUri(asmCase, 'verilog', simOutputFileNameForCase(item)) : undefined,
      p7Probe: probe,
      p7HaltPc: haltPc,
      simTime: courseTraceSimulationTime(p7ProbeExecutionInstructionBudget),
      ...(onSimulationStart ? { onSimulationStart } : {}),
      nonInteractive: true,
      automaticRunSlot: options.automaticRunSlot,
      signal: options.signal
    });
    if (!dut?.simResult || !dut.simOut
      || (!dut.simResult.ok && (!isP7ObservationLimit(dut.simResult.stopReason) || options.signal?.aborted))) {
      return failedDutCaseResult(item, asmCase, dut, undefined, options.signal);
    }
    await options.onPhase?.('compare');
    // The runner has already persisted this exact bounded stdout as simOut. Reuse the
    // retained process text instead of reading and decoding a trace of up to 16 MiB again.
    const limited = !dut.simResult.ok;
    const raw = dut.simResult.stdout;
    const simText = limited ? raw.slice(0, raw.lastIndexOf('\n') + 1) : raw;
    const simEvents = parseSimOutput(simText);
    const probeResult = concludeP7Probe(checkP7Probe(simText, simEvents, probe, dump.image), simText, haltPc, limited);
    if (limited && !probeResult.failures.length) {
      return failedDutCaseResult(item, asmCase, dut, undefined, options.signal);
    }
    const uncovered = probeResult.failures.length === 0 && probeResult.coverage?.find(item => !item.covered);
    return {
      asm: asm.fsPath,
      stdin: item.stdin?.fsPath,
      ...caseResultFields(asmCase),
      status: uncovered ? 'error' : probeResult.passed ? 'passed' : 'failed',
      stage: 'probe',
      message: uncovered ? uncovered.message
        : probeResult.passed ? 'P7 定向检查通过' : probeResult.failures[0]?.message ?? 'P7 定向检查失败',
      machineCode: asmCase.machineCode.fsPath,
      dutOut: dut.simOut.fsPath,
      dutBackend: dut.backend,
      dutEvents: simEvents.length,
      probe: probeResult
    };
  }

  await options.onPhase?.('oracle');
  const machineCodeText = await readTextFile(asmCase.machineCode);
  let stdinText: string | undefined;
  try {
    stdinText = await readAsmCaseStdinSnapshot(asmCase);
  } catch (error) {
    return failedCase(
      item,
      'oracle',
      error instanceof Error ? error.message : String(error),
      asmCase.machineCode,
      undefined,
      asmCase
    );
  }
  const preOracleSourceIssue = await asmCaseSourceSnapshotIssue(asmCase);
  if (preOracleSourceIssue) {
    return failedCase(item, 'oracle', preOracleSourceIssue, asmCase.machineCode, undefined, asmCase);
  }
  const manifestSource = manifestSourceOf(asmCase.manifest);
  const recordedInstructionCount = automatic
    && asmCase.manifest.version === 2
    && manifestSource.kind === 'builtin'
    ? Number(asmCase.manifest.metadata?.['source.instructionCount'])
    : Number.NaN;
  const recordedBudget = courseExecutionInstructionBudgetFromCount(profile, recordedInstructionCount);
  const maxSteps = recordedBudget ?? courseExecutionInstructionBudget(
    profile,
    await readTextFile(asmCase.sourceAsm),
    manifestSource.kind === 'builtin',
    machineCodeText
  );
  if (!automatic) {
    services.output.appendLine('参考引擎已设置执行步数上限，并要求验证标准停机尾');
  }
  const oracleOutputUri = caseOutputMode
    ? asmCaseArtifactUri(asmCase, 'oracle', oracleOutputFileNameForCase(item))
    : vscode.Uri.file(path.join(courseTraceOutputDirectory(asm).fsPath, oracleOutputFileNameForCase(item)));
  const oracleInvocation = await pipeline.runOracle(services, {
    image: dump.image,
    executionBinding: dump.executionBinding,
    stdin: stdinText,
    trace: { kind: 'architectural-writes', courseCorrect: true },
    maxSteps,
    haltPc,
    runOutputFile: oracleOutputUri,
    interruptSchedule,
    p7RiInstruction: dump.resolvedRun?.p7RiInstruction,
    courseTrace: true,
    revealOutput: options.revealOutput,
    requirements: {
      profile,
      instructionLayers: ['required', 'commonExtensions', 'marsCompatibility'],
      syscallMode: profile === 'P7' ? 'course-exception' : undefined,
      devices: profile === 'P7' ? ['cp0', 'timer', 'external-interrupt-generator'] : [],
      ...(stdinText === undefined ? {} : { deterministicConsole: true }),
      eventSchemaRevision: 1
    }
  }, {
    signal: options.signal,
    nonInteractive: automatic ? true : undefined
  }, enginePlan);
  const oracle = oracleInvocation.result;
  const postOracleSourceIssue = await asmCaseSourceSnapshotIssue(asmCase);
  if (postOracleSourceIssue) {
    return failedCase(item, 'oracle', postOracleSourceIssue, asmCase.machineCode, oracle?.outputFile, asmCase);
  }
  if (!oracle?.ok || !oracle.outputFile || !oracle.trace) {
    const detail = oracle
      ? engineStageFailureMessage('测试中止：参考引擎运行失败或未返回规范写回记录', oracle.status)
      : `测试中止：参考引擎预检失败： ${preflightFailureMessage(oracleInvocation.preflight)}`;
    return failedCase(
      item,
      'oracle',
      detail,
      asmCase.machineCode,
      undefined,
      asmCase,
      engineRunWasCancelled(oracle?.status, options.signal)
    );
  }
  if (caseOutputMode) {
    await pipeline.updateArtifacts(asmCase, 'oracle', {
      traceOut: oracle.outputFile.fsPath,
      ...(oracle.eventArtifact ? { events: oracle.eventArtifact.fsPath } : {})
    });
  } else {
    await pipeline.copyArtifact(asmCase, 'oracle', oracle.outputFile, path.basename(oracle.outputFile.fsPath), 'traceOut');
    if (oracle.eventArtifact) {
      await pipeline.copyArtifact(
        asmCase,
        'oracle',
        oracle.eventArtifact,
        path.basename(oracle.eventArtifact.fsPath),
        'events'
      );
    }
  }
  await pipeline.recordOracle(asmCase, oracle, {
    profile: oracle.resolvedRun?.profile ?? profile,
    memoryConfiguration: oracle.resolvedRun?.memoryConfiguration ?? getMemoryConfiguration(asmCase.sourceAsm),
    courseTrace: true,
    maxSteps,
    haltPc,
    interruptSchedule,
    stdinSha256: asmCase.manifest.stdin?.sha256
  }, { stopReason: 'halt-loop' });

  let shadowSummary: CourseTraceShadowSummary | undefined;
  const executorShadow = options.oracleMode === 'verify-both'
    ? await runExecutorShadow(services, asmCase, {
      profile,
      image: dump.image,
      maxSteps,
      haltPc,
      interruptSchedule,
      legacy: oracle,
      outputRoot: options.shadowOutputRoot?.fsPath ?? path.join(asmCase.dir.fsPath, 'shadow'),
      signal: options.signal
    })
    : undefined;
  if (executorShadow) {
    shadowSummary = executorShadowSummary(executorShadow);
    const shadowCancelled = executorShadow.builtinResult?.stop?.kind === 'cancelled'
      || engineRunWasCancelled(executorShadow.builtinResult?.status, options.signal);
    if (shadowCancelled || executorShadow.status === 'inconclusive' || executorShadow.status === 'not-comparable') {
      return {
        ...failedCase(
          item,
          'oracle',
          shadowCancelled
            ? `测试已取消：执行器交叉验证：${executorShadow.message}`
            : `测试中止：执行器交叉验证${executorShadow.status === 'inconclusive' ? '存在未登记差异' : '不可比较'}：${executorShadow.message}`,
          asmCase.machineCode,
          oracle.outputFile,
          asmCase,
          shadowCancelled
        ),
        shadow: shadowSummary
      };
    }
    services.output.appendLine(executorShadow.message);
  }

  const fullStackShadow = enginePlan.mode === 'verify-both'
    ? await runFullStackShadow(services, asmCase, {
      profile,
      builtinAssembly: dump,
      builtinExecution: oracle,
      maxSteps,
      haltPc,
      interruptSchedule,
      p7RiInstruction: dump.resolvedRun?.p7RiInstruction,
      outputRoot: options.shadowOutputRoot?.fsPath ?? path.join(asmCase.dir.fsPath, 'shadow'),
      expectedLegacySha256: fixedMars?.ok ? fixedMars.identity.sha256 : undefined,
      signal: options.signal,
      nonInteractive: automatic ? true : undefined
    })
    : undefined;
  if (fullStackShadow) {
    shadowSummary = fullStackShadowSummary(fullStackShadow);
    if (fullStackShadow.status === 'inconclusive' || fullStackShadow.status === 'not-comparable') {
      return {
        ...failedCase(
          item,
          'oracle',
          `测试中止：完整流程交叉验证${fullStackShadow.status === 'inconclusive' ? '存在未登记差异' : '不可比较'}：${fullStackShadow.message}`,
          asmCase.machineCode,
          oracle.outputFile,
          asmCase
        ),
        shadow: shadowSummary
      };
    }
  }

  const simulationTiming = options.source?.kind === 'selected' && profile !== 'P7' && oracle.stop?.kind === 'halt-loop'
    ? userAsmSimulationTiming(maxSteps, oracle.instructions)
    : { simTime: courseTraceSimulationTime(maxSteps) };
  await options.onPhase?.('compile');
  const dut = await pipeline.runDut(services, {
    resource,
    customInstructionEncodings: dump.customInstructionEncodings,
    showMessages: false,
    revealOutput: options.revealOutput,
    asmCase,
    simOutputFileName: simOutputFileNameForCase(item),
    simOutputUri: caseOutputMode ? asmCaseArtifactUri(asmCase, 'verilog', simOutputFileNameForCase(item)) : undefined,
    interruptSchedule,
    ...(profile === 'P7' ? { p7HaltPc: haltPc } : {}),
    ...simulationTiming,
    ...(onSimulationStart ? { onSimulationStart } : {}),
    nonInteractive: true,
    automaticRunSlot: options.automaticRunSlot,
    signal: options.signal
  });
  if (!dut?.simResult?.ok || !dut.simOut) {
    return failedDutCaseResult(item, asmCase, dut, oracle.outputFile, options.signal);
  }

  await options.onPhase?.('compare');
  const simText = dut.simResult.stdout;
  const diff = pipeline.compareTraces(oracle.trace.events, iterCpuTraceEvents(simText), {
    compareCycles: false,
    retainedEntryLimit: batchTraceCompareRetainedEntries
  });
  const storeDifference = diff.matched && oracle.events && (profile === 'P6' || profile === 'P7')
    ? firstDmStoreDifference(oracle.events, simText)
    : undefined;

  if (!diff.matched && oracle.referenceTiming === 'p7-timer-observed') {
    return failedCase(item, 'oracle',
      '写回记录存在差异，但参考 Mars 的 Timer 按指令推进，无法据此判定时钟级 CPU 错误；请结合 P7 Timer/MMIO/中断黑盒 probe 的结果定位',
      asmCase.machineCode, oracle.outputFile, asmCase);
  }

  const haltObserved = profile === 'P7' && observedP7Halt(simText, haltPc);
  if (!haltObserved && (!diff.summary.oracleEvents || !diff.summary.dutEvents)) {
    const emptyTraceMessage = !diff.summary.oracleEvents && !diff.summary.dutEvents
      ? '参考结果与待测 CPU 均无可解析的写回事件，现有观测结果无法判定 CPU 是否实际执行了程序'
      : '参考结果与待测 CPU 中有一方没有可解析的写回事件';
    return {
      asm: asm.fsPath,
      stdin: item.stdin?.fsPath,
      ...caseResultFields(asmCase),
      status: 'error',
      stage: 'compare',
      message: emptyTraceMessage,
      machineCode: asmCase.machineCode.fsPath,
      oracleOut: oracle.outputFile.fsPath,
      dutOut: dut.simOut.fsPath,
      dutBackend: dut.backend,
      oracleEvents: diff.summary.oracleEvents,
      dutEvents: diff.summary.dutEvents,
      matchedEvents: diff.summary.matchedEvents,
      diffEvents: diff.summary.diffEvents,
      ...(shadowSummary ? { shadow: shadowSummary } : {})
    };
  }

  const firstDiff = storeDifference ?? (diff.matched ? undefined : firstTraceDiffSnapshot(diff));
  const haltUnobserved = profile === 'P7' && !haltObserved
    && (!firstDiff || firstDiff.status === 'oracle-only');
  return {
    asm: asm.fsPath,
    stdin: item.stdin?.fsPath,
    ...caseResultFields(asmCase),
    status: haltUnobserved ? 'error' : diff.matched && !storeDifference ? 'passed' : 'failed',
    stage: 'compare',
    message: haltUnobserved
      ? `未覆盖：在观测预算内未看到宏观 PC 完成 0x${haltPc.toString(16)} 处的停机循环`
      : storeDifference?.reason ?? diffMessage(diff),
    machineCode: asmCase.machineCode.fsPath,
    oracleOut: oracle.outputFile.fsPath,
    dutOut: dut.simOut.fsPath,
    dutBackend: dut.backend,
    firstDiffIndex: diff.firstDiffIndex >= 0 ? diff.firstDiffIndex : undefined,
    firstDiff,
    oracleEvents: diff.summary.oracleEvents,
    dutEvents: diff.summary.dutEvents,
    matchedEvents: diff.summary.matchedEvents,
    diffEvents: diff.summary.diffEvents,
    ...(shadowSummary ? { shadow: shadowSummary } : {})
  };
}

/** Reuse the automatic pipeline when one caller needs to decorate a single stage. */
export function defaultCourseTracePipeline(overrides: Partial<CourseTracePipelineDependencies> = {}): CourseTracePipeline {
  return new CourseTracePipeline({
    createCase: createAsmCaseFromAsm,
    prepareProgram: prepareAsmCaseMachineCode,
    runOracle: executeWithPreflight,
    runDut: runVerilogSimulation,
    compareTraces: compareTraceIterables,
    recordOracle: recordAsmCaseOracleResult,
    updateArtifacts: updateAsmCaseArtifacts,
    copyArtifact: copyAsmCaseArtifact,
    ...overrides
  });
}

function failedDutCaseResult(
  item: CourseTraceCaseInput,
  asmCase: AsmCase,
  dut: VerilogSimulationRunOutput | undefined,
  oracleOutput: vscode.Uri | undefined,
  signal: AbortSignal | undefined
): NeutralCourseTraceCaseResult {
  const workspaceRoot = workspaceFolderFor(item.asm)?.uri.fsPath;
  const contractFailure = privateDmStoreContractFailure(dut, workspaceRoot);
  const failure = contractFailure ?? verilogSimulationFailure(dut, workspaceRoot);
  const diagnosis = verilogSimulationFailureMessage(failure, dut?.backend);
  return {
    ...failedCase(
      item,
      'dut',
      contractFailure ? diagnosis : `测试中止：${diagnosis}`,
      asmCase.machineCode,
      oracleOutput,
      asmCase,
      engineRunWasCancelled(verilogSimulationTerminalResult(dut), signal)
    ),
    ...(contractFailure ? { status: 'failed' } : {}),
    ...(dut?.simOut ? { dutOut: dut.simOut.fsPath } : {}),
    ...(dut?.backend ? { dutBackend: dut.backend } : {}),
    dutFailure: failure
  };
}

function executorShadowSummary(shadow: ExecutorShadowOutcome): CourseTraceShadowSummary {
  return {
    evidenceKind: 'executor-only',
    status: shadow.status,
    message: shadow.message,
    ...(shadow.bundleDir ? { bundleDir: shadow.bundleDir } : {}),
    ...(shadow.resultFile ? { resultFile: shadow.resultFile } : {}),
    legacyEvents: shadow.differential.legacyEvents,
    builtinEvents: shadow.differential.builtinEvents,
    disposition: shadow.differential.disposition,
    ...(shadow.differential.classification?.contractId
      ? { contractId: shadow.differential.classification.contractId }
      : {})
  };
}

function fullStackShadowSummary(shadow: FullStackShadowOutcome): CourseTraceShadowSummary {
  return {
    evidenceKind: 'full-stack',
    status: shadow.status,
    message: shadow.message,
    bundleDir: shadow.bundleDir,
    resultFile: shadow.resultFile,
    legacyEvents: shadow.execution?.legacyEvents,
    builtinEvents: shadow.execution?.builtinEvents,
    disposition: shadow.execution?.disposition ?? shadow.assembly.disposition,
    contractId: shadow.execution?.classification?.contractId ?? shadow.assembly.contractId,
    assemblyMatched: shadow.assembly.matched,
    builtinWords: shadow.assembly.builtinWords,
    legacyWords: shadow.assembly.legacyWords
  };
}

export async function p7MetadataFromManifest(asm: vscode.Uri): Promise<{ interruptSchedule?: number[]; probe?: P7ProbeMetadata } | undefined> {
  const manifest = await readAsmCaseManifestForAsm(asm);
  const p7 = manifest ? manifestP7Of(manifest) : undefined;
  if (!p7) {
    return undefined;
  }
  const interruptSchedule = Array.isArray(p7.interruptSchedule)
    ? p7.interruptSchedule.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : undefined;
  const probe = isProbeMetadata(p7.probe) ? p7.probe : undefined;
  return interruptSchedule?.length || probe ? { interruptSchedule, probe } : undefined;
}

function resolveCaseInterruptScheduleFromCase(asmCase: AsmCase): number[] | undefined {
  const schedule = manifestP7Of(asmCase.manifest)?.interruptSchedule;
  return Array.isArray(schedule) && schedule.length ? schedule : undefined;
}

function resolveCaseProbeMetadataFromCase(asmCase: AsmCase): P7ProbeMetadata | undefined {
  const probe = manifestP7Of(asmCase.manifest)?.probe;
  return isProbeMetadata(probe) ? probe : undefined;
}

function isProbeMetadata(value: unknown): value is P7ProbeMetadata {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const probe = value as P7ProbeMetadata;
  return probe.version === 1
    && Number.isFinite(probe.logBase)
    && Number.isFinite(probe.recordWords)
    && Array.isArray(probe.scenarios);
}
