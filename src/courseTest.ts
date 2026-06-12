import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getBuiltinGeneratorInstructionCount,
  getBuiltinGeneratorP7InstructionCount,
  getBuiltinGeneratorInstructions,
  getContinuousIntervalMs,
  getContinuousMaxIterations,
  getContinuousStopOnFailure,
  getGeneratedAsmLimit,
  getGeneratorArgs,
  getJava,
  getMemoryConfiguration,
  getP7ExceptionRate,
  getP7ExceptionTypes,
  getP7ExternalInterruptIntensity,
  getP7InterruptEnabled,
  getP7ProbeScenarioCount,
  getP7StressMode,
  getP7TimerIntensity,
  getP7TimerInterruptEnabled,
  getProfile,
  ensureConcreteProfile,
  P7StressMode,
  resolvePython,
  useBuiltinTestGenerator
} from './config';
import {
  BuiltinAsmGeneratorError,
  generateBuiltinAsmTestCase,
  P7ProbeMetadata
} from './courseTesting/builtinAsmGenerator';
import {
  checkP7Probe,
  P7ProbeCheckResult
} from './courseTesting/p7ProbeCheck';
import {
  continuousCounts,
  ContinuousCounts,
  ContinuousRunStatus,
  continuousStatus,
  shouldStopAfterIteration
} from './courseTesting/continuous';
import {
  buildGeneratorInvocation,
  changedAsmFiles,
  GeneratorInvocation,
  isSupportedGeneratorFile,
  snapshotAsmFiles
} from './courseTesting/generator';
import {
  logisimPrepSummary,
  LogisimPrepareCaseResult,
  preparedCircuitFileName
} from './courseTesting/logisimPrep';
import {
  compareTraces,
  firstTraceDiffSnapshot,
  TraceDiffResult,
  TraceDiffSnapshot,
  TraceEventSnapshot
} from './language/mips/traceCompare';
import { parseMarsOutput } from './language/mips/traceParser';
import { parseSimOutput } from './language/verilog/traceParser';
import { findLogisimRomTargets, injectMachineCodeIntoLogisimRom, LogisimRomTarget } from './language/logisim/rom';
import { runMarsFile } from './mips';
import { compareTracePair, defaultTraceCompareMode } from './traceCompare';
import { checkToolchain } from './toolchain';
import { runIsim } from './verilog';
import { AppServices, ProjectProfile, RunResult, ToolDetection } from './types';
import { ensureDirectory, readTextFile, workspaceFolderFor, writeTextFile } from './fsUtil';
import { revealOutputChannel, runTool } from './process';
import { pickOneFile } from './workflowInputs';
import {
  AsmCase,
  copyAsmCaseArtifact,
  createAsmCaseFromAsm,
  createAsmCaseFromText,
  listAsmCaseManifests,
  prepareAsmCaseMachineCode,
  readAsmCaseManifestForAsm,
  updateAsmCaseArtifacts
} from './asmCaseStore';
import { AsmCaseSource } from './asmCaseStoreCore';

type CourseTraceStatus = 'passed' | 'failed' | 'error';
type CourseTraceStage = 'dump' | 'mars' | 'isim' | 'compare' | 'probe';

const stdinExtensions = ['.in', '.input', '.stdin', '.dat'];
const stdinSubdirectories = ['input', 'inputs', 'test', 'tests', 'data'];

interface CourseTraceCaseResult {
  asm: string;
  stdin?: string;
  caseId?: string;
  caseManifest?: string;
  asmSnapshot?: string;
  status: CourseTraceStatus;
  stage: CourseTraceStage;
  message: string;
  machineCode?: string;
  marsOut?: string;
  simOut?: string;
  firstDiffIndex?: number;
  firstDiff?: TraceDiffSnapshot;
  marsEvents?: number;
  simEvents?: number;
  matchedEvents?: number;
  diffEvents?: number;
  probe?: P7ProbeCheckResult;
}

interface CourseTraceBatchSummary {
  total: number;
  passed: number;
  failed: number;
  errors: number;
}

interface CourseTraceBatchReport {
  generatedAt: string;
  source?: CourseTraceBatchSource;
  summary: CourseTraceBatchSummary;
  results: CourseTraceCaseResult[];
}

interface CourseTraceCaseInput {
  asm: vscode.Uri;
  stdin?: vscode.Uri;
  asmCase?: AsmCase;
}

interface CourseTraceRunOptions {
  revealOutput?: boolean;
  source?: CourseTraceBatchSource;
}

interface CourseTraceBatchSource {
  kind: 'selected' | 'generator';
  generator?: string;
  commandLine?: string;
  cwd?: string;
  asmFiles?: string[];
}

type GeneratorRunSetup = ExternalGeneratorRunSetup | BuiltinGeneratorRunSetup;

interface ExternalGeneratorRunSetup {
  kind: 'external';
  folder: vscode.WorkspaceFolder;
  generator: vscode.Uri;
  invocation: GeneratorInvocation;
}

interface BuiltinGeneratorRunSetup {
  kind: 'builtin';
  folder: vscode.WorkspaceFolder;
  resource: vscode.Uri;
  profile: ProjectProfile;
  instructionText: string;
  instructionCount: number;
  interrupt: boolean;
  p7StressMode: P7StressMode;
  timerInterrupt: boolean;
  externalInterruptIntensity: number;
  timerIntensity: number;
  probeScenarioCount: number;
  exceptionRate: number;
  exceptionTypes: string[];
}

interface GeneratedAsmBatch {
  asms: vscode.Uri[];
  source: CourseTraceBatchSource;
  asmCases?: AsmCase[];
}

interface LogisimPrepareReport {
  generatedAt: string;
  source: CourseTraceBatchSource;
  circuitTemplate: string;
  romTarget: {
    index: number;
    label?: string;
    loc?: string;
    addrWidth?: number;
    dataWidth?: number;
  };
  summary: ReturnType<typeof logisimPrepSummary>;
  results: LogisimPrepareCaseResult[];
}

interface ContinuousTraceIteration {
  index: number;
  status: ContinuousRunStatus;
  startedAt: string;
  finishedAt?: string;
  source?: CourseTraceBatchSource;
  summary: ContinuousCounts;
  results: CourseTraceCaseResult[];
  message?: string;
}

interface ContinuousTraceReport {
  generatedAt: string;
  running: boolean;
  stopRequested: boolean;
  generator: string;
  commandLine: string;
  cwd: string;
  options: {
    intervalMs: number;
    maxIterations: number;
    stopOnFailure: boolean;
  };
  iterations: ContinuousTraceIteration[];
}

interface ContinuousTraceSession {
  stopRequested: boolean;
  report: ContinuousTraceReport;
  reportFile: vscode.Uri;
  panel: vscode.WebviewPanel;
}

let activeContinuousTraceSession: ContinuousTraceSession | undefined;

export function registerCourseTest(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('co.test.runFullTest', () => runFullCourseTraceTest(services)),
    vscode.commands.registerCommand('co.test.runBatchTraceTests', () => runBatchCourseTraceTests(services)),
    vscode.commands.registerCommand('co.test.runGeneratedTraceTests', () => runGeneratedCourseTraceTests(services)),
    vscode.commands.registerCommand('co.test.startContinuousGeneratedTraceTests', () => startContinuousGeneratedTraceTests(services)),
    vscode.commands.registerCommand('co.test.generateAsmTests', () => generateAsmTests(services)),
    vscode.commands.registerCommand('co.test.generateAndDumpAsmTests', () => generateAndDumpAsmTests(services)),
    vscode.commands.registerCommand('co.test.stopContinuousTests', () => stopContinuousTests()),
    vscode.commands.registerCommand('co.test.prepareLogisimCases', () => prepareLogisimCases(services)),
    vscode.commands.registerCommand('co.test.prepareGeneratedLogisimCases', () => prepareGeneratedLogisimCases(services)),
    vscode.commands.registerCommand('co.test.openBatchTraceReport', () => openBatchTraceReport()),
    vscode.commands.registerCommand('co.test.openAsmCaseIndex', () => openAsmCaseIndex())
  );
}

async function runFullCourseTraceTest(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);

  const asm = await resolveAsmInput();
  if (!asm) {
    return;
  }

  const stdin = await resolveSingleStdinInput(asm);
  const result = await runCourseTraceCase(services, { asm, stdin });
  if (result.status === 'error') {
    vscode.window.showErrorMessage(result.message);
    return;
  }
  if (!result.marsOut || !result.simOut) {
    vscode.window.showErrorMessage('测试中止：Trace 输出未生成');
    return;
  }

  await compareTracePair(
    {
      mars: vscode.Uri.file(result.marsOut),
      sim: vscode.Uri.file(result.simOut)
    },
    services,
    defaultTraceCompareMode
  );
}

