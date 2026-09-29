import { Commands } from './constants';
// @index main-coordinator — 课程测试总调度：持续测试命令、停止控制与历史入口
import * as vscode from 'vscode';
import { getProfile } from './config';
import {
  BuiltinGeneratorRunSetup,
  generatorFolder,
  generatorResource,
  resolveGeneratorRunSetup,
  runGeneratorAndCollectAsms
} from './courseTesting/generatorWorkflow';
import {
  CourseTraceRunOptions,
  runCourseTraceCase
} from './courseTesting/traceRunner';
import { AppServices } from './types';
import {
  AsmCase,
  listAsmCaseManifests
} from './asmCaseStore';
import {
  renderAsmCaseIndex
} from './courseTestReport';
import {
  requestContinuousTestsStop,
  startContinuousGeneratedTraceTests
} from './courseTestContinuous';
import type { ContinuousGeneratedTraceDependencies } from './courseTestContinuous';
import {
  resolveP3LogisimTraceSetup
} from './courseTestLogisim';
import type { CourseTraceCaseInput } from './courseTestCases';
import {
  findStdinCandidatesForAsm
} from './courseTestStdin';
import { normalizePathKey } from './pathUtils';

export function registerCourseTest(context: vscode.ExtensionContext, services: AppServices): void {
  const continuousTraceDependencies = createContinuousTraceDependencies();
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.Test.StartContinuousGeneratedTraceTests, () => startContinuousGeneratedTraceTests(services, continuousTraceDependencies)),
    vscode.commands.registerCommand(Commands.Test.StopContinuousTests, () => stopAutomaticTests()),
    vscode.commands.registerCommand(Commands.Test.OpenAsmCaseIndex, (resource?: vscode.Uri) => openAsmCaseIndex(resource))
  );
}

function createContinuousTraceDependencies(): ContinuousGeneratedTraceDependencies<BuiltinGeneratorRunSetup, CourseTraceCaseInput, AsmCase, CourseTraceRunOptions> {
  return {
    resolveGeneratorRunSetup,
    generatorResource,
    generatorFolder,
    resolveCourseTraceRunOptions,
    runGeneratorAndCollectAsms,
    expandTraceCases,
    runCourseTraceCase
  };
}

function stopAutomaticTests(): void {
  const continuous = requestContinuousTestsStop();
  if (continuous === 'none') {
    vscode.window.showInformationMessage('当前没有正在运行的持续测试');
    return;
  }
  vscode.window.showInformationMessage('已请求停止持续测试');
}

async function resolveCourseTraceRunOptions(
  services: AppServices,
  resource: vscode.Uri,
  base: CourseTraceRunOptions = {}
): Promise<CourseTraceRunOptions | undefined> {
  const options: CourseTraceRunOptions = { ...base };
  if (getProfile(resource) === 'P3') {
    const logisim = await resolveP3LogisimTraceSetup(services, resource, {
      nonInteractive: base.source?.kind === 'generator'
    });
    if (!logisim) {
      return undefined;
    }
    options.logisim = logisim;
  }
  return options;
}

async function openAsmCaseIndex(resource?: vscode.Uri): Promise<void> {
  const manifests = await listAsmCaseManifests(resource ?? vscode.window.activeTextEditor?.document.uri);
  const panel = vscode.window.createWebviewPanel('coAsmCaseIndex', '测试历史 / 失败用例', vscode.ViewColumn.Beside, {
    enableScripts: true,
    enableFindWidget: true,
    localResourceRoots: []
  });
  panel.webview.html = renderAsmCaseIndex(manifests);
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
