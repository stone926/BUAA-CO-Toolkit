import { CO_LOGISIM_DIR } from './constants';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getJava,
  getLogisimJar,
  getLogisimTraceColumns,
  getLogisimTraceMainCircuit,
  getMemoryConfiguration,
  getMipsEngine,
  getProfile,
  getRunTimeout,
  showCommandBeforeRun,
  type MipsEngineMode
} from './config';
import {
  analyzeP3LogisimTraceCircuit,
  createLogisimPcProgressState,
  defaultLogisimTraceCircuit,
  formatLogisimTraceEvents,
  formatP3LogisimTraceDiagnostic,
  inspectLogisimPcProgress,
  LogisimTraceColumnMap,
  LogisimTraceSpec,
  p3LogisimMaxWords,
  parseLogisimTraceOutput,
  parseLogisimTraceSpec,
  P3LogisimMachineCode,
  prepareP3LogisimMachineCode,
  setLogisimMainCircuit,
  validateP3LogisimFetchTrace
} from './courseTesting/logisimTrace';
import {
  logisimPrepSummary,
  LogisimPrepareCaseResult,
  preparedCircuitFileName
} from './courseTesting/logisimPrep';
import { ensureDirectory, readTextFile, workspaceFolderFor, workspaceFolderForOrFirst, writeTextFile } from './fsUtil';
import {
  findLogisimRomTargets,
  injectMachineCodeIntoLogisimRom,
  LogisimRomTarget,
  parseMachineCodeWords
} from './language/logisim/rom';
import { compareTraceIterables, firstTraceDiffSnapshot } from './language/mips/traceCompare';
import { commandLine, revealOutputChannel } from './process';
import { runProcessCore } from './processCore';
import { checkToolchain } from './toolchain';
import { AppServices, RunResult } from './types';
import { courseExecutionInstructionBudget } from './courseTesting/executionBudget';
import { resolveWorkspaceFile } from './workflowInputs';
import {
  courseTraceMemoryConfigurationErrorForEngine,
  formatAutomaticToolchainFailure,
  formatToolchainFailure,
  requiredCourseTraceToolchainChecks,
  requiredToolchainFailures
} from './courseTestToolchain';
import {
  asmCaseArtifactUri,
  asmCaseSourceSnapshotIssue,
  copyAsmCaseArtifact,
  createAsmCaseFromAsm,
  prepareAsmCaseMachineCode,
  recordAsmCaseOracleResult,
  updateAsmCaseArtifacts,
  updateAsmCaseMetadata,
  writeAsmCaseArtifact
} from './asmCaseStore';
import {
  CourseTraceBatchSource,
  CourseTraceShadowSummary,
  LogisimPrepareReport,
  NeutralCourseTraceCaseResult,
  showLogisimPrepareReport
} from './courseTestReport';
import {
  asmCaseSourceFromBatchSource,
  caseResultFields,
  CourseTraceCaseInput,
  failedCase
} from './courseTestCases';
import { executeWithPreflight, preflightFailureMessage } from './mips/providers/providerResolver';
import { resolveCourseEnginePlan } from './mips/providers/courseEnginePolicy';
import { verifyConfiguredFixedMarsReference } from './mips/providers/fixedMarsReference';
import { runExecutorShadow, type ExecutorShadowOutcome } from './courseTesting/executorShadowRunner';
import { runFullStackShadow, type FullStackShadowOutcome } from './courseTesting/fullStackShadowRunner';
import { CourseTracePipeline } from './courseTesting/pipeline/courseTracePipeline';
import { manifestSourceOf } from './courseTesting/manifestCodec';
import { defaultTraceCompareMode } from './traceCompare';
import {
  courseTraceOutputDirectory,
  logisimRawOutputFileNameForCase,
  oracleOutputFileNameForCase,
  simOutputFileNameForCase
} from './courseTestTraceFiles';
import { diffMessage, engineRunWasCancelled, engineStageFailureMessage } from './courseTestMessages';
import {
  automaticExternalToolTimeoutMs,
  automaticTestEngineMode
} from './courseTesting/automaticTestPolicy';

const batchTraceCompareRetainedEntries = 1;

export interface P3LogisimTraceSetup {
  circuit: vscode.Uri;
  circuitText: string;
  traceCircuit: string;
  traceSpec: LogisimTraceSpec;
  traceDiagnostic: string;
  traceColumns?: LogisimTraceColumnMap;
  romTarget: LogisimRomTarget;
}

export interface P3LogisimTraceSetupOptions {
  /** Internal automatic-test setup: keep tool details out of the normal user surface. */
  nonInteractive?: boolean;
}