async function runBatchCourseTraceTests(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);

  const cases = await resolveBatchTraceCases();
  if (!cases.length) {
    return;
  }

  await runCourseTraceBatch(services, cases, { kind: 'selected' });
}

async function runGeneratedCourseTraceTests(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);

  const generated = await resolveGeneratedAsmBatch(services);
  if (!generated) {
    return;
  }

  await runCourseTraceBatch(services, expandTraceCases(generated.asms, generated.asmCases), generated.source);
}

async function startContinuousGeneratedTraceTests(services: AppServices): Promise<void> {
  if (activeContinuousTraceSession) {
    vscode.window.showWarningMessage('已有一个持续课程 Trace 测试会话正在运行');
    return;
  }

  await vscode.workspace.saveAll(false);
  const setup = await resolveGeneratorRunSetup();
  if (!setup) {
    return;
  }
  if (!await ensureContinuousTraceToolchainReady(services, generatorResource(setup))) {
    return;
  }

  const intervalMs = getContinuousIntervalMs(generatorResource(setup));
  const maxIterations = getContinuousMaxIterations(generatorResource(setup));
  const stopOnFailure = getContinuousStopOnFailure(generatorResource(setup));
  const outDir = vscode.Uri.file(path.join(setup.folder.uri.fsPath, '.co', 'out'));
  await ensureDirectory(outDir);
  const reportFile = vscode.Uri.file(path.join(outDir.fsPath, 'continuous-trace-report.json'));
  const panel = vscode.window.createWebviewPanel('coContinuousTraceReport', '持续测试', vscode.ViewColumn.Beside, {
    enableScripts: false,
    retainContextWhenHidden: true
  });
  const session: ContinuousTraceSession = {
    stopRequested: false,
    reportFile,
    panel,
    report: {
      generatedAt: new Date().toISOString(),
      running: true,
      stopRequested: false,
      generator: generatorLabel(setup),
      commandLine: generatorCommandLine(setup),
      cwd: generatorCwd(setup),
      options: {
        intervalMs,
        maxIterations,
        stopOnFailure
      },
      iterations: []
    }
  };
  activeContinuousTraceSession = session;
  panel.onDidDispose(() => {
    session.stopRequested = true;
  });

  services.output.appendLine('');
  services.output.appendLine('正在启动持续生成 Trace 测试');
  services.output.appendLine(`生成器: ${generatorLabel(setup)}`);
  services.output.appendLine(`间隔: ${intervalMs} 毫秒, 最大轮数: ${maxIterations || '无限制'}, 失败时停止: ${stopOnFailure}`);

  try {
    await updateContinuousTraceMonitor(session);
    let index = 0;
    while (!session.stopRequested && (maxIterations === 0 || index < maxIterations)) {
      index++;
      services.statusBar.text = `CO: Continuous #${index}`;
      const iteration: ContinuousTraceIteration = {
        index,
        status: 'running',
        startedAt: new Date().toISOString(),
        summary: continuousCounts([]),
        results: []
      };
      session.report.iterations.unshift(iteration);
      await updateContinuousTraceMonitor(session);

      services.output.appendLine('');
      services.output.appendLine(`Continuous iteration #${index}`);
      try {
        const generated = await runGeneratorAndCollectAsms(services, setup, { revealOutput: false });
        if (!generated?.asms.length) {
          iteration.status = 'error';
          iteration.message = 'Generator finished but no new or modified ASM files were detected.';
          services.output.appendLine(iteration.message);
        } else {
          iteration.source = generated.source;
          const cases = expandTraceCases(generated.asms, generated.asmCases);
          for (let i = 0; i < cases.length; i++) {
            if (session.stopRequested) {
              break;
            }
            const item = cases[i];
            services.output.appendLine(`[iteration ${index}, case ${i + 1}/${cases.length}] ${item.asm.fsPath}`);
            try {
              iteration.results.push(await runCourseTraceCase(services, item, { revealOutput: false, source: generated.source }));
            } catch (error) {
              iteration.results.push({
                asm: item.asm.fsPath,
                stdin: item.stdin?.fsPath,
                status: 'error',
                stage: 'compare',
                message: error instanceof Error ? error.message : String(error)
              });
            }
            iteration.summary = continuousCounts(iteration.results);
            iteration.status = continuousStatus(iteration.results, true, session.stopRequested);
            await updateContinuousTraceMonitor(session);
          }
          iteration.summary = continuousCounts(iteration.results);
          iteration.status = continuousStatus(iteration.results, false, session.stopRequested);
        }
      } catch (error) {
        iteration.status = 'error';
        iteration.message = error instanceof Error ? error.message : String(error);
      }

      iteration.finishedAt = new Date().toISOString();
      iteration.summary = continuousCounts(iteration.results);
      if (iteration.status === 'running') {
        iteration.status = continuousStatus(iteration.results, false, session.stopRequested);
      }
      await updateContinuousTraceMonitor(session);

      if (session.stopRequested || shouldStopAfterIteration(iteration.results, stopOnFailure) || iteration.status === 'error') {
        break;
      }
      await delay(intervalMs);
    }
  } finally {
    session.report.running = false;
    session.report.stopRequested = session.stopRequested;
    services.statusBar.text = 'CO: Continuous stopped';
    await updateContinuousTraceMonitor(session);
    if (activeContinuousTraceSession === session) {
      activeContinuousTraceSession = undefined;
    }
  }
}

function stopContinuousTests(): void {
  if (!activeContinuousTraceSession) {
    vscode.window.showInformationMessage('当前没有正在运行的持续测试');
    return;
  }
  activeContinuousTraceSession.stopRequested = true;
  activeContinuousTraceSession.report.stopRequested = true;
  vscode.window.showInformationMessage('将在当前工具运行完成后停止持续测试');
}

async function runCourseTraceBatch(
  services: AppServices,
  cases: CourseTraceCaseInput[],
  source: CourseTraceBatchSource
): Promise<void> {
  revealOutputChannel(services.output);
  services.output.appendLine('');
  const sourceLabel = source.kind === 'generator' ? '生成的课程 Trace 测试' : '批量课程 Trace 测试';
  services.output.appendLine(`${sourceLabel}: ${cases.length} 个用例`);

  const results: CourseTraceCaseResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const item = cases[i];
    const asm = item.asm;
    services.output.appendLine('');
    services.output.appendLine(`[${i + 1}/${cases.length}] ${asm.fsPath}`);
    if (item.stdin) {
      services.output.appendLine(`stdin: ${item.stdin.fsPath}`);
    }
    try {
      results.push(await runCourseTraceCase(services, item, { source }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        asm: asm.fsPath,
        stdin: item.stdin?.fsPath,
        status: 'error',
        stage: 'compare',
        message
      });
    }
  }

  const report = await writeBatchTraceReport(cases[0].asm, results, source);
  showBatchTraceReport(results, report, undefined, source);

  const summary = batchSummary(results);
  const passed = summary.passed;
  const failed = summary.failed;
  const errors = summary.errors;
  const message = `批量 Trace 测试完成: ${passed} 通过, ${failed} 失败, ${errors} 错误`;
  if (failed || errors) {
    vscode.window.showWarningMessage(message);
  } else {
    vscode.window.showInformationMessage(message);
  }
}

async function prepareLogisimCases(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);

  const asms = await resolveAsmBatchInputs();
  if (!asms.length) {
    return;
  }
  await runLogisimPrepareBatch(
    services,
    asms.map((asm) => ({ asm })),
    { kind: 'selected', asmFiles: asms.map((uri) => uri.fsPath) }
  );
}

async function prepareGeneratedLogisimCases(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);

  const generated = await resolveGeneratedAsmBatch(services);
  if (!generated) {
    return;
  }
  await runLogisimPrepareBatch(services, generatedCaseInputs(generated), generated.source);
}

