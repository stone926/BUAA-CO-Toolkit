// @index main-coordinator — 课程测试总调度，14个co.test.*命令
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import {
  getBuiltinGeneratorInstructionCount,
  getBuiltinGeneratorP7InstructionCount,
  getBuiltinGeneratorInstructions,
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
  getRunTimeout,
  showCommandBeforeRun,
  useBuiltinTestGenerator
} from './config';
import {
  BuiltinAsmGeneratorError,
  generateBuiltinAsmTestCase,
  P7ProbeMetadata
} from './courseTesting/builtinAsmGenerator';
import { checkP7Probe } from './courseTesting/p7ProbeCheck';
import {
  buildGeneratorInvocation,
  changedAsmFiles,
  GeneratorInvocation,
  isSupportedGeneratorFile,
  snapshotAsmFiles
} from './courseTesting/generator';
import {
  compareTraceIterables,
  firstTraceDiffSnapshot
} from './language/mips/traceCompare';
import { iterCpuTraceEvents } from './language/mips/traceParser';
import { parseSimOutput } from './language/verilog/traceParser';
import { runMarsFile } from './mips';
import { compareTracePair, defaultTraceCompareMode } from './traceCompare';
import { runIsim } from './verilog';
import { createIsimCompileCache, IsimCompileCache } from './verilogIsimCache';
import { AppServices, ProjectProfile } from './types';
import { ensureDirectory, readTextFile, workspaceFolderFor, writeTextFile } from './fsUtil';
import { commandLine, revealOutputChannel, runTool } from './process';
import { pickOneFile } from './workflowInputs';
import {
  AsmCase,
  asmCaseArtifactUri,
  copyAsmCaseArtifact,
  createAsmCaseFromAsm,
  createAsmCaseFromText,
  listAsmCaseManifests,
  prepareAsmCaseMachineCode,
  readAsmCaseManifestForAsm,
  updateAsmCaseArtifacts,
  writeAsmCaseArtifact
} from './asmCaseStore';
import {
  batchSummary,
  renderAsmCaseIndex,
  showBatchTraceReport
} from './courseTestReport';
import {
  startContinuousGeneratedTraceTests,
  stopContinuousTests
} from './courseTestContinuous';
import type { ContinuousGeneratedTraceDependencies } from './courseTestContinuous';
import {
  diagnoseP3LogisimTraceCircuit,
  resolveLogisimCircuitInput,
  resolveP3LogisimTraceSetup,
  runLogisimPrepareBatch,
  runP3LogisimTraceCase
} from './courseTestLogisim';
import type { P3LogisimTraceSetup } from './courseTestLogisim';
import {
  asmCaseSourceFromBatchSource,
  caseResultFields,
  failedCase
} from './courseTestCases';
import type { CourseTraceCaseInput } from './courseTestCases';
import type {
  CourseTraceBatchReport,
  CourseTraceBatchSource,
  CourseTraceCaseResult
} from './courseTestReport';
import {
  marsOutputFileNameForCase,
  normalizePathKey,
  simOutputFileNameForCase
} from './courseTestTraceFiles';
import { diffMessage, marsStageFailureMessage } from './courseTestMessages';
import {
  findStdinCandidatesForAsm,
  resolveSingleStdinInput
} from './courseTestStdin';

const batchTraceCompareRetainedEntries = 1;

interface CourseTraceRunOptions {
  revealOutput?: boolean;
  source?: CourseTraceBatchSource;
  logisim?: P3LogisimTraceSetup;
  isimCompileCache?: IsimCompileCache;
  artifactOutputMode?: 'workspace' | 'case';
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

export function registerCourseTest(context: vscode.ExtensionContext, services: AppServices): void {
  const continuousTraceDependencies = createContinuousTraceDependencies();
  context.subscriptions.push(
    vscode.commands.registerCommand('co.test.runFullTest', () => runFullCourseTraceTest(services)),
    vscode.commands.registerCommand('co.test.runBatchTraceTests', () => runBatchCourseTraceTests(services)),
    vscode.commands.registerCommand('co.test.runGeneratedTraceTests', () => runGeneratedCourseTraceTests(services)),
    vscode.commands.registerCommand('co.test.startContinuousGeneratedTraceTests', () => startContinuousGeneratedTraceTests(services, continuousTraceDependencies)),
    vscode.commands.registerCommand('co.test.generateAsmTests', () => generateAsmTests(services)),
    vscode.commands.registerCommand('co.test.generateAndDumpAsmTests', () => generateAndDumpAsmTests(services)),
    vscode.commands.registerCommand('co.test.stopContinuousTests', () => stopContinuousTests()),
    vscode.commands.registerCommand('co.test.prepareLogisimCases', () => prepareLogisimCases(services)),
    vscode.commands.registerCommand('co.test.diagnoseP3LogisimTraceCircuit', () => diagnoseP3LogisimTraceCircuit(services)),
    vscode.commands.registerCommand('co.test.prepareGeneratedLogisimCases', () => prepareGeneratedLogisimCases(services)),
    vscode.commands.registerCommand('co.test.openBatchTraceReport', () => openBatchTraceReport()),
    vscode.commands.registerCommand('co.test.openAsmCaseIndex', () => openAsmCaseIndex())
  );
}

function createContinuousTraceDependencies(): ContinuousGeneratedTraceDependencies<GeneratorRunSetup, CourseTraceCaseInput, AsmCase, CourseTraceRunOptions> {
  return {
    resolveGeneratorRunSetup,
    generatorResource,
    generatorFolder: (setup) => setup.folder,
    generatorLabel,
    generatorCommandLine,
    generatorCwd,
    resolveCourseTraceRunOptions,
    runGeneratorAndCollectAsms,
    expandTraceCases,
    runCourseTraceCase
  };
}

async function runFullCourseTraceTest(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);