export interface LogisimCliTraceRun {
  result: RunResult;
  stdout: string;
  stderr: string;
  rowsSeen: number;
  haltedByPc: boolean;
  pcError?: string;
}

export interface P3LogisimTraceRunOptions {
  revealOutput?: boolean;
  source?: CourseTraceBatchSource;
  logisim?: P3LogisimTraceSetup;
  artifactOutputMode?: 'workspace' | 'case';
  engineMode?: MipsEngineMode;
  oracleMode?: 'verify-both';
  shadowOutputRoot?: vscode.Uri;
  pipeline?: CourseTracePipeline;
  signal?: AbortSignal;
}

export async function diagnoseP3LogisimTraceCircuit(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);
  const circuit = await resolveLogisimCircuitInput();
  if (!circuit) {
    return;
  }
  const circuitText = await readTextFile(circuit);
  const traceCircuit = getLogisimTraceMainCircuit(circuit) || defaultLogisimTraceCircuit;
  const traceColumns = getLogisimTraceColumns(circuit) as LogisimTraceColumnMap | undefined;
  const report = analyzeP3LogisimTraceCircuit(circuitText, traceCircuit, { traceColumns });
  const diagnostic = formatP3LogisimTraceDiagnostic(report);
  revealOutputChannel(services.output, circuit);
  services.output.appendLine('');
  services.output.appendLine(diagnostic);
  if (report.spec) {
    vscode.window.showInformationMessage('P3 Logisim Trace 电路诊断通过，详见输出面板');
  } else {
    vscode.window.showErrorMessage(`P3 Logisim Trace 电路诊断失败：${report.errors[0] ?? '无法解析 trace 端口'}`);
  }
}

export async function runLogisimPrepareBatch(
  services: AppServices,
  cases: CourseTraceCaseInput[],
  source: CourseTraceBatchSource
): Promise<void> {
  const automatic = source.kind === 'generator';
  const circuit = await resolveLogisimCircuitInput();
  if (!circuit) {
    return;
  }

  const circuitText = await readTextFile(circuit);
  const target = await resolveLogisimRomTarget(circuitText);
  if (!target) {
    return;
  }

  const folder = workspaceFolderFor(circuit) ?? workspaceFolderForOrFirst(cases[0]?.asm);
  const baseDir = folder?.uri.fsPath ?? path.dirname(circuit.fsPath);
  const outDir = vscode.Uri.file(path.join(baseDir, CO_LOGISIM_DIR));
  await ensureDirectory(outDir);

  if (!automatic) {
    revealOutputChannel(services.output, circuit);
  }
  services.output.appendLine('');
  services.output.appendLine(automatic
    ? '正在准备自动测试电路'
    : `准备 Logisim 电路用例: ${cases.length} 个用例`);
  if (!automatic) {
    services.output.appendLine(`电路: ${circuit.fsPath}`);
    services.output.appendLine(`ROM: ${target.label ?? 'ROM'}${target.loc ? ` ${target.loc}` : ''}`);
  }

  const results: LogisimPrepareCaseResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const item = cases[i];
    const asm = item.asm;
    services.output.appendLine('');
    services.output.appendLine(automatic
      ? `[${i + 1}/${cases.length}] 正在准备`
      : `[${i + 1}/${cases.length}] ${asm.fsPath}`);

    try {
      const enginePlan = resolveCourseEnginePlan(
        automatic ? automaticTestEngineMode : getMipsEngine(asm),
        'P3'
      );
      const asmCase = item.asmCase ?? await createAsmCaseFromAsm(asm, {
        source: asmCaseSourceFromBatchSource(source),
        resource: circuit,
        enginePlan
      });
      const dump = await prepareAsmCaseMachineCode(services, asmCase, {
        showMessages: false,
        nonInteractive: automatic,
        enginePlan
      });
      if (!dump?.ok || !dump.outputFile) {
        results.push({
          asm: asm.fsPath,
          ...caseResultFields(asmCase),
          status: 'error',
          message: '汇编器导出机器码失败'
        });
        continue;
      }

      const machineCodeText = await readTextFile(asmCase.machineCode);
      const injected = injectMachineCodeIntoLogisimRom(circuitText, machineCodeText, target.index);
      const outFile = vscode.Uri.file(path.join(outDir.fsPath, preparedCircuitFileName(circuit.fsPath, asm.fsPath, baseDir)));
      await writeTextFile(outFile, injected.text);
      await copyAsmCaseArtifact(asmCase, 'logisim', outFile, path.basename(outFile.fsPath), 'preparedCircuit');
      await copyAsmCaseArtifact(asmCase, 'logisim', circuit, 'circuit-template.circ', 'circuitTemplate');
      results.push({
        asm: asm.fsPath,
        ...caseResultFields(asmCase),
        status: 'prepared',
        message: `已注入 ${injected.wordCount} 个机器码`,
        machineCode: asmCase.machineCode.fsPath,
        circuit: outFile.fsPath,
        wordCount: injected.wordCount
      });
      services.output.appendLine(automatic ? '自动测试电路已准备' : `已准备电路: ${outFile.fsPath}`);
    } catch (error) {
      const message = automatic
        ? '自动测试电路准备失败'
        : error instanceof Error ? error.message : String(error);
      results.push({
        asm: asm.fsPath,
        status: 'error',
        message
      });
    }
  }

  if (!automatic) {
    const report = await writeLogisimPrepareReport(circuit, target, results, source, outDir);
    showLogisimPrepareReport(report, results, source, circuit, target);
  }
  const summary = logisimPrepSummary(results);
  const message = `Logisim 用例准备完成: ${summary.prepared} 已准备, ${summary.errors} 错误`;
  if (summary.errors) {
    vscode.window.showWarningMessage(message);
  } else {
    vscode.window.showInformationMessage(message);
  }
}