async function runLogisimPrepareBatch(
  services: AppServices,
  cases: CourseTraceCaseInput[],
  source: CourseTraceBatchSource
): Promise<void> {
  const circuit = await resolveLogisimCircuitInput();
  if (!circuit) {
    return;
  }

  const circuitText = await readTextFile(circuit);
  const target = await resolveLogisimRomTarget(circuitText);
  if (!target) {
    return;
  }

  const folder = workspaceFolderFor(circuit) ?? workspaceFolderFor(cases[0]?.asm) ?? vscode.workspace.workspaceFolders?.[0];
  const baseDir = folder?.uri.fsPath ?? path.dirname(circuit.fsPath);
  const outDir = vscode.Uri.file(path.join(baseDir, '.co', 'logisim'));
  await ensureDirectory(outDir);

  revealOutputChannel(services.output, circuit);
  services.output.appendLine('');
  services.output.appendLine(`准备 Logisim 电路用例: ${cases.length} 个用例`);
  services.output.appendLine(`电路: ${circuit.fsPath}`);
  services.output.appendLine(`ROM: ${target.label ?? 'ROM'}${target.loc ? ` ${target.loc}` : ''}`);

  const results: LogisimPrepareCaseResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const item = cases[i];
    const asm = item.asm;
    services.output.appendLine('');
    services.output.appendLine(`[${i + 1}/${cases.length}] ${asm.fsPath}`);

    try {
      const asmCase = item.asmCase ?? await createAsmCaseFromAsm(asm, {
        source: asmCaseSourceFromBatchSource(source),
        resource: circuit
      });
      const dump = await prepareAsmCaseMachineCode(services, asmCase, { showMessages: false });
      if (!dump?.result.ok || !dump.outputFile) {
        results.push({
          asm: asm.fsPath,
          ...caseResultFields(asmCase),
          status: 'error',
          message: 'MARS 导出机器码失败'
        });
        continue;
      }

      const machineCodeText = await readTextFile(asmCase.machineCode);
      const injected = injectMachineCodeIntoLogisimRom(circuitText, machineCodeText, target.index);
      const outFile = vscode.Uri.file(path.join(outDir.fsPath, preparedCircuitFileName(circuit.fsPath, asm.fsPath, baseDir)));
      await writeTextFile(outFile, injected.text);
      await copyAsmCaseArtifact(asmCase, 'logisim', outFile, path.basename(outFile.fsPath), 'preparedCircuit');
      await updateAsmCaseArtifacts(asmCase, 'logisim', { circuitTemplate: circuit.fsPath });
      results.push({
        asm: asm.fsPath,
        ...caseResultFields(asmCase),
        status: 'prepared',
        message: `已注入 ${injected.wordCount} 个机器码`,
        machineCode: asmCase.machineCode.fsPath,
        circuit: outFile.fsPath,
        wordCount: injected.wordCount
      });
      services.output.appendLine(`已准备电路: ${outFile.fsPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        asm: asm.fsPath,
        status: 'error',
        message
      });
    }
  }

  const report = await writeLogisimPrepareReport(circuit, target, results, source, outDir);
  showLogisimPrepareReport(report, results, source, circuit, target);
  const summary = logisimPrepSummary(results);
  const message = `Logisim 用例准备完成: ${summary.prepared} 已准备, ${summary.errors} 错误`;
  if (summary.errors) {
    vscode.window.showWarningMessage(message);
  } else {
    vscode.window.showInformationMessage(message);
  }
}

async function openBatchTraceReport(): Promise<void> {
  const report = await resolveBatchTraceReport();
  if (!report) {
    return;
  }
  const text = await readTextFile(report);
  let parsed: CourseTraceBatchReport;
  try {
    parsed = JSON.parse(text) as CourseTraceBatchReport;
  } catch {
    vscode.window.showErrorMessage('所选批量 Trace 报告不是有效的 JSON');
    return;
  }
  if (!Array.isArray(parsed.results)) {
    vscode.window.showErrorMessage('所选批量 Trace 报告不包含 results 数组');
    return;
  }
  showBatchTraceReport(parsed.results, report, parsed.generatedAt, parsed.source);
}

async function openAsmCaseIndex(): Promise<void> {
  const manifests = await listAsmCaseManifests(vscode.window.activeTextEditor?.document.uri);
  const panel = vscode.window.createWebviewPanel('coAsmCaseIndex', 'CO ASM 用例记录', vscode.ViewColumn.Beside, {
    enableScripts: false
  });
  panel.webview.html = renderAsmCaseIndex(manifests);
}

async function runCourseTraceCase(
  services: AppServices,
  item: CourseTraceCaseInput,
  options: CourseTraceRunOptions = {}
): Promise<CourseTraceCaseResult> {
  const asm = item.asm;
  services.output.appendLine('完整课程 Trace 测试');
  services.output.appendLine(`ASM: ${asm.fsPath}`);
  if (item.stdin) {
    services.output.appendLine(`标准输入: ${item.stdin.fsPath}`);
  }

  const asmCase = item.asmCase ?? await createAsmCaseFromAsm(asm, {
    source: asmCaseSourceFromBatchSource(options.source ?? { kind: 'selected', asmFiles: [asm.fsPath] }),
    stdin: item.stdin,
    resource: asm,
    p7: p7MetadataFromSidecar(asm)
  });
  services.output.appendLine(`ASM case: ${asmCase.manifestUri.fsPath}`);

  const dump = await prepareAsmCaseMachineCode(services, asmCase, {
    showMessages: false,
    revealOutput: options.revealOutput,
    courseTrace: true
  });
  if (!dump?.result.ok || !dump.outputFile) {
    return failedCase(item, 'dump', marsStageFailureMessage('测试中止：MARS 导出机器码失败', dump?.result), undefined, undefined, asmCase);
  }
  services.output.appendLine(`机器码: ${asmCase.machineCode.fsPath}`);

  const interruptSchedule = resolveCaseInterruptScheduleFromCase(asmCase) ?? resolveCaseInterruptSchedule(asm);
  if (interruptSchedule) {
    services.output.appendLine(`外部中断目标 PC: ${interruptSchedule.map((pc) => `0x${(pc >>> 0).toString(16)}`).join(', ')}`);
  }
  const probe = resolveCaseProbeMetadataFromCase(asmCase) ?? resolveCaseProbeMetadata(asm);
  if (probe) {
    services.output.appendLine(`P7 Probe 场景: ${probe.scenarios.map((scenario) => `${scenario.id}:${scenario.kind}`).join(', ')}`);
    const isim = await runIsim(services, {
      resource: asm,
      showMessages: false,
      revealOutput: options.revealOutput,
      asmCase,
      simOutputFileName: simOutputFileNameForCase(item),
      p7Probe: probe
    });
    if (!isim?.simResult.ok || !isim.simOut) {
      return failedCase(item, 'isim', '测试中止：ISim 运行失败', asmCase.machineCode, undefined, asmCase);
    }
    const simText = await readTextFile(isim.simOut);
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
      simOut: isim.simOut.fsPath,
      simEvents: simEvents.length,
      probe: probeResult
    };
  }

  const stdinText = item.stdin ? await readTextFile(item.stdin) : undefined;
  const mars = await runMarsFile(services, asmCase.sourceAsm, 'run', {
    showMessages: false,
    revealOutput: options.revealOutput,
    stdin: stdinText,
    stdinSource: item.stdin,
    traceOutput: true,
    interruptSchedule
  });
  if (!mars?.result.ok || !mars.outputFile) {
    return failedCase(item, 'mars', marsStageFailureMessage('测试中止：MARS 黄金模型运行失败', mars?.result), asmCase.machineCode, undefined, asmCase);
  }
  await copyAsmCaseArtifact(asmCase, 'mars', mars.outputFile, path.basename(mars.outputFile.fsPath), 'traceOut');

  const isim = await runIsim(services, {
    resource: asm,
    showMessages: false,
    revealOutput: options.revealOutput,
    asmCase,
    simOutputFileName: simOutputFileNameForCase(item),
    interruptSchedule
  });
  if (!isim?.simResult.ok || !isim.simOut) {
    return failedCase(item, 'isim', '测试中止：ISim 运行失败', asmCase.machineCode, mars.outputFile, asmCase);
  }

  const marsText = await readTextFile(mars.outputFile);
  const simText = await readTextFile(isim.simOut);
  const marsEvents = parseMarsOutput(marsText);
  const simEvents = parseSimOutput(simText);
  const diff = compareTraces(marsEvents, simEvents, { compareCycles: defaultTraceCompareMode.compareCycles });

  if (!marsEvents.length || !simEvents.length) {
    return {
      asm: asm.fsPath,
      stdin: item.stdin?.fsPath,
      ...caseResultFields(asmCase),
      status: 'error',
      stage: 'compare',
      message: '某一端没有可解析的 Trace 事件',
      machineCode: asmCase.machineCode.fsPath,
      marsOut: mars.outputFile.fsPath,
      simOut: isim.simOut.fsPath,
      marsEvents: marsEvents.length,
      simEvents: simEvents.length,
      matchedEvents: diff.summary.matchedEvents,
      diffEvents: diff.summary.diffEvents
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
    marsOut: mars.outputFile.fsPath,
    simOut: isim.simOut.fsPath,
    firstDiffIndex: diff.firstDiffIndex >= 0 ? diff.firstDiffIndex : undefined,
    firstDiff: firstTraceDiffSnapshot(diff),
    marsEvents: diff.summary.marsEvents,
    simEvents: diff.summary.simEvents,
    matchedEvents: diff.summary.matchedEvents,
    diffEvents: diff.summary.diffEvents
  };
}

async function resolveAsmInput(): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file' && isAsmFile(editor.document.uri)) {
    if (editor.document.isDirty) {
      await editor.document.save();
    }
    return editor.document.uri;
  }

  const files = await vscode.workspace.findFiles('**/*.{asm,s,mips}', '**/{node_modules,out,.git}/**', 200);
  if (files.length === 1) {
    return files[0];
  }
  if (files.length > 1) {
    const picked = await vscode.window.showQuickPick(
      files.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        description: path.dirname(uri.fsPath),
        uri
      })),
      {
        title: '选择课程 Trace 测试的 MIPS ASM 文件',
        matchOnDescription: true
      }
    );
    return picked?.uri;
  }

  return await pickOneFile('选择课程 Trace 测试的 MIPS ASM 文件', {
    ASM: ['asm', 's', 'mips'],
    All: ['*']
  });
}

async function resolveAsmBatchInputs(): Promise<vscode.Uri[]> {
  const files = await vscode.workspace.findFiles('**/*.{asm,s,mips}', '**/{node_modules,out,.git}/**', 500);
  if (files.length) {
    const picked = await vscode.window.showQuickPick(
      files.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        description: path.dirname(uri.fsPath),
        uri
      })),
      {
        title: '选择批量 Trace 测试的 MIPS ASM 文件',
        matchOnDescription: true,
        canPickMany: true
      }
    );
    return picked?.map((item) => item.uri) ?? [];
  }

  const picked = await vscode.window.showOpenDialog({
    title: '选择批量 Trace 测试的 MIPS ASM 文件',
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    filters: {
      ASM: ['asm', 's', 'mips'],
      All: ['*']
    }
  });
  return picked ?? [];
}

async function resolveSingleStdinInput(asm: vscode.Uri): Promise<vscode.Uri | undefined> {
  const candidates = findStdinCandidatesForAsm(asm);
  if (!candidates.length) {
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: '无标准输入',
        description: '不使用标准输入运行',
        uri: undefined
      },
      ...candidates.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        description: path.dirname(uri.fsPath),
        uri
      }))
    ],
    {
      title: '为此 ASM 用例选择标准输入文件',
      matchOnDescription: true
    }
  );
  return picked?.uri;
}

async function resolveBatchTraceCases(): Promise<CourseTraceCaseInput[]> {
  const asms = await resolveAsmBatchInputs();
  return expandTraceCases(asms);
}

async function resolveGeneratedAsmBatch(services: AppServices): Promise<GeneratedAsmBatch | undefined> {
  const setup = await resolveGeneratorRunSetup();
  if (!setup) {
    return undefined;
  }
  const generated = await runGeneratorAndCollectAsms(services, setup);
  if (generated) {
    return generated;
  }

  const choice = await vscode.window.showWarningMessage(
    '生成器已完成，但未检测到新建或修改的 ASM 文件',
    '手动选择 ASM 文件'
  );
  if (choice !== '手动选择 ASM 文件') {
    return undefined;
  }
  const picked = await resolveAsmBatchInputs();
  if (!picked.length) {
    return undefined;
  }
  return {
    asms: picked,
    source: generatorSource(setup, picked)
  };
}

async function resolveGeneratorRunSetup(): Promise<GeneratorRunSetup | undefined> {
  const folder = workspaceFolderFor(vscode.window.activeTextEditor?.document.uri) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage('运行测试生成器前请先打开一个工作区文件夹');
    return undefined;
  }

  const activeExternal = await resolveActiveGeneratorInput();
  if (activeExternal) {
    return await buildExternalGeneratorRunSetup(folder, activeExternal);
  }

  const resource = vscode.window.activeTextEditor?.document.uri ?? folder.uri;
  const profile = await ensureConcreteProfile(resource, '运行测试生成器需要先确定项目 Profile');
  if (!profile) {
    return undefined;
  }
  if (useBuiltinTestGenerator(resource)) {
    return {
      kind: 'builtin',
      folder,
      resource,
      profile,
      instructionText: getBuiltinGeneratorInstructions(resource),
      instructionCount: profile === 'P7'
        ? getBuiltinGeneratorP7InstructionCount(resource)
        : getBuiltinGeneratorInstructionCount(resource),
      interrupt: profile === 'P7' && getP7InterruptEnabled(resource),
      p7StressMode: profile === 'P7' ? getP7StressMode(resource) : 'off',
      timerInterrupt: profile === 'P7' && getP7TimerInterruptEnabled(resource),
      externalInterruptIntensity: profile === 'P7' ? getP7ExternalInterruptIntensity(resource) : 0,
      timerIntensity: profile === 'P7' ? getP7TimerIntensity(resource) : 0,
      probeScenarioCount: profile === 'P7' ? getP7ProbeScenarioCount(resource) : 0,
      exceptionRate: profile === 'P7' ? getP7ExceptionRate(resource) : 0,
      exceptionTypes: profile === 'P7' ? getP7ExceptionTypes(resource) : []
    };
  }

  const generator = await resolveGeneratorInput(folder);
  if (!generator) {
    return undefined;
  }

  return await buildExternalGeneratorRunSetup(folder, generator);
}

async function buildExternalGeneratorRunSetup(
  folder: vscode.WorkspaceFolder,
  generator: vscode.Uri
): Promise<GeneratorRunSetup | undefined> {
  const invocation = buildGeneratorInvocation(generator.fsPath, {
    python: await resolvePython(generator),
    java: getJava(generator),
    cwd: path.dirname(generator.fsPath),
    extraArgs: getGeneratorArgs(generator)
  });
  if (!invocation) {
    vscode.window.showErrorMessage(`不支持的测试生成器类型: ${path.extname(generator.fsPath) || '(无扩展名)'}`);
    return undefined;
  }

  return { kind: 'external', folder, generator, invocation };
}

async function runGeneratorAndCollectAsms(
  services: AppServices,
  setup: GeneratorRunSetup,
  options: CourseTraceRunOptions = {}
): Promise<GeneratedAsmBatch | undefined> {
  if (setup.kind === 'builtin') {
    return await runBuiltinGeneratorAndCollectAsms(services, setup, options);
  }

  const before = snapshotAsmFiles(setup.folder.uri.fsPath);
  if (options.revealOutput !== false) {
    revealOutputChannel(services.output, setup.generator);
  }
  services.output.appendLine('');
  services.output.appendLine(`正在运行测试生成器: ${setup.generator.fsPath}`);
  const result = await runTool(setup.invocation.command, setup.invocation.args, {
    cwd: setup.invocation.cwd,
    output: services.output,
    resource: setup.generator
  });
  if (!result.ok) {
    vscode.window.showErrorMessage('测试生成器运行失败。请查看插件输出面板');
    return undefined;
  }

  const after = snapshotAsmFiles(setup.folder.uri.fsPath);
  const generated = changedAsmFiles(before, after, getGeneratedAsmLimit(setup.generator)).map((file) => vscode.Uri.file(file));
  const source: CourseTraceBatchSource = generatorSource(setup, generated, result.commandLine, result.cwd);
  if (generated.length) {
    return { asms: generated, source };
  }
  return undefined;
}

async function runBuiltinGeneratorAndCollectAsms(
  services: AppServices,
  setup: BuiltinGeneratorRunSetup,
  options: CourseTraceRunOptions = {}
): Promise<GeneratedAsmBatch | undefined> {
  const generatedAt = new Date();
  const modes: Array<P7StressMode | undefined> = setup.profile === 'P7'
    ? (setup.p7StressMode === 'hybrid' ? ['anchor', 'probe'] : [setup.p7StressMode])
    : [undefined];
  const asms: vscode.Uri[] = [];
  const asmCases: AsmCase[] = [];
  const generatedCases: ReturnType<typeof generateBuiltinAsmTestCase>[] = [];
  try {
    for (const mode of modes) {
      const generated = generateBuiltinAsmTestCase({
        profile: setup.profile,
        instructionText: setup.instructionText,
        instructionCount: setup.instructionCount,
        generatedAt,
        interrupt: setup.interrupt && mode !== 'off',
        p7StressMode: mode,
        timerInterrupt: mode === 'probe' && setup.timerInterrupt,
        externalInterruptIntensity: setup.externalInterruptIntensity,
        timerIntensity: setup.timerIntensity,
        probeScenarioCount: setup.probeScenarioCount,
        exceptionRate: mode === 'probe' ? 0 : setup.exceptionRate,
          exceptionTypes: setup.exceptionTypes
      });
      const fileName = builtinAsmFileName(generated.profile, generatedAt, generated.mode);
      const asmCase = await createAsmCaseFromText(fileName, generated.text, {
        resource: setup.resource,
        source: {
          kind: 'builtin',
          generator: 'builtin:random-asm',
          commandLine: generatorCommandLine(setup),
          cwd: generatorCwd(setup)
        },
        createdAt: generatedAt,
        p7: {
          interruptSchedule: generated.interruptSchedule,
          probe: generated.probe
        }
      });
      await updateAsmCaseArtifacts(asmCase, 'source', {
        generatedName: fileName,
        seed: generated.seed,
        mode: generated.mode ?? mode ?? 'default'
      });
      asms.push(asmCase.sourceAsm);
      asmCases.push(asmCase);
      generatedCases.push(generated);
    }
  } catch (error) {
    const message = error instanceof BuiltinAsmGeneratorError || error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(message);
    if (options.revealOutput !== false) {
      revealOutputChannel(services.output, setup.folder.uri);
    }
    services.output.appendLine('');
    services.output.appendLine(`内置 ASM 生成器失败: ${message}`);
    return undefined;
  }

  if (options.revealOutput !== false) {
    revealOutputChannel(services.output, setup.folder.uri);
  }
  services.output.appendLine('');
  services.output.appendLine('正在运行内置随机 ASM 生成器');
  services.output.appendLine(`Profile: ${setup.profile}`);
  services.output.appendLine(`模式: ${modes.map((mode) => mode ?? 'default').join(', ')}`);
  for (let i = 0; i < generatedCases.length; i++) {
    const generated = generatedCases[i];
    services.output.appendLine(`指令数量: ${generated.instructionCount}`);
    services.output.appendLine(`指令集: ${generated.instructionSet.join(' ')}`);
    services.output.appendLine(`种子: ${generated.seed}`);
    if (generated.interruptSchedule.length) {
      services.output.appendLine(`外部中断目标 PC: ${generated.interruptSchedule.map((pc) => `0x${(pc >>> 0).toString(16)}`).join(', ')}`);
    }
    if (generated.probe) {
      services.output.appendLine(`Probe 场景: ${generated.probe.scenarios.map((scenario) => `${scenario.id}:${scenario.kind}`).join(', ')}`);
    }
    services.output.appendLine(`ASM: ${asms[i].fsPath}`);
  }

  return {
    asms,
    source: generatorSource(setup, asms),
    asmCases
  };
}

function expandTraceCases(asms: vscode.Uri[], asmCases?: AsmCase[]): CourseTraceCaseInput[] {
  const caseByAsm = new Map((asmCases ?? []).map((asmCase) => [normalizePathKey(asmCase.sourceAsm.fsPath), asmCase]));
  const cases: CourseTraceCaseInput[] = [];
  for (const asm of asms) {
    const asmCase = caseByAsm.get(normalizePathKey(asm.fsPath));
    const stdinFiles = findStdinCandidatesForAsm(asm);
    if (!stdinFiles.length) {
      cases.push({ asm, asmCase });
      continue;
    }
    for (const stdin of stdinFiles) {
      cases.push({ asm, stdin, asmCase });
    }
  }
  return cases;
}

function simOutputFileNameForCase(item: CourseTraceCaseInput): string {
  return `${traceOutputStem(item)}.sim.out`;
}

function traceOutputStem(item: CourseTraceCaseInput): string {
  const asmName = path.basename(item.asm.fsPath, path.extname(item.asm.fsPath));
  if (!item.stdin) {
    return asmName;
  }
  const stdinName = path.basename(item.stdin.fsPath, path.extname(item.stdin.fsPath));
  return `${asmName}.${sanitizeTraceFileStem(stdinName)}`;
}

function sanitizeTraceFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_') || 'stdin';
}

function normalizePathKey(file: string): string {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function resolveActiveGeneratorInput(): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file' && isSupportedGeneratorFile(editor.document.uri.fsPath)) {
    if (editor.document.isDirty) {
      await editor.document.save();
    }
    return editor.document.uri;
  }
  return undefined;
}

function generatorResource(setup: GeneratorRunSetup): vscode.Uri {
  return setup.kind === 'external' ? setup.generator : setup.resource;
}

function generatorLabel(setup: GeneratorRunSetup): string {
  return setup.kind === 'external' ? setup.generator.fsPath : 'builtin:random-asm';
}

function generatorCommandLine(setup: GeneratorRunSetup): string {
  if (setup.kind === 'external') {
    return [setup.invocation.command, ...setup.invocation.args].join(' ');
  }
  const instructionArg = setup.instructionText.trim() ? ` --instructions "${setup.instructionText.trim()}"` : ' --instructions <profile-default>';
  return `builtin-random-asm --profile ${setup.profile} --count ${setup.instructionCount}${instructionArg}`;
}

function generatorCwd(setup: GeneratorRunSetup): string {
  return setup.kind === 'external' ? setup.invocation.cwd : path.join(setup.folder.uri.fsPath, '.co', 'cases');
}

function generatorSource(
  setup: GeneratorRunSetup,
  asms: vscode.Uri[],
  commandLine = generatorCommandLine(setup),
  cwd = generatorCwd(setup)
): CourseTraceBatchSource {
  return {
    kind: 'generator',
    generator: generatorLabel(setup),
    commandLine,
    cwd,
    asmFiles: asms.map((uri) => uri.fsPath)
  };
}

function builtinAsmFileName(profile: string, generatedAt: Date, mode?: string): string {
  const timestamp = generatedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  const modePart = mode ? `-${mode}` : '';
  return `builtin-${profile.toLowerCase()}${modePart}-${timestamp}-${suffix}.asm`;
}

async function resolveGeneratorInput(folder: vscode.WorkspaceFolder): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file' && isSupportedGeneratorFile(editor.document.uri.fsPath)) {
    if (editor.document.isDirty) {
      await editor.document.save();
    }
    return editor.document.uri;
  }

  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/*.{py,js,mjs,cjs,jar,bat,cmd,exe,ps1}'),
    '**/{node_modules,out,.git,.co}/**',
    200
  );
  if (files.length === 1) {
    return files[0];
  }
  if (files.length > 1) {
    const picked = await vscode.window.showQuickPick(
      files.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        description: path.dirname(uri.fsPath),
        uri
      })),
      {
        title: '选择随机测试生成器',
        matchOnDescription: true
      }
    );
    return picked?.uri;
  }

  return await pickOneFile('选择随机测试生成器', {
    Generator: ['py', 'js', 'mjs', 'cjs', 'jar', 'bat', 'cmd', 'exe', 'ps1'],
    All: ['*']
  });
}

async function resolveLogisimCircuitInput(): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && isLogisimCircuitFile(editor.document.uri)) {
    if (editor.document.isDirty) {
      await editor.document.save();
    }
    return editor.document.uri;
  }

  const files = await vscode.workspace.findFiles('**/*.circ', '**/{node_modules,out,.git,.co}/**', 200);
  if (files.length === 1) {
    return files[0];
  }
  if (files.length > 1) {
    const picked = await vscode.window.showQuickPick(
      files.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        description: path.dirname(uri.fsPath),
        uri
      })),
      {
        title: '选择 Logisim 电路模板',
        matchOnDescription: true
      }
    );
    return picked?.uri;
  }

  return await pickOneFile('选择 Logisim 电路模板', {
    Logisim: ['circ'],
    All: ['*']
  });
}

function isLogisimCircuitFile(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && path.extname(uri.fsPath).toLowerCase() === '.circ';
}

async function resolveLogisimRomTarget(circuitText: string): Promise<LogisimRomTarget | undefined> {
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

function findStdinCandidatesForAsm(asm: vscode.Uri): vscode.Uri[] {
  const asmDir = path.dirname(asm.fsPath);
  const asmStem = path.basename(asm.fsPath, path.extname(asm.fsPath)).toLowerCase();
  const candidates: { file: string; rank: number }[] = [];

  for (const directory of stdinSearchDirectories(asmDir)) {
    for (const entry of safeReadDirectory(directory.path)) {
      if (!entry.isFile()) {
        continue;
      }
      const rank = stdinNameRank(entry.name, asmStem);
      if (rank < 0) {
        continue;
      }
      candidates.push({
        file: path.join(directory.path, entry.name),
        rank: directory.rank + rank
      });
    }
  }

  const seen = new Set<string>();
  return candidates
    .sort((left, right) => left.rank - right.rank || left.file.localeCompare(right.file))
    .filter((item) => {
      const normalized = path.normalize(item.file).toLowerCase();
      if (seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    })
    .map((item) => vscode.Uri.file(item.file));
}

function stdinSearchDirectories(asmDir: string): Array<{ path: string; rank: number }> {
  const directories = [{ path: asmDir, rank: 0 }];
  for (let i = 0; i < stdinSubdirectories.length; i++) {
    const candidate = path.join(asmDir, stdinSubdirectories[i]);
    if (safeIsDirectory(candidate)) {
      directories.push({ path: candidate, rank: (i + 1) * 100 });
    }
  }
  return directories;
}

function stdinNameRank(fileName: string, asmStem: string): number {
  const extension = path.extname(fileName).toLowerCase();
  const extensionRank = stdinExtensions.indexOf(extension);
  if (extensionRank < 0) {
    return -1;
  }

  const stem = path.basename(fileName, path.extname(fileName)).toLowerCase();
  if (stem === asmStem) {
    return extensionRank;
  }
  if (stem.startsWith(`${asmStem}.`)) {
    return 10 + extensionRank;
  }
  if (stem.startsWith(`${asmStem}-`)) {
    return 20 + extensionRank;
  }
  if (stem.startsWith(`${asmStem}_`)) {
    return 30 + extensionRank;
  }
  return -1;
}

function safeReadDirectory(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeIsDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function failedCase(
  item: CourseTraceCaseInput,
  stage: CourseTraceStage,
  message: string,
  machineCode?: vscode.Uri,
  marsOut?: vscode.Uri,
  asmCase?: AsmCase
): CourseTraceCaseResult {
  return {
    asm: item.asm.fsPath,
    stdin: item.stdin?.fsPath,
    ...(asmCase ? caseResultFields(asmCase) : {}),
    status: 'error',
    stage,
    message,
    machineCode: machineCode?.fsPath,
    marsOut: marsOut?.fsPath
  };
}

function asmCaseSourceFromBatchSource(source: CourseTraceBatchSource): AsmCaseSource {
  if (source.kind === 'generator') {
    return {
      kind: source.generator === 'builtin:random-asm' ? 'builtin' : 'generator',
      generator: source.generator,
      commandLine: source.commandLine,
      cwd: source.cwd
    };
  }
  return { kind: 'selected' };
}

function caseResultFields(asmCase: AsmCase): Pick<CourseTraceCaseResult, 'caseId' | 'caseManifest' | 'asmSnapshot'> {
  return {
    caseId: asmCase.id,
    caseManifest: asmCase.manifestUri.fsPath,
    asmSnapshot: asmCase.asm.fsPath
  };
}

function generatedCaseInputs(generated: GeneratedAsmBatch): CourseTraceCaseInput[] {
  if (generated.asmCases?.length) {
    return generated.asmCases.map((asmCase) => ({
      asm: asmCase.sourceAsm,
      asmCase
    }));
  }
  return generated.asms.map((asm) => ({ asm }));
}

function resolveCaseInterruptScheduleFromCase(asmCase: AsmCase): number[] | undefined {
  const schedule = asmCase.manifest.p7?.interruptSchedule;
  return Array.isArray(schedule) && schedule.length ? schedule : undefined;
}

function resolveCaseProbeMetadataFromCase(asmCase: AsmCase): P7ProbeMetadata | undefined {
  const probe = asmCase.manifest.p7?.probe;
  return isProbeMetadata(probe) ? probe : undefined;
}

function p7MetadataFromSidecar(asm: vscode.Uri): { interruptSchedule?: number[]; probe?: P7ProbeMetadata } | undefined {
  const data = readCaseMetadata(asm);
  const interruptSchedule = Array.isArray(data.interruptSchedule)
    ? data.interruptSchedule.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : undefined;
  const probe = isProbeMetadata(data.probe) ? data.probe : undefined;
  return interruptSchedule?.length || probe ? { interruptSchedule, probe } : undefined;
}

async function generateAsmTests(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);
  const setup = await resolveGeneratorRunSetup();
  if (!setup) {
    return;
  }
  const generated = await runGeneratorAndCollectAsms(services, setup);
  if (!generated?.asms.length) {
    vscode.window.showWarningMessage('测试生成器未产生新的 ASM 测试点');
    return;
  }
  await vscode.window.showTextDocument(generated.asms[0], { preview: false });
  vscode.window.showInformationMessage(`已生成 ${generated.asms.length} 个 ASM 测试点`);
}

async function generateAndDumpAsmTests(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);
  const setup = await resolveGeneratorRunSetup();
  if (!setup) {
    return;
  }
  const generated = await runGeneratorAndCollectAsms(services, setup);
  if (!generated?.asms.length) {
    vscode.window.showWarningMessage('测试生成器未产生新的 ASM 测试点');
    return;
  }

  let dumped = 0;
  for (const item of generatedCaseInputs(generated)) {
    const asmCase = item.asmCase ?? await createAsmCaseFromAsm(item.asm, {
      source: asmCaseSourceFromBatchSource(generated.source),
      resource: item.asm,
      p7: p7MetadataFromSidecar(item.asm)
    });
    const dump = await prepareAsmCaseMachineCode(services, asmCase, { showMessages: false });
    if (!dump?.result.ok || !dump.outputFile) {
      const detail = marsStageFailureMessage('MARS 导出机器码失败', dump?.result);
      vscode.window.showErrorMessage(detail);
      return;
    }
    dumped++;
    services.output.appendLine(`机器码: ${asmCase.machineCode.fsPath}`);
  }
  await vscode.window.showTextDocument(generated.asms[0], { preview: false });
  vscode.window.showInformationMessage(`已生成 ${generated.asms.length} 个 ASM 测试点，并 dump ${dumped} 个机器码文件`);
}

function interruptScheduleSidecarUri(asm: vscode.Uri): vscode.Uri {
  const dir = path.dirname(asm.fsPath);
  const stem = path.basename(asm.fsPath, path.extname(asm.fsPath));
  return vscode.Uri.file(path.join(dir, `${stem}.co-meta.json`));
}

interface CourseCaseMetadata {
  profile?: string;
  seed?: string;
  mode?: string;
  interruptSchedule?: number[];
  probe?: P7ProbeMetadata;
}

function readCaseMetadata(asm: vscode.Uri): CourseCaseMetadata {
  const manifest = readAsmCaseManifestForAsm(asm);
  if (manifest?.p7) {
    return {
      profile: manifest.profile,
      interruptSchedule: manifest.p7.interruptSchedule,
      probe: isProbeMetadata(manifest.p7.probe) ? manifest.p7.probe : undefined
    };
  }
  try {
    const uri = interruptScheduleSidecarUri(asm);
    if (!fs.existsSync(uri.fsPath)) {
      return {};
    }
    const data = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8')) as CourseCaseMetadata;
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function readInterruptScheduleSidecar(asm: vscode.Uri): number[] {
  const data = readCaseMetadata(asm);
  if (!Array.isArray(data.interruptSchedule)) {
    return [];
  }
  return data.interruptSchedule.map((value) => Number(value)).filter((value) => Number.isFinite(value));
}

function resolveCaseProbeMetadata(asm: vscode.Uri): P7ProbeMetadata | undefined {
  if (getProfile(asm) !== 'P7') {
    return undefined;
  }
  const data = readCaseMetadata(asm);
  return data.mode === 'probe' && isProbeMetadata(data.probe) ? data.probe : undefined;
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

/**
 * P7 external-interrupt target PCs for a case (from the generator sidecar), or undefined when the
 * case is not P7, interrupts are disabled, or no schedule was recorded.
 */
function resolveCaseInterruptSchedule(asm: vscode.Uri): number[] | undefined {
  if (getProfile(asm) !== 'P7' || !getP7InterruptEnabled(asm)) {
    return undefined;
  }
  const schedule = readInterruptScheduleSidecar(asm);
  return schedule.length ? schedule : undefined;
}

async function ensureContinuousTraceToolchainReady(services: AppServices, resource: vscode.Uri): Promise<boolean> {
  revealOutputChannel(services.output, resource);
  services.output.appendLine('');
  services.output.appendLine('正在检查持续生成 Trace 测试工具链');

  const profile = await ensureConcreteProfile(resource, '持续生成 Trace 测试需要先确定项目 Profile');
  if (!profile) {
    return false;
  }
  const memoryConfiguration = getMemoryConfiguration(resource);
  const configurationError = courseTraceMemoryConfigurationError(profile, memoryConfiguration);
  if (configurationError) {
    services.output.appendLine(configurationError);
    vscode.window.showErrorMessage(configurationError);
    return false;
  }

  const checks = await checkToolchain(services.output, resource);
  const required = requiredContinuousTraceChecks(profile, memoryConfiguration);
  const failed = checks.filter((check) => required.has(check.name) && !check.ok);
  if (!failed.length) {
    return true;
  }

  const message = `持续生成测试工具链检查失败：${failed.map(formatToolchainFailure).join('；')}`;
  services.output.appendLine(message);
  vscode.window.showErrorMessage(message);
  return false;
}

function courseTraceMemoryConfigurationError(profile: ProjectProfile, memoryConfiguration: string): string | undefined {
  if (profile === 'P7') {
    return memoryConfiguration === 'CompactLargeText'
      ? undefined
      : `P7 持续生成测试必须使用 CompactLargeText，当前为 ${memoryConfiguration}`;
  }
  return memoryConfiguration === 'FixedCompactLargeText' || memoryConfiguration === 'CompactLargeText'
    ? undefined
    : `非 P7 持续生成测试应使用 FixedCompactLargeText 或 CompactLargeText，当前为 ${memoryConfiguration}`;
}

function requiredContinuousTraceChecks(profile: ProjectProfile, memoryConfiguration: string): Set<string> {
  const names = new Set(['Java', 'MARS', 'MARS coL1', 'ISE fuse']);
  if (profile !== 'P7') {
    names.add(`MARS ${memoryConfiguration}`);
  }
  return names;
}

function formatToolchainFailure(check: ToolDetection): string {
  return `${check.name} ${check.detail}${check.suggestion ? `（${check.suggestion}）` : ''}`;
}

function marsStageFailureMessage(prefix: string, result?: RunResult): string {
  const detail = firstNonEmptyLine(result?.stderr) ?? firstNonEmptyLine(result?.stdout);
  return detail ? `${prefix}: ${detail}` : prefix;
}

function firstNonEmptyLine(text?: string): string | undefined {
  return text?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function diffMessage(diff: TraceDiffResult): string {
  if (diff.matched) {
    return `${diff.summary.matchedEvents} events matched.`;
  }
  const first = diff.entries[diff.firstDiffIndex];
  return `First difference at event #${diff.firstDiffIndex + 1}: ${first.reason ?? first.status}.`;
}

async function writeBatchTraceReport(
  firstAsm: vscode.Uri,
  results: CourseTraceCaseResult[],
  source: CourseTraceBatchSource
): Promise<vscode.Uri> {
  const folder = workspaceFolderFor(firstAsm) ?? vscode.workspace.workspaceFolders?.[0];
  const baseDir = folder?.uri.fsPath ?? path.dirname(firstAsm.fsPath);
  const outDir = vscode.Uri.file(path.join(baseDir, '.co', 'out'));
  await ensureDirectory(outDir);
  const report = vscode.Uri.file(path.join(outDir.fsPath, 'trace-batch-report.json'));
  await writeTextFile(report, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source,
    summary: batchSummary(results),
    results
  }, null, 2) + '\n');
  return report;
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

async function updateContinuousTraceMonitor(session: ContinuousTraceSession): Promise<void> {
  session.report.stopRequested = session.stopRequested;
  session.report.generatedAt = new Date().toISOString();
  await writeTextFile(session.reportFile, JSON.stringify(session.report, null, 2) + '\n');
  try {
    session.panel.webview.html = renderContinuousTraceMonitor(session.report, session.reportFile);
  } catch {
    session.stopRequested = true;
  }
}

async function resolveBatchTraceReport(): Promise<vscode.Uri | undefined> {
  const folder = workspaceFolderFor(vscode.window.activeTextEditor?.document.uri) ?? vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const matches = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/.co/out/trace-batch-report.json'),
      undefined,
      20
    );
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      const picked = await vscode.window.showQuickPick(
        matches.map((uri) => ({
          label: vscode.workspace.asRelativePath(uri),
          description: path.dirname(uri.fsPath),
          uri
        })),
        {
          title: '选择批量 Trace 报告',
          matchOnDescription: true
        }
      );
      return picked?.uri;
    }
  }
  return await pickOneFile('选择批量 Trace 报告 JSON', {
    JSON: ['json'],
    All: ['*']
  });
}