  const asm = await resolveAsmInput();
  if (!asm) {
    return;
  }

  const stdin = await resolveSingleStdinInput(asm);
  const runOptions = await resolveCourseTraceRunOptions(services, asm, { source: { kind: 'selected', asmFiles: [asm.fsPath] } });
  if (!runOptions) {
    return;
  }
  const result = await runCourseTraceCase(services, { asm, stdin }, runOptions);
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

  await runCourseTraceBatch(services, await expandTraceCases(generated.asms, generated.asmCases), generated.source);
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

  const runOptions = await resolveCourseTraceRunOptions(services, cases[0].asm, { source });
  if (!runOptions) {
    return;
  }

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
      results.push(await runCourseTraceCase(services, item, runOptions));
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

async function resolveCourseTraceRunOptions(
  services: AppServices,
  resource: vscode.Uri,
  base: CourseTraceRunOptions = {}
): Promise<CourseTraceRunOptions | undefined> {
  const options: CourseTraceRunOptions = { ...base };
  if (getProfile(resource) === 'P3') {
    const logisim = await resolveP3LogisimTraceSetup(services, resource);
    if (!logisim) {
      return undefined;
    }
    options.logisim = logisim;
  } else {
    options.isimCompileCache ??= createIsimCompileCache();
  }
  return options;
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
  if (getProfile(asm) === 'P3') {
    return await runP3LogisimTraceCase(services, item, options);
  }

  services.output.appendLine('完整课程 Trace 测试');
  services.output.appendLine(`ASM: ${asm.fsPath}`);
  if (item.stdin) {
    services.output.appendLine(`标准输入: ${item.stdin.fsPath}`);
  }

  const asmCase = item.asmCase ?? await createAsmCaseFromAsm(asm, {
    source: asmCaseSourceFromBatchSource(options.source ?? { kind: 'selected', asmFiles: [asm.fsPath] }),
    stdin: item.stdin,
    resource: asm,
    p7: await p7MetadataFromSidecar(asm)
  });
  const caseOutputMode = options.artifactOutputMode === 'case';
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

  const interruptSchedule = resolveCaseInterruptScheduleFromCase(asmCase) ?? await resolveCaseInterruptSchedule(asm);
  if (interruptSchedule) {
    services.output.appendLine(`外部中断目标 PC: ${interruptSchedule.map((pc) => `0x${(pc >>> 0).toString(16)}`).join(', ')}`);
  }
  const probe = resolveCaseProbeMetadataFromCase(asmCase) ?? await resolveCaseProbeMetadata(asm);
  if (probe) {
    services.output.appendLine(`P7 Probe 场景: ${probe.scenarios.map((scenario) => `${scenario.id}:${scenario.kind}`).join(', ')}`);
    const isim = await runIsim(services, {
      resource: asm,
      showMessages: false,
      revealOutput: options.revealOutput,
      asmCase,
      simOutputFileName: simOutputFileNameForCase(item),
      simOutputUri: caseOutputMode ? asmCaseArtifactUri(asmCase, 'verilog', simOutputFileNameForCase(item)) : undefined,
      p7Probe: probe,
      compileCache: options.isimCompileCache
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
    runOutputFile: caseOutputMode ? asmCaseArtifactUri(asmCase, 'mars', marsOutputFileNameForCase(item)) : undefined,
    interruptSchedule
  });
  if (!mars?.result.ok || !mars.outputFile) {
    return failedCase(item, 'mars', marsStageFailureMessage('测试中止：MARS 黄金模型运行失败', mars?.result), asmCase.machineCode, undefined, asmCase);
  }
  if (caseOutputMode) {
    await updateAsmCaseArtifacts(asmCase, 'mars', { traceOut: mars.outputFile.fsPath });
  } else {
    await copyAsmCaseArtifact(asmCase, 'mars', mars.outputFile, path.basename(mars.outputFile.fsPath), 'traceOut');
  }

  const isim = await runIsim(services, {
    resource: asm,
    showMessages: false,
    revealOutput: options.revealOutput,
    asmCase,
    simOutputFileName: simOutputFileNameForCase(item),
    simOutputUri: caseOutputMode ? asmCaseArtifactUri(asmCase, 'verilog', simOutputFileNameForCase(item)) : undefined,
    interruptSchedule,
    compileCache: options.isimCompileCache
  });
  if (!isim?.simResult.ok || !isim.simOut) {
    return failedCase(item, 'isim', '测试中止：ISim 运行失败', asmCase.machineCode, mars.outputFile, asmCase);
  }

  const marsText = await readTextFile(mars.outputFile);
  const simText = await readTextFile(isim.simOut);
  const diff = compareTraceIterables(iterCpuTraceEvents(marsText), iterCpuTraceEvents(simText), {
    compareCycles: defaultTraceCompareMode.compareCycles,
    retainedEntryLimit: batchTraceCompareRetainedEntries
  });

  if (!diff.summary.marsEvents || !diff.summary.simEvents) {
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
      marsEvents: diff.summary.marsEvents,
      simEvents: diff.summary.simEvents,
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
      instructionCount: builtinInstructionCountForProfile(profile, resource),
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

  const before = await snapshotAsmFiles(setup.folder.uri.fsPath);
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

  const after = await snapshotAsmFiles(setup.folder.uri.fsPath);
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

async function expandTraceCases(asms: vscode.Uri[], asmCases?: AsmCase[]): Promise<CourseTraceCaseInput[]> {
  const caseByAsm = new Map((asmCases ?? []).map((asmCase) => [normalizePathKey(asmCase.sourceAsm.fsPath), asmCase]));
  const cases: CourseTraceCaseInput[] = [];
  for (const asm of asms) {
    const asmCase = caseByAsm.get(normalizePathKey(asm.fsPath));
    const stdinFiles = await findStdinCandidatesForAsm(asm);
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

function builtinInstructionCountForProfile(profile: ProjectProfile, resource: vscode.Uri): number {
  if (profile === 'P7') {
    return getBuiltinGeneratorP7InstructionCount(resource);
  }
  return getBuiltinGeneratorInstructionCount(resource);
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
  const suffix = randomBytes(3).toString('hex');
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

async function p7MetadataFromSidecar(asm: vscode.Uri): Promise<{ interruptSchedule?: number[]; probe?: P7ProbeMetadata } | undefined> {
  const data = await readCaseMetadata(asm);
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
      p7: await p7MetadataFromSidecar(item.asm)
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

async function readCaseMetadata(asm: vscode.Uri): Promise<CourseCaseMetadata> {
  const manifest = await readAsmCaseManifestForAsm(asm);
  if (manifest?.p7) {
    return {
      profile: manifest.profile,
      interruptSchedule: manifest.p7.interruptSchedule,
      probe: isProbeMetadata(manifest.p7.probe) ? manifest.p7.probe : undefined
    };
  }
  try {
    const uri = interruptScheduleSidecarUri(asm);
    const data = JSON.parse(await fs.promises.readFile(uri.fsPath, 'utf8')) as CourseCaseMetadata;
    return data && typeof data === 'object' ? data : {};
  } catch {
    // 元数据文件不存在或格式异常时返回空对象
    return {};
  }
}

async function readInterruptScheduleSidecar(asm: vscode.Uri): Promise<number[]> {
  const data = await readCaseMetadata(asm);
  if (!Array.isArray(data.interruptSchedule)) {
    return [];
  }
  return data.interruptSchedule.map((value) => Number(value)).filter((value) => Number.isFinite(value));
}

async function resolveCaseProbeMetadata(asm: vscode.Uri): Promise<P7ProbeMetadata | undefined> {
  if (getProfile(asm) !== 'P7') {
    return undefined;
  }
  const data = await readCaseMetadata(asm);
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
async function resolveCaseInterruptSchedule(asm: vscode.Uri): Promise<number[] | undefined> {
  if (getProfile(asm) !== 'P7' || !getP7InterruptEnabled(asm)) {
    return undefined;
  }
  const schedule = await readInterruptScheduleSidecar(asm);
  return schedule.length ? schedule : undefined;
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

function isAsmFile(uri: vscode.Uri): boolean {
  const ext = path.extname(uri.fsPath).toLowerCase();
  return ext === '.asm' || ext === '.s' || ext === '.mips';
}
