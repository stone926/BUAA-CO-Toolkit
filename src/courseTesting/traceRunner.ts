// @index course-trace-runner — 单个课程 Trace case 的 provider-neutral oracle/DUT 执行与比较
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getMemoryConfiguration,
  getMipsEngine,
  getProfile,
  type MipsEngineMode
} from '../config';
import { P7ProbeMetadata } from './builtinAsmGenerator';
import { checkP7Probe } from './p7ProbeCheck';
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
import { defaultTraceCompareMode } from '../traceCompare';
import {
  runVerilogSimulation,
  verilogSimulationTerminalResult
} from '../verilog/simulationRunner';
import { IsimCompileCache } from '../verilogIsimCache';
import { AppServices } from '../types';
import { readTextFile } from '../fsUtil';
import { normalizePathKey } from '../pathUtils';
import {
  courseExecutionInstructionBudget,
  courseTraceIsimRunTcl,
  p7ProbeExecutionInstructionBudget
} from './pipeline/executionBudget';
import { CourseTracePipeline } from './pipeline/courseTracePipeline';
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
  AsmCaseManifestUnion,
  manifestMachineCodeOf,
  manifestP7Of,
  manifestSourceOf
} from './manifestCodec';
import {
  asmCaseSourceFromBatchSource,
  caseResultFields,
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
import { diffMessage, engineRunWasCancelled, engineStageFailureMessage } from '../courseTestMessages';
import { runExecutorShadow, type ExecutorShadowOutcome } from './executorShadowRunner';
import { runFullStackShadow, type FullStackShadowOutcome } from './fullStackShadowRunner';
import { runP3LogisimTraceCase } from '../courseTestLogisim';
import type { P3LogisimTraceSetup } from '../courseTestLogisim';
import { automaticTestEngineMode } from './automaticTestPolicy';

const batchTraceCompareRetainedEntries = 1;

export interface CourseTraceRunOptions {
  revealOutput?: boolean;
  source?: CourseTraceBatchSource;
  logisim?: P3LogisimTraceSetup;
  isimCompileCache?: IsimCompileCache;
  artifactOutputMode?: 'workspace' | 'case';
  /** Snapshot override used by explicit developer lanes; normal runs read co.mips.engine once. */
  engineMode?: MipsEngineMode;
  /** Phase-4 executor shadow: run legacy + builtin and adjudicate the difference. */
  oracleMode?: 'verify-both';
  /** Trusted root for shadow bundles; defaults to the immutable ASM case directory. */
  shadowOutputRoot?: vscode.Uri;
  /** Phase-4 full-trace stage injection; tests and future lanes can replace one stage. */
  pipeline?: CourseTracePipeline;
  /** Cancels the oracle and DUT processes as one logical course-test job. */
  signal?: AbortSignal;
}

export async function runCourseTraceCase(
  services: AppServices,
  item: CourseTraceCaseInput,
  options: CourseTraceRunOptions = {}
): Promise<NeutralCourseTraceCaseResult> {
  const asm = item.asm;
  const profile = getProfile(asm);
  if (profile === 'P3') {
    return await runP3LogisimTraceCase(services, item, options);
  }
  const automatic = options.source?.kind === 'generator';
  const enginePlan = resolveCourseEnginePlan(
    // Every generated case shares the private automatic stack. Besides keeping rollback modes
    // out of the public workflow, this is required for raw `.word` RI cases that course MARS
    // intentionally rejects in text/ktext. Manual and replay cases still honor their engine plan.
    automatic ? automaticTestEngineMode : options.engineMode ?? getMipsEngine(asm),
    profile,
    { deterministicConsole: item.stdin !== undefined }
  );
  if (enginePlan.mode === 'verify-both' && item.stdin) {
    return failedCase(
      item,
      'oracle',
      'Full-stack 固定 MARS 验证不支持带 stdin 的用例；此能力仍由阶段 7 处理'
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

  services.output.appendLine(automatic ? '正在运行自动测试点' : '完整课程 Trace 测试');
  if (!automatic) {
    services.output.appendLine(`ASM: ${asm.fsPath}`);
  }
  if (item.stdin && !automatic) {
    services.output.appendLine(`标准输入: ${item.stdin.fsPath}`);
  }

  const asmCase = item.asmCase ?? await pipeline.createCase(asm, {
    source: asmCaseSourceFromBatchSource(options.source ?? { kind: 'selected', asmFiles: [asm.fsPath] }),
    stdin: item.stdin,
    resource: asm,
    enginePlan,
    p7: await p7MetadataFromManifest(asm)
  });
  const caseOutputMode = options.artifactOutputMode === 'case';
  if (!automatic) {
    services.output.appendLine(`ASM case: ${asmCase.manifestUri.fsPath}`);
  }

  if (item.asmCase && item.stdin
    && normalizePathKey(item.stdin.fsPath) !== normalizePathKey(asmCase.manifest.stdin?.originalPath ?? '')) {
    return failedCase(
      item,
      'oracle',
      '测试中止：已有 ASM case 不能改用另一个标准输入；请创建新 case',
      undefined,
      undefined,
      asmCase
    );
  }

  let dump: Awaited<ReturnType<CourseTracePipeline['prepareProgram']>>;
  try {
    dump = await pipeline.prepareProgram(services, asmCase, {
      showMessages: false,
      revealOutput: options.revealOutput,
      nonInteractive: automatic ? true : undefined,
      courseTrace: true,
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
    return failedCase(
      item,
      'assemble',
      engineStageFailureMessage('测试中止：汇编器导出机器码失败', dump?.status),
      undefined,
      undefined,
      asmCase,
      engineRunWasCancelled(dump?.status, options.signal)
    );
  }
  if (!automatic) {
    services.output.appendLine(`机器码: ${asmCase.machineCode.fsPath}`);
  }

  const interruptSchedule = resolveCaseInterruptScheduleFromCase(asmCase);
  if (interruptSchedule && !automatic) {
    services.output.appendLine(`外部中断目标 PC: ${interruptSchedule.map((pc) => `0x${(pc >>> 0).toString(16)}`).join(', ')}`);
  }
  const probe = resolveCaseProbeMetadataFromCase(asmCase);
  if (probe) {
    if (enginePlan.mode === 'verify-both') {
      return failedCase(
        item,
        'oracle',
        'Full-stack shadow 不可比较：P7 probe 是 DUT-only 性质检查，不产生可比较的 oracle execution evidence',
        asmCase.machineCode,
        undefined,
        asmCase
      );
    }
    if (!automatic) {
      services.output.appendLine(`P7 Probe 场景: ${probe.scenarios.map((scenario) => `${scenario.id}:${scenario.kind}`).join(', ')}`);
    }
    const dut = await pipeline.runDut(services, {
      resource: asm,
      showMessages: false,
      revealOutput: options.revealOutput,
      asmCase,
      simOutputFileName: simOutputFileNameForCase(item),
      simOutputUri: caseOutputMode ? asmCaseArtifactUri(asmCase, 'verilog', simOutputFileNameForCase(item)) : undefined,
      p7Probe: probe,
      tclText: courseTraceIsimRunTcl(p7ProbeExecutionInstructionBudget),
      compileCache: options.isimCompileCache,
      nonInteractive: automatic,
      signal: options.signal
    });
    if (!dut?.simResult?.ok || !dut.simOut) {
      return {
        ...failedCase(
          item,
          'dut',
          '测试中止：DUT 运行失败',
          asmCase.machineCode,
          undefined,
          asmCase,
          engineRunWasCancelled(verilogSimulationTerminalResult(dut), options.signal)
        ),
        ...(dut?.backend ? { dutBackend: dut.backend } : {})
      };
    }
    const simText = await readTextFile(dut.simOut);
    const simEvents = parseSimOutput(simText);
    const probeResult = checkP7Probe(simText, simEvents, probe);
    return {
      asm: asm.fsPath,
      stdin: item.stdin?.fsPath,
      ...caseResultFields(asmCase),
      status: probeResult.passed ? 'passed' : 'failed',
      stage: 'probe',
      message: probeResult.passed ? 'P7 Probe 检查通过' : probeResult.failures[0]?.message ?? 'P7 Probe 检查失败',
      machineCode: asmCase.machineCode.fsPath,
      dutOut: dut.simOut.fsPath,
      dutBackend: dut.backend,
      dutEvents: simEvents.length,
      probe: probeResult
    };
  }

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
  const maxSteps = courseExecutionInstructionBudget(
    profile,
    await readTextFile(asmCase.sourceAsm),
    manifestSourceOf(asmCase.manifest).kind === 'builtin',
    machineCodeText
  );
  const haltPc = manifestMachineCodeOf(asmCase.manifest)?.haltPc;
  if (haltPc === undefined || !Number.isSafeInteger(haltPc)) {
    return failedCase(item, 'assemble', '测试中止：最终用户 .text dump 未记录已验证的标准停机 PC', asmCase.machineCode, undefined, asmCase);
  }
  if (!dump.image) {
    return failedCase(item, 'assemble', '测试中止：assembler 未返回权威 ProgramImage', asmCase.machineCode, undefined, asmCase);
  }
  const imagePolicyIssues = pipeline.validateProgram(profile, dump.image, haltPc);
  if (imagePolicyIssues.length) {
    return failedCase(
      item,
      'assemble',
      `测试中止：ProgramImage 不符合课程硬件契约：[${imagePolicyIssues[0].code}] ${imagePolicyIssues[0].message}`,
      asmCase.machineCode,
      undefined,
      asmCase
    );
  }
  if (!automatic) {
    services.output.appendLine('Oracle 已设置有界执行预算，并要求 provider 证明标准停机尾');
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
      ? engineStageFailureMessage('测试中止：oracle 运行失败或未返回 canonical trace', oracle.status)
      : `测试中止：oracle preflight 失败: ${preflightFailureMessage(oracleInvocation.preflight)}`;
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
            ? `测试已取消：executor shadow：${executorShadow.message}`
            : `测试中止：executor shadow ${executorShadow.status === 'inconclusive' ? '存在未登记差异' : '不可比较'}：${executorShadow.message}`,
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
          `测试中止：full-stack shadow ${fullStackShadow.status === 'inconclusive' ? '存在未登记差异' : '不可比较'}：${fullStackShadow.message}`,
          asmCase.machineCode,
          oracle.outputFile,
          asmCase
        ),
        shadow: shadowSummary
      };
    }
  }

  const dut = await pipeline.runDut(services, {
    resource: asm,
    showMessages: false,
    revealOutput: options.revealOutput,
    asmCase,
    simOutputFileName: simOutputFileNameForCase(item),
    simOutputUri: caseOutputMode ? asmCaseArtifactUri(asmCase, 'verilog', simOutputFileNameForCase(item)) : undefined,
    interruptSchedule,
    tclText: courseTraceIsimRunTcl(maxSteps),
    compileCache: options.isimCompileCache,
    nonInteractive: automatic,
    signal: options.signal
  });
  if (!dut?.simResult?.ok || !dut.simOut) {
    return {
      ...failedCase(
        item,
        'dut',
        '测试中止：DUT 运行失败',
        asmCase.machineCode,
        oracle.outputFile,
        asmCase,
        engineRunWasCancelled(verilogSimulationTerminalResult(dut), options.signal)
      ),
      ...(dut?.backend ? { dutBackend: dut.backend } : {})
    };
  }

  const simText = await readTextFile(dut.simOut);
  const diff = pipeline.compareTraces(oracle.trace.events, iterCpuTraceEvents(simText), {
    compareCycles: defaultTraceCompareMode.compareCycles,
    retainedEntryLimit: batchTraceCompareRetainedEntries
  });

  if (!diff.summary.oracleEvents || !diff.summary.dutEvents) {
    const emptyTraceMessage = !diff.summary.oracleEvents && !diff.summary.dutEvents
      ? 'Oracle 与 DUT 均无可解析的写回 Trace 事件，现有观测结果无法判定 CPU 是否实际执行了程序'
      : 'Oracle 与 DUT 仅有一端没有可解析的 Trace 事件';
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

  return {
    asm: asm.fsPath,
    stdin: item.stdin?.fsPath,
    ...caseResultFields(asmCase),
    status: diff.matched ? 'passed' : 'failed',
    stage: 'compare',
    message: diffMessage(diff),
    machineCode: asmCase.machineCode.fsPath,
    oracleOut: oracle.outputFile.fsPath,
    dutOut: dut.simOut.fsPath,
    dutBackend: dut.backend,
    firstDiffIndex: diff.firstDiffIndex >= 0 ? diff.firstDiffIndex : undefined,
    firstDiff: firstTraceDiffSnapshot(diff),
    oracleEvents: diff.summary.oracleEvents,
    dutEvents: diff.summary.dutEvents,
    matchedEvents: diff.summary.matchedEvents,
    diffEvents: diff.summary.diffEvents,
    ...(shadowSummary ? { shadow: shadowSummary } : {})
  };
}

function defaultCourseTracePipeline(): CourseTracePipeline {
  return new CourseTracePipeline({
    createCase: createAsmCaseFromAsm,
    prepareProgram: prepareAsmCaseMachineCode,
    runOracle: executeWithPreflight,
    runDut: runVerilogSimulation,
    compareTraces: compareTraceIterables,
    recordOracle: recordAsmCaseOracleResult,
    updateArtifacts: updateAsmCaseArtifacts,
    copyArtifact: copyAsmCaseArtifact
  });
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