function renderContinuousTraceMonitor(report: ContinuousTraceReport, reportFile: vscode.Uri): string {
  const latest = report.iterations[0];
  const latestSummary = latest?.summary ?? continuousCounts([]);
  const rows = report.iterations.map((iteration) => {
    const firstProblem = iteration.results.find((item) => item.status !== 'passed');
    return `<tr class="${iteration.status}">
      <td>${iteration.index}</td>
      <td>${iteration.status.toUpperCase()}</td>
      <td>${escapeHtml(iteration.startedAt)}</td>
      <td>${iteration.finishedAt ? escapeHtml(iteration.finishedAt) : ''}</td>
      <td>${iteration.summary.total}</td>
      <td>${iteration.summary.passed}</td>
      <td>${iteration.summary.failed}</td>
      <td>${iteration.summary.errors}</td>
      <td>${firstProblem ? escapeHtml(path.basename(firstProblem.asm)) : ''}</td>
      <td>${firstProblem ? escapeHtml(firstProblem.message) : escapeHtml(iteration.message ?? '')}</td>
    </tr>`;
  }).join('\n');
  const state = report.running ? (report.stopRequested ? '正在停止' : '运行中') : '已停止';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h1 {
      font-size: 22px;
      margin: 0 0 16px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }
    .metric {
      border: 1px solid var(--vscode-panel-border);
      padding: 10px;
    }
    .metric strong {
      display: block;
      font-size: 18px;
    }
    .paths {
      margin: 0 0 16px;
      color: var(--vscode-descriptionForeground);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 7px;
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
    }
    .passed td:nth-child(2) {
      color: var(--vscode-testing-iconPassed);
      font-weight: 600;
    }
    .failed td:nth-child(2), .error td:nth-child(2) {
      color: var(--vscode-testing-iconFailed);
      font-weight: 600;
    }
    .running td:nth-child(2), .stopped td:nth-child(2) {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <h1>持续测试</h1>
  <div class="summary">
    <div class="metric"><span>状态</span><strong>${escapeHtml(state)}</strong></div>
    <div class="metric"><span>轮数</span><strong>${report.iterations.length}</strong></div>
    <div class="metric"><span>最近通过</span><strong>${latestSummary.passed}</strong></div>
    <div class="metric"><span>最近失败</span><strong>${latestSummary.failed}</strong></div>
    <div class="metric"><span>最近错误</span><strong>${latestSummary.errors}</strong></div>
  </div>
  <div class="paths">
    <div>生成器: <code>${escapeHtml(report.generator)}</code></div>
    <div>命令: <code>${escapeHtml(report.commandLine)}</code></div>
    <div>工作目录: <code>${escapeHtml(report.cwd)}</code></div>
    <div>选项: 间隔 ${report.options.intervalMs} 毫秒, 最大 ${report.options.maxIterations || '无限制'}, 失败时停止 ${report.options.stopOnFailure}</div>
    <div>JSON 报告: <code>${escapeHtml(reportFile.fsPath)}</code></div>
  </div>
  <table>
    <thead>
      <tr><th>#</th><th>状态</th><th>开始</th><th>结束</th><th>总数</th><th>通过</th><th>失败</th><th>错误</th><th>首个问题</th><th>消息</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

function showLogisimPrepareReport(
  report: vscode.Uri,
  results: LogisimPrepareCaseResult[],
  source: CourseTraceBatchSource,
  circuit: vscode.Uri,
  target: LogisimRomTarget
): void {
  const panel = vscode.window.createWebviewPanel('coLogisimPrepareReport', 'CO Logisim 用例准备', vscode.ViewColumn.Beside, {
    enableScripts: false
  });
  panel.webview.html = renderLogisimPrepareReport(report, results, source, circuit, target);
}

function showBatchTraceReport(
  results: CourseTraceCaseResult[],
  report: vscode.Uri,
  generatedAt?: string,
  source?: CourseTraceBatchSource
): void {
  const panel = vscode.window.createWebviewPanel('coBatchTraceReport', 'CO 批量 Trace 测试', vscode.ViewColumn.Beside, {
    enableScripts: false
  });
  panel.webview.html = renderBatchTraceReport(results, report, generatedAt, source);
}

function renderBatchTraceReport(
  results: CourseTraceCaseResult[],
  report: vscode.Uri,
  generatedAt?: string,
  source?: CourseTraceBatchSource
): string {
  const summary = batchSummary(results);
  const rows = results.map((item, index) => `<tr class="${item.status}">
    <td>${index + 1}</td>
    <td>${item.status.toUpperCase()}</td>
    <td>${item.caseId ? `<code>${escapeHtml(item.caseId)}</code>` : ''}</td>
    <td>${escapeHtml(path.basename(item.asm))}</td>
    <td>${item.stdin ? escapeHtml(path.basename(item.stdin)) : ''}</td>
    <td>${escapeHtml(item.stage)}</td>
    <td>${item.firstDiffIndex === undefined ? '' : item.firstDiffIndex + 1}</td>
    <td>${renderFirstDiffSummary(item)}</td>
    <td>${escapeHtml(summaryText(item))}</td>
    <td>${escapeHtml(item.message)}</td>
  </tr>`).join('\n');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h1 {
      font-size: 22px;
      margin: 0 0 16px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }
    .metric {
      border: 1px solid var(--vscode-panel-border);
      padding: 10px;
    }
    .metric strong {
      display: block;
      font-size: 18px;
    }
    .paths {
      margin: 0 0 16px;
      color: var(--vscode-descriptionForeground);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 7px;
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
    }
    .passed td:nth-child(2) {
      color: var(--vscode-testing-iconPassed);
      font-weight: 600;
    }
    .failed td:nth-child(2), .error td:nth-child(2) {
      color: var(--vscode-testing-iconFailed);
      font-weight: 600;
    }
    code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <h1>CO 批量 Trace 测试</h1>
  <div class="summary">
    <div class="metric"><span>总数</span><strong>${summary.total}</strong></div>
    <div class="metric"><span>通过</span><strong>${summary.passed}</strong></div>
    <div class="metric"><span>失败</span><strong>${summary.failed}</strong></div>
    <div class="metric"><span>错误</span><strong>${summary.errors}</strong></div>
  </div>
  ${generatedAt ? `<div class="paths">生成时间: <code>${escapeHtml(generatedAt)}</code></div>` : ''}
  ${renderBatchSource(source)}
  <div class="paths">JSON 报告: <code>${escapeHtml(report.fsPath)}</code></div>
  <table>
    <thead>
      <tr><th>#</th><th>状态</th><th>Case</th><th>ASM</th><th>输入</th><th>阶段</th><th>首个差异</th><th>首个差异详情</th><th>事件</th><th>消息</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

function renderLogisimPrepareReport(
  report: vscode.Uri,
  results: LogisimPrepareCaseResult[],
  source: CourseTraceBatchSource,
  circuit: vscode.Uri,
  target: LogisimRomTarget
): string {
  const summary = logisimPrepSummary(results);
  const rows = results.map((item, index) => `<tr class="${item.status}">
    <td>${index + 1}</td>
    <td>${item.status.toUpperCase()}</td>
    <td>${item.caseId ? `<code>${escapeHtml(item.caseId)}</code>` : ''}</td>
    <td>${escapeHtml(path.basename(item.asm))}</td>
    <td>${item.wordCount ?? ''}</td>
    <td>${item.circuit ? `<code>${escapeHtml(item.circuit)}</code>` : ''}</td>
    <td>${escapeHtml(item.message)}</td>
  </tr>`).join('\n');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h1 {
      font-size: 22px;
      margin: 0 0 16px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }
    .metric {
      border: 1px solid var(--vscode-panel-border);
      padding: 10px;
    }
    .metric strong {
      display: block;
      font-size: 18px;
    }
    .paths {
      margin: 0 0 16px;
      color: var(--vscode-descriptionForeground);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 7px;
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
    }
    .prepared td:nth-child(2) {
      color: var(--vscode-testing-iconPassed);
      font-weight: 600;
    }
    .error td:nth-child(2) {
      color: var(--vscode-testing-iconFailed);
      font-weight: 600;
    }
    code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <h1>CO Logisim 用例准备</h1>
  <div class="summary">
    <div class="metric"><span>总数</span><strong>${summary.total}</strong></div>
    <div class="metric"><span>已准备</span><strong>${summary.prepared}</strong></div>
    <div class="metric"><span>错误</span><strong>${summary.errors}</strong></div>
  </div>
  ${renderBatchSource(source)}
  <div class="paths">
    <div>电路模板: <code>${escapeHtml(circuit.fsPath)}</code></div>
    <div>ROM 目标: <code>${escapeHtml(target.label ?? 'ROM')} #${target.index}${target.loc ? ` ${target.loc}` : ''}</code></div>
    <div>JSON 报告: <code>${escapeHtml(report.fsPath)}</code></div>
  </div>
  <table>
    <thead>
      <tr><th>#</th><th>状态</th><th>Case</th><th>ASM</th><th>字数</th><th>已准备电路</th><th>消息</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

function renderBatchSource(source: CourseTraceBatchSource | undefined): string {
  if (!source) {
    return '';
  }
  if (source.kind !== 'generator') {
    return '<div class="paths">来源: 手动选择的 ASM 文件</div>';
  }
  const asmCount = source.asmFiles?.length ?? 0;
  return `<div class="paths">
    <div>来源: 生成的 ASM 文件${asmCount ? ` (${asmCount})` : ''}</div>
    ${source.generator ? `<div>生成器: <code>${escapeHtml(source.generator)}</code></div>` : ''}
    ${source.commandLine ? `<div>命令: <code>${escapeHtml(source.commandLine)}</code></div>` : ''}
    ${source.cwd ? `<div>工作目录: <code>${escapeHtml(source.cwd)}</code></div>` : ''}
  </div>`;
}

function renderAsmCaseIndex(cases: Awaited<ReturnType<typeof listAsmCaseManifests>>): string {
  const rows = cases.map(({ manifest, uri }) => {
    const artifacts = Object.entries(manifest.artifacts ?? {})
      .flatMap(([kind, items]) => Object.entries(items ?? {}).map(([name, value]) => `${kind}.${name}: ${value}`))
      .slice(0, 6);
    return `<tr>
      <td><code>${escapeHtml(manifest.caseId)}</code></td>
      <td>${escapeHtml(manifest.createdAt)}</td>
      <td>${escapeHtml(manifest.profile)}</td>
      <td>${escapeHtml(manifest.source.kind)}</td>
      <td><code>${escapeHtml(manifest.originalAsmPath)}</code></td>
      <td><code>${escapeHtml(manifest.asmSnapshot.path)}</code></td>
      <td>${manifest.machineCode ? `<code>${escapeHtml(manifest.machineCode.path)}</code>` : ''}</td>
      <td>${artifacts.map((item) => `<div><code>${escapeHtml(item)}</code></div>`).join('')}</td>
      <td><code>${escapeHtml(uri.fsPath)}</code></td>
    </tr>`;
  }).join('\n');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    h1 { font-size: 22px; margin: 0 0 16px; }
    .summary { margin: 0 0 16px; color: var(--vscode-descriptionForeground); }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 7px; text-align: left; vertical-align: top; }
    th { position: sticky; top: 0; background: var(--vscode-editor-background); }
    code { background: var(--vscode-textCodeBlock-background); padding: 2px 4px; word-break: break-word; }
  </style>
</head>
<body>
  <h1>CO ASM 用例记录</h1>
  <div class="summary">共 ${cases.length} 个 case，按创建时间倒序排列。</div>
  <table>
    <thead>
      <tr><th>Case</th><th>时间</th><th>Profile</th><th>来源</th><th>原始 ASM</th><th>ASM 快照</th><th>机器码</th><th>Artifacts</th><th>Manifest</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

function batchSummary(results: CourseTraceCaseResult[]): CourseTraceBatchSummary {
  return {
    total: results.length,
    passed: results.filter((item) => item.status === 'passed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    errors: results.filter((item) => item.status === 'error').length
  };
}

function summaryText(item: CourseTraceCaseResult): string {
  if (item.probe) {
    return `Probe records ${item.probe.records.length}, failures ${item.probe.failures.length}`;
  }
  if (item.marsEvents === undefined || item.simEvents === undefined) {
    return '';
  }
  return `MARS ${item.marsEvents}, SIM ${item.simEvents}, matched ${item.matchedEvents ?? 0}, diff ${item.diffEvents ?? 0}`;
}

function renderFirstDiffSummary(item: CourseTraceCaseResult): string {
  if (item.probe) {
    return renderProbeDetails(item.probe);
  }
  if (!item.firstDiff) {
    return '';
  }
  const reason = item.firstDiff.reason ?? item.firstDiff.status;
  return [
    `<div>${escapeHtml(reason)}</div>`,
    `<div><code>MARS ${escapeHtml(traceEventSummary(item.firstDiff.mars))}</code></div>`,
    `<div><code>SIM ${escapeHtml(traceEventSummary(item.firstDiff.sim))}</code></div>`
  ].join('');
}

function renderProbeDetails(probe: P7ProbeCheckResult): string {
  const failures = probe.failures.slice(0, 5).map((failure) =>
    `<div><code>#${failure.scenarioId} ${escapeHtml(failure.kind)}: ${escapeHtml(failure.message)}</code></div>`
  );
  const records = probe.records.slice(0, 5).map((record) =>
    `<div><code>#${record.scenarioId}: Cause=0x${(record.cause >>> 0).toString(16)} EPC=0x${(record.epc >>> 0).toString(16)} aux0=0x${(record.aux0 >>> 0).toString(16)}</code></div>`
  );
  return [...failures, ...records].join('');
}

function traceEventSummary(event: TraceEventSnapshot | undefined): string {
  if (!event) {
    return '(missing)';
  }
  const cycle = event.cycle === undefined ? '' : `${event.cycle}@`;
  const target = event.kind === 'grf' ? `$${event.target}` : `*${event.target}`;
  return `${cycle}${event.pc}: ${target} <= ${event.value} (line ${event.lineNumber})`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isAsmFile(uri: vscode.Uri): boolean {
  const ext = path.extname(uri.fsPath).toLowerCase();
  return ext === '.asm' || ext === '.s' || ext === '.mips';
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