export async function runP3LogisimTraceCase(
  services: AppServices,
  item: CourseTraceCaseInput,
  options: P3LogisimTraceRunOptions = {}
): Promise<NeutralCourseTraceCaseResult> {
  const asm = item.asm;
  const pipeline = options.pipeline ?? defaultP3TracePipeline();
  const automatic = options.source?.kind === 'generator';
  services.output.appendLine(automatic ? '正在运行自动测试点' : 'P3 Logisim Trace 测试');
  if (!automatic) {
    services.output.appendLine(`ASM: ${asm.fsPath}`);
  }
  if (item.stdin) {
    return {
      asm: asm.fsPath,
      stdin: item.stdin.fsPath,
      status: 'error',
      stage: 'dut',
      message: 'P3 Logisim Trace 对拍不支持标准输入用例'
    };
  }
  const enginePlan = resolveCourseEnginePlan(
    automatic ? automaticTestEngineMode : options.engineMode ?? getMipsEngine(asm),
    'P3'
  );
  const fixedMars = enginePlan.mode === 'verify-both'
    ? await verifyConfiguredFixedMarsReference(asm, { signal: options.signal })
    : undefined;
  if (fixedMars && !fixedMars.ok) {
    return failedCase(item, 'oracle', `[${fixedMars.diagnostic.code}] ${fixedMars.diagnostic.message}`);
  }

  const setup = options.logisim ?? await resolveP3LogisimTraceSetup(services, asm, {
    nonInteractive: automatic
  });
  if (!setup) {
    return {
      asm: asm.fsPath,
      status: 'error',
      stage: 'dut',
      message: '测试中止：未准备 Logisim Trace 电路'
    };
  }

  const asmCase = item.asmCase ?? await pipeline.createCase(asm, {
    source: asmCaseSourceFromBatchSource(options.source ?? { kind: 'selected', asmFiles: [asm.fsPath] }),
    // The ASM owns the course profile and engine snapshot. A circuit selected
    // from another workspace folder must not alter assembler semantics.
    resource: asm,
    enginePlan
  });
  const caseOutputMode = options.artifactOutputMode === 'case';
  if (!automatic) {
    services.output.appendLine(`ASM case: ${asmCase.manifestUri.fsPath}`);
    services.output.appendLine(`Logisim 电路: ${setup.circuit.fsPath}`);
    services.output.appendLine(`Trace 顶层: ${setup.traceCircuit}`);
  }
  await writeAsmCaseArtifact(asmCase, 'logisim', 'logisim-trace-diagnostic.txt', setup.traceDiagnostic, 'traceDiagnostic');

  const dump = await pipeline.prepareProgram(services, asmCase, {
    showMessages: false,
    revealOutput: options.revealOutput,
    nonInteractive: automatic ? true : undefined,
    courseTrace: true,
    enginePlan,
    signal: options.signal
  });
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

  const machineCodeText = await readTextFile(asmCase.machineCode);
  let logisimCode: P3LogisimMachineCode;
  try {
    logisimCode = prepareP3LogisimMachineCode(machineCodeText);
    const capacityError = p3LogisimRomCapacityError(setup.romTarget, logisimCode.terminatedWordCount);
    if (capacityError) {
      return failedCase(item, 'dut', capacityError, asmCase.machineCode, undefined, asmCase);
    }
  } catch (error) {
    return failedCase(
      item,
      'dut',
      error instanceof Error ? error.message : String(error),
      asmCase.machineCode,
      undefined,
      asmCase
    );
  }
  if (!automatic) {
    services.output.appendLine(`Logisim 停机 PC: 0x${logisimCode.haltPcHex}`);
  }

  let preparedCircuit: vscode.Uri;
  try {
    const injected = injectMachineCodeIntoLogisimRom(setup.circuitText, logisimCode.text, setup.romTarget.index);
    const derivedText = setLogisimMainCircuit(injected.text, setup.traceCircuit);
    const folder = workspaceFolderFor(setup.circuit) ?? workspaceFolderFor(asm);
    const baseDir = folder?.uri.fsPath ?? path.dirname(setup.circuit.fsPath);
    const circuitName = preparedCircuitFileName(setup.circuit.fsPath, asm.fsPath, baseDir);
    preparedCircuit = await writeAsmCaseArtifact(asmCase, 'logisim', circuitName, derivedText, 'preparedCircuit');
    await writeAsmCaseArtifact(asmCase, 'logisim', 'logisim-code.txt', logisimCode.text, 'machineCodeWithHalt');
    await pipeline.copyArtifact(asmCase, 'logisim', setup.circuit, 'circuit-template.circ', 'circuitTemplate');
    await updateAsmCaseMetadata(asmCase, {
      'dut.logisim.traceCircuit': setup.traceCircuit
    });
  } catch (error) {
    return {
      asm: asm.fsPath,
      ...caseResultFields(asmCase),
      status: 'error',
      stage: 'dut',
      message: error instanceof Error ? error.message : String(error),
      machineCode: asmCase.machineCode.fsPath
    };
  }

  const preOracleSourceIssue = await asmCaseSourceSnapshotIssue(asmCase);
  if (preOracleSourceIssue) {
    return failedCase(item, 'oracle', preOracleSourceIssue, asmCase.machineCode, undefined, asmCase);
  }
  const maxSteps = courseExecutionInstructionBudget(
    getProfile(asmCase.sourceAsm),
    await readTextFile(asmCase.sourceAsm),
    manifestSourceOf(asmCase.manifest).kind === 'builtin',
    logisimCode.text
  );
  if (!dump.image) {
    return failedCase(item, 'assemble', '测试中止：assembler 未返回权威 ProgramImage', asmCase.machineCode, undefined, asmCase);
  }
  const imagePolicyIssues = pipeline.validateProgram('P3', dump.image, logisimCode.haltPc);
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
    services.output.appendLine(`Oracle 最多执行 ${maxSteps} 条架构指令，并要求 provider 证明标准停机尾`);
  }
  const oracleOutputUri = caseOutputMode
    ? asmCaseArtifactUri(asmCase, 'oracle', oracleOutputFileNameForCase(item))
    : vscode.Uri.file(path.join(courseTraceOutputDirectory(asm).fsPath, oracleOutputFileNameForCase(item)));
  const oracleInvocation = await pipeline.runOracle(services, {
    image: dump.image,
    executionBinding: dump.executionBinding,
    trace: { kind: 'architectural-writes', courseCorrect: true },
    maxSteps,
    haltPc: logisimCode.haltPc,
    p7RiInstruction: dump.resolvedRun?.p7RiInstruction,
    runOutputFile: oracleOutputUri,
    courseTrace: true,
    revealOutput: options.revealOutput,
    requirements: {
      profile: 'P3',
      instructionLayers: ['required', 'commonExtensions', 'marsCompatibility'],
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
    profile: oracle.resolvedRun?.profile ?? 'P3',
    memoryConfiguration: oracle.resolvedRun?.memoryConfiguration ?? getMemoryConfiguration(asmCase.sourceAsm),
    courseTrace: true,
    maxSteps,
    haltPc: logisimCode.haltPc
  }, { stopReason: 'halt-loop' });

  let shadowSummary: CourseTraceShadowSummary | undefined;
  const executorShadow = options.oracleMode === 'verify-both'
    ? await runExecutorShadow(services, asmCase, {
      profile: 'P3',
      image: dump.image,
      maxSteps,
      haltPc: logisimCode.haltPc,
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
      profile: 'P3',
      builtinAssembly: dump,
      builtinExecution: oracle,
      maxSteps,
      haltPc: logisimCode.haltPc,
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

  const logisimRun = await pipeline.runLogisimDut(
    services,
    setup,
    preparedCircuit,
    logisimCode.haltPcHex,
    asm,
    !automatic && options.revealOutput !== false,
    options.signal,
    automatic
  );
  const outDir = caseOutputMode ? undefined : courseTraceOutputDirectory(asm);
  if (outDir) {
    await ensureDirectory(outDir);
  }
  const rawOut = caseOutputMode
    ? asmCaseArtifactUri(asmCase, 'logisim', logisimRawOutputFileNameForCase(item))
    : vscode.Uri.file(path.join(outDir!.fsPath, logisimRawOutputFileNameForCase(item)));
  await writeTextFile(rawOut, logisimRun.stdout);
  if (caseOutputMode) {
    await pipeline.updateArtifacts(asmCase, 'logisim', { logisimOut: rawOut.fsPath });
  } else {
    await pipeline.copyArtifact(asmCase, 'logisim', rawOut, path.basename(rawOut.fsPath), 'logisimOut');
  }

  if (!logisimRun.result.ok) {
    return {
      asm: asm.fsPath,
      ...caseResultFields(asmCase),
      status: 'error',
      ...(engineRunWasCancelled(logisimRun.result, options.signal) ? { cancelled: true as const } : {}),
      stage: 'dut',
      message: engineStageFailureMessage('测试中止：DUT 命令行运行失败', logisimRun.result),
      machineCode: asmCase.machineCode.fsPath,
      oracleOut: oracle.outputFile.fsPath,
      dutRawOut: rawOut.fsPath,
      logisimCircuit: preparedCircuit.fsPath,
      logisimRows: logisimRun.rowsSeen
    };
  }

  let parsedLogisim: ReturnType<typeof parseLogisimTraceOutput>;
  try {
    parsedLogisim = parseLogisimTraceOutput(logisimRun.stdout, setup.traceSpec);
    const fetchValidation = validateP3LogisimFetchTrace(
      parsedLogisim.rows,
      setup.traceSpec,
      parseMachineCodeWords(logisimCode.text),
      logisimCode.haltPcHex
    );
    for (const warning of fetchValidation.warnings) {
      services.output.appendLine(`Logisim fetch check: ${warning}`);
    }
  } catch (error) {
    return {
      asm: asm.fsPath,
      ...caseResultFields(asmCase),
      status: 'error',
      stage: 'dut',
      message: error instanceof Error ? error.message : String(error),
      machineCode: asmCase.machineCode.fsPath,
      oracleOut: oracle.outputFile.fsPath,
      dutRawOut: rawOut.fsPath,
      logisimCircuit: preparedCircuit.fsPath,
      logisimRows: logisimRun.rowsSeen
    };
  }

  const simTrace = caseOutputMode
    ? asmCaseArtifactUri(asmCase, 'logisim', simOutputFileNameForCase(item))
    : vscode.Uri.file(path.join(outDir!.fsPath, simOutputFileNameForCase(item)));
  await writeTextFile(simTrace, formatLogisimTraceEvents(parsedLogisim.events));
  if (caseOutputMode) {
    await pipeline.updateArtifacts(asmCase, 'logisim', { traceOut: simTrace.fsPath });
  } else {
    await pipeline.copyArtifact(asmCase, 'logisim', simTrace, path.basename(simTrace.fsPath), 'traceOut');
  }

  const diff = pipeline.compareTraces(oracle.trace.events, parsedLogisim.events, {
    compareCycles: defaultTraceCompareMode.compareCycles,
    retainedEntryLimit: batchTraceCompareRetainedEntries
  });

  if (!diff.summary.oracleEvents && !parsedLogisim.events.length) {
    return {
      asm: asm.fsPath,
      ...caseResultFields(asmCase),
      status: 'passed',
      stage: 'compare',
      message: 'PC/Instr 校验通过，双方没有可见 GRF/DM 写事件',
      machineCode: asmCase.machineCode.fsPath,
      oracleOut: oracle.outputFile.fsPath,
      dutOut: simTrace.fsPath,
      dutRawOut: rawOut.fsPath,
      logisimCircuit: preparedCircuit.fsPath,
      logisimRows: parsedLogisim.rows.length,
      oracleEvents: 0,
      dutEvents: 0,
      matchedEvents: 0,
      diffEvents: 0,
      ...(shadowSummary ? { shadow: shadowSummary } : {})
    };
  }

  if (!diff.summary.oracleEvents || !parsedLogisim.events.length) {
    return {
      asm: asm.fsPath,
      ...caseResultFields(asmCase),
      status: 'error',
      stage: 'compare',
      message: '某一端没有可解析的 Trace 事件',
      machineCode: asmCase.machineCode.fsPath,
      oracleOut: oracle.outputFile.fsPath,
      dutOut: simTrace.fsPath,
      dutRawOut: rawOut.fsPath,
      logisimCircuit: preparedCircuit.fsPath,
      logisimRows: parsedLogisim.rows.length,
      oracleEvents: diff.summary.oracleEvents,
      dutEvents: parsedLogisim.events.length,
      matchedEvents: diff.summary.matchedEvents,
      diffEvents: diff.summary.diffEvents,
      ...(shadowSummary ? { shadow: shadowSummary } : {})
    };
  }

  return {
    asm: asm.fsPath,
    ...caseResultFields(asmCase),
    status: diff.matched ? 'passed' : 'failed',
    stage: 'compare',
    message: diffMessage(diff),
    machineCode: asmCase.machineCode.fsPath,
    oracleOut: oracle.outputFile.fsPath,
    dutOut: simTrace.fsPath,
    dutRawOut: rawOut.fsPath,
    logisimCircuit: preparedCircuit.fsPath,
    logisimRows: parsedLogisim.rows.length,
    firstDiffIndex: diff.firstDiffIndex >= 0 ? diff.firstDiffIndex : undefined,
    firstDiff: firstTraceDiffSnapshot(diff),
    oracleEvents: diff.summary.oracleEvents,
    dutEvents: diff.summary.dutEvents,
    matchedEvents: diff.summary.matchedEvents,
    diffEvents: diff.summary.diffEvents,
    ...(shadowSummary ? { shadow: shadowSummary } : {})
  };
}

function defaultP3TracePipeline(): CourseTracePipeline {
  return new CourseTracePipeline({
    createCase: createAsmCaseFromAsm,
    prepareProgram: prepareAsmCaseMachineCode,
    runOracle: executeWithPreflight,
    runLogisimDut: runLogisimTraceCli,
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

export async function resolveLogisimCircuitInput(): Promise<vscode.Uri | undefined> {
  return await resolveWorkspaceFile({
    title: '选择 Logisim 电路模板',
    include: '**/*.circ',
    exclude: '**/{node_modules,out,.git,.co}/**',
    maxResults: 200,
    filters: {
      Logisim: ['circ'],
      All: ['*']
    },
    activeFile: isLogisimCircuitFile,
    saveActive: true
  });
}

export async function resolveLogisimRomTarget(circuitText: string): Promise<LogisimRomTarget | undefined> {
  const candidates = findLogisimRomTargets(circuitText)
    .filter((target) => target.dataWidth === undefined || target.dataWidth === 32);
  if (!candidates.length) {
    vscode.window.showErrorMessage('所选 Logisim 电路中未找到 32 位 ROM 组件');
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((target) => ({
      label: target.label ? `${target.index}: ${target.label}` : `${target.index}: ROM`,
      description: [
        target.loc ? `位置 ${target.loc}` : undefined,
        target.addrWidth ? `地址 ${target.addrWidth}` : undefined,
        target.dataWidth ? `数据 ${target.dataWidth}` : undefined,
        target.hasContents ? '有内容' : '空'
      ].filter(Boolean).join(' | '),
      target
    })),
    {
      title: '选择要注入机器码的 Logisim ROM'
    }
  );
  return picked?.target;
}

export function resolveSingleP3LogisimRomTarget(
  services: AppServices,
  circuitText: string
): LogisimRomTarget | undefined {
  const candidates = findLogisimRomTargets(circuitText)
    .filter((target) => target.dataWidth === undefined || target.dataWidth === 32);
  if (candidates.length === 1) {
    return candidates[0];
  }

  const message = candidates.length === 0
    ? 'P3 Logisim Trace 电路中未找到唯一的 32 位 ROM 组件'
    : `P3 Logisim Trace 电路应当只有一个 32 位 ROM 组件，当前找到 ${candidates.length} 个`;
  services.output.appendLine(message);
  vscode.window.showErrorMessage(message);
  return undefined;
}

export async function resolveP3LogisimTraceSetup(
  services: AppServices,
  resource: vscode.Uri,
  options: P3LogisimTraceSetupOptions = {}
): Promise<P3LogisimTraceSetup | undefined> {
  if (!await ensureP3LogisimTraceToolchainReady(services, resource, options)) {
    return undefined;
  }

  const circuit = await resolveLogisimCircuitInput();
  if (!circuit) {
    return undefined;
  }
  const circuitText = await readTextFile(circuit);
  const traceCircuit = getLogisimTraceMainCircuit(circuit) || defaultLogisimTraceCircuit;
  const traceColumns = getLogisimTraceColumns(circuit) as LogisimTraceColumnMap | undefined;
  const traceReport = analyzeP3LogisimTraceCircuit(circuitText, traceCircuit, { traceColumns });
  const traceDiagnostic = formatP3LogisimTraceDiagnostic(traceReport);
  let traceSpec: LogisimTraceSpec;
  try {
    traceSpec = traceReport.spec ?? parseLogisimTraceSpec(circuitText, traceCircuit, { traceColumns });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`P3 Logisim Trace 顶层不可用：${traceReport.errors[0] ?? message}`);
    services.output.appendLine(traceDiagnostic);
    return undefined;
  }
  if (!traceReport.spec) {
    vscode.window.showErrorMessage(`P3 Logisim Trace 顶层不可用：${traceReport.errors[0] ?? '无法解析 trace 端口'}`);
    services.output.appendLine(traceDiagnostic);
    return undefined;
  }

  const romTarget = resolveSingleP3LogisimRomTarget(services, circuitText);
  if (!romTarget) {
    return undefined;
  }

  if (!options.nonInteractive) {
    revealOutputChannel(services.output, circuit);
    services.output.appendLine('');
    services.output.appendLine('P3 Logisim Trace 设置');
    services.output.appendLine(`电路: ${circuit.fsPath}`);
    services.output.appendLine(`Trace 顶层: ${traceCircuit}`);
    services.output.appendLine(`Trace 输出列: ${traceSpec.columns.map((column) => column.logisimLabel || `(col ${column.index})`).join(', ')}`);
    services.output.appendLine(traceDiagnostic);
    services.output.appendLine(`ROM: ${romTarget.label ?? 'ROM'}${romTarget.loc ? ` ${romTarget.loc}` : ''}`);
  }

  return {
    circuit,
    circuitText,
    traceCircuit,
    traceSpec,
    traceDiagnostic,
    traceColumns,
    romTarget
  };
}

export async function runLogisimTraceCli(
  services: AppServices,
  setup: P3LogisimTraceSetup,
  circuit: vscode.Uri,
  haltPcHex: string,
  resource: vscode.Uri,
  streamOutput = true,
  signal?: AbortSignal,
  nonInteractive = false
): Promise<LogisimCliTraceRun> {
  const java = getJava(resource);
  const logisim = getLogisimJar(resource);
  const args = ['-jar', logisim, circuit.fsPath, '-tty', 'table,halt,speed'];
  const cwd = path.dirname(circuit.fsPath);
  const display = commandLine(java, args);
  const timeoutMs = nonInteractive ? automaticExternalToolTimeoutMs : getRunTimeout(resource);
  if (!nonInteractive) {
    services.output.appendLine(`$ ${display}`);
    services.output.appendLine(`cwd: ${cwd}`);
  }

  if (!nonInteractive && showCommandBeforeRun(resource)) {
    const choice = await vscode.window.showInformationMessage(`运行外部工具？\n${display}`, '运行');
    if (choice !== '运行') {
      return {
        result: {
          ok: false,
          exitCode: null,
          commandLine: display,
          cwd,
          stdout: '',
          stderr: '用户取消',
          timedOut: false
        },
        stdout: '',
        stderr: '用户取消',
        rowsSeen: 0,
        haltedByPc: false
      };
    }
  }

  let rowsSeen = 0;
  let haltedByPc = false;
  let pcError: string | undefined;
  const pcProgress = createLogisimPcProgressState();
  const run = await runProcessCore(java, args, {
    cwd,
    timeoutMs,
    commandLine: display,
    signal,
    onStdout: (text) => {
      if (streamOutput) {
        services.output.append(text);
      }
    },
    onStderr: nonInteractive ? undefined : (text) => services.output.append(text),
    onError: nonInteractive ? undefined : (error) => services.output.appendLine(error.message),
    onTimeout: nonInteractive ? undefined : () => {
      if (!haltedByPc && !pcError) {
        services.output.appendLine(`运行超时（${timeoutMs} 毫秒）`);
      }
    },
    onStdoutLine: (line, control) => {
      try {
        const progress = inspectLogisimPcProgress(line, setup.traceSpec, pcProgress, haltPcHex);
        rowsSeen = pcProgress.rowsSeen;
        if (!progress.rowSeen) {
          return;
        }
        if (progress.error) {
          pcError = progress.error;
          control.stop(progress.error);
          return;
        }
        if (!haltedByPc && progress.halted) {
          haltedByPc = true;
          control.stop('halted-by-pc');
        }
      } catch {
        // Full parser will report malformed table rows after the process exits.
      }
    },
    successPredicate: (result) => haltedByPc || (!result.stopped && !result.timedOut && !pcError && result.exitCode === 0)
  });
  if (haltedByPc && !nonInteractive) {
    services.output.appendLine(`Logisim 已到达停机 PC 0x${haltPcHex}，结束命令行仿真`);
  }
  if (pcError && !nonInteractive) {
    services.output.appendLine(pcError);
  }
  const finalStderr = pcError
    ? [run.stderr.trimEnd(), pcError].filter(Boolean).join('\n')
    : run.stderr;
  return {
    result: {
      ok: run.ok,
      exitCode: run.exitCode,
      commandLine: display,
      cwd,
      stdout: run.stdout,
      stderr: finalStderr,
      timedOut: run.timedOut && !haltedByPc,
      stopped: run.stopped,
      stopReason: run.stopReason
    },
    stdout: run.stdout,
    stderr: finalStderr,
    rowsSeen,
    haltedByPc,
    pcError
  };
}

export function p3LogisimRomCapacityError(target: LogisimRomTarget, wordCount: number): string | undefined {
  if (wordCount > p3LogisimMaxWords) {
    return `P3 Logisim 机器码共有 ${wordCount} words，超过教程 IFU ${p3LogisimMaxWords} words 容量`;
  }
  if (target.addrWidth === undefined) {
    return undefined;
  }
  const capacity = target.addrWidth >= 31 ? Number.MAX_SAFE_INTEGER : 2 ** target.addrWidth;
  if (wordCount > capacity) {
    return `所选 Logisim ROM 地址宽度为 ${target.addrWidth}，容量 ${capacity} words，小于本用例 ${wordCount} words`;
  }
  return undefined;
}

async function writeLogisimPrepareReport(
  circuit: vscode.Uri,
  target: LogisimRomTarget,
  results: LogisimPrepareCaseResult[],
  source: CourseTraceBatchSource,
  outDir: vscode.Uri
): Promise<vscode.Uri> {
  const report = vscode.Uri.file(path.join(outDir.fsPath, 'logisim-prep-report.json'));
  const data: LogisimPrepareReport = {
    generatedAt: new Date().toISOString(),
    source,
    circuitTemplate: circuit.fsPath,
    romTarget: {
      index: target.index,
      label: target.label,
      loc: target.loc,
      addrWidth: target.addrWidth,
      dataWidth: target.dataWidth
    },
    summary: logisimPrepSummary(results),
    results
  };
  await writeTextFile(report, JSON.stringify(data, null, 2) + '\n');
  return report;
}

function isLogisimCircuitFile(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && path.extname(uri.fsPath).toLowerCase() === '.circ';
}

async function ensureP3LogisimTraceToolchainReady(
  services: AppServices,
  resource: vscode.Uri,
  options: P3LogisimTraceSetupOptions = {}
): Promise<boolean> {
  if (!options.nonInteractive) {
    revealOutputChannel(services.output, resource);
  }
  services.output.appendLine('');
  services.output.appendLine(options.nonInteractive ? '正在检查自动测试工具链' : '正在检查 P3 Logisim Trace 对拍工具链');

  const engineMode = options.nonInteractive ? automaticTestEngineMode : getMipsEngine(resource);
  const memoryConfiguration = getMemoryConfiguration(resource);
  const configurationError = courseTraceMemoryConfigurationErrorForEngine('P3', engineMode, memoryConfiguration);
  if (configurationError) {
    services.output.appendLine(configurationError);
    vscode.window.showErrorMessage(configurationError);
    return false;
  }

  const checks = await checkToolchain(services.output, resource, {
    nonInteractive: options.nonInteractive,
    engineMode: options.nonInteractive ? automaticTestEngineMode : undefined
  });
  const required = requiredCourseTraceToolchainChecks('P3', engineMode, memoryConfiguration);
  const failed = requiredToolchainFailures(checks, required);
  if (!failed.length) {
    return true;
  }

  const formatter = options.nonInteractive ? formatAutomaticToolchainFailure : formatToolchainFailure;
  const message = `${options.nonInteractive ? '自动测试' : 'P3 Logisim Trace'}工具链检查失败：${failed.map(formatter).join('；')}`;
  services.output.appendLine(message);
  vscode.window.showErrorMessage(message);
  return false;
}
