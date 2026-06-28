import { Commands } from './constants';
// @index main-coordinator — 课程测试总调度，14个co.test.*命令
import * as path from 'path';
import * as vscode from 'vscode';
import { getProfile } from './config';
import {
  GeneratedAsmBatch,
  GeneratorRunSetup,
  generatorCommandLine,
  generatorCwd,
  generatorFolder,
  generatorLabel,
  generatorResource,
  resolveGeneratedAsmBatch,
  resolveGeneratorRunSetup,
  runGeneratorAndCollectAsms
} from './courseTesting/generatorWorkflow';
import {
  CourseTraceRunOptions,
  p7MetadataFromManifest,
  runCourseTraceCase
} from './courseTesting/traceRunner';
import { runCourseTraceBatch } from './courseTesting/batchRunner';
import { compareTracePair, defaultTraceCompareMode } from './traceCompare';
import { createIsimCompileCache } from './verilogIsimCache';
import { AppServices } from './types';
import { readTextFile, workspaceFolderForOrFirst } from './fsUtil';
import { pickOneFile, resolveWorkspaceFile, resolveWorkspaceFiles } from './workflowInputs';
import {
  AsmCase,
  createAsmCaseFromAsm,
  listAsmCaseManifests,
  prepareAsmCaseMachineCode,
} from './asmCaseStore';
import {
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
  resolveP3LogisimTraceSetup,
  runLogisimPrepareBatch
} from './courseTestLogisim';
import { asmCaseSourceFromBatchSource } from './courseTestCases';
import type { CourseTraceCaseInput } from './courseTestCases';
import type {
  CourseTraceBatchReport,
  CourseTraceBatchSource
} from './courseTestReport';
import { marsStageFailureMessage } from './courseTestMessages';
import {
  findStdinCandidatesForAsm,
  resolveSingleStdinInput
} from './courseTestStdin';
import { normalizePathKey } from './pathUtils';

export function registerCourseTest(context: vscode.ExtensionContext, services: AppServices): void {
  const continuousTraceDependencies = createContinuousTraceDependencies();
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.Test.RunFullTest, () => runFullCourseTraceTest(services)),
    vscode.commands.registerCommand(Commands.Test.RunBatchTraceTests, () => runBatchCourseTraceTests(services)),
    vscode.commands.registerCommand(Commands.Test.RunGeneratedTraceTests, () => runGeneratedCourseTraceTests(services)),
    vscode.commands.registerCommand(Commands.Test.StartContinuousGeneratedTraceTests, () => startContinuousGeneratedTraceTests(services, continuousTraceDependencies)),
    vscode.commands.registerCommand(Commands.Test.GenerateAsmTests, () => generateAsmTests(services)),
    vscode.commands.registerCommand(Commands.Test.GenerateAndDumpAsmTests, () => generateAndDumpAsmTests(services)),
    vscode.commands.registerCommand(Commands.Test.StopContinuousTests, () => stopContinuousTests()),
    vscode.commands.registerCommand(Commands.Test.PrepareLogisimCases, () => prepareLogisimCases(services)),
    vscode.commands.registerCommand(Commands.Test.DiagnoseP3LogisimTraceCircuit, () => diagnoseP3LogisimTraceCircuit(services)),
    vscode.commands.registerCommand(Commands.Test.PrepareGeneratedLogisimCases, () => prepareGeneratedLogisimCases(services)),
    vscode.commands.registerCommand(Commands.Test.OpenBatchTraceReport, () => openBatchTraceReport()),
    vscode.commands.registerCommand(Commands.Test.OpenAsmCaseIndex, () => openAsmCaseIndex())
  );
}

function createContinuousTraceDependencies(): ContinuousGeneratedTraceDependencies<GeneratorRunSetup, CourseTraceCaseInput, AsmCase, CourseTraceRunOptions> {
  return {
    resolveGeneratorRunSetup,
    generatorResource,
    generatorFolder,
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

  await runCourseTraceBatch(services, cases, { kind: 'selected' }, resolveCourseTraceRunOptions);
}

async function runGeneratedCourseTraceTests(services: AppServices): Promise<void> {
  await vscode.workspace.saveAll(false);

  const generated = await resolveGeneratedAsmBatch(services, { resolveAsmBatchInputs });
  if (!generated) {
    return;
  }

  await runCourseTraceBatch(services, await expandTraceCases(generated.asms, generated.asmCases), generated.source, resolveCourseTraceRunOptions);
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

  const generated = await resolveGeneratedAsmBatch(services, { resolveAsmBatchInputs });
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

async function resolveAsmInput(): Promise<vscode.Uri | undefined> {
  return await resolveWorkspaceFile({
    title: '选择课程 Trace 测试的 MIPS ASM 文件',
    include: '**/*.{asm,s,mips}',
    exclude: '**/{node_modules,out,.git}/**',
    maxResults: 200,
    filters: {
      ASM: ['asm', 's', 'mips'],
      All: ['*']
    },
    activeFile: isAsmFile,
    saveActive: true
  });
}

async function resolveAsmBatchInputs(): Promise<vscode.Uri[]> {
  return await resolveWorkspaceFiles({
    title: '选择批量 Trace 测试的 MIPS ASM 文件',
    include: '**/*.{asm,s,mips}',
    exclude: '**/{node_modules,out,.git}/**',
    maxResults: 500,
    filters: {
      ASM: ['asm', 's', 'mips'],
      All: ['*']
    }
  });
}

async function resolveBatchTraceCases(): Promise<CourseTraceCaseInput[]> {
  const asms = await resolveAsmBatchInputs();
  return expandTraceCases(asms);
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

function generatedCaseInputs(generated: GeneratedAsmBatch): CourseTraceCaseInput[] {
  if (generated.asmCases?.length) {
    return generated.asmCases.map((asmCase) => ({
      asm: asmCase.sourceAsm,
      asmCase
    }));
  }
  return generated.asms.map((asm) => ({ asm }));
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
      p7: await p7MetadataFromManifest(item.asm)
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


async function resolveBatchTraceReport(): Promise<vscode.Uri | undefined> {
  const folder = workspaceFolderForOrFirst(vscode.window.activeTextEditor?.document.uri);
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
