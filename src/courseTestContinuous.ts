import * as path from 'path';
import * as vscode from 'vscode';
import {
  ensureConcreteProfile,
  getContinuousIntervalMs,
  getContinuousMaxIterations,
  getContinuousStopOnFailure,
  getMemoryConfiguration
} from './config';
import {
  addContinuousResult,
  continuousStatusFromCounts,
  createContinuousCounts,
  shouldStopAfterIterationCounts
} from './courseTesting/continuous';
import { ensureDirectory, writeTextFile } from './fsUtil';
import { revealOutputChannel } from './process';
import { checkToolchain } from './toolchain';
import { AppServices, ProjectProfile } from './types';
import {
  ContinuousTraceIteration,
  ContinuousTraceReport,
  CourseTraceBatchSource,
  CourseTraceCaseResult,
  renderContinuousTraceMonitor
} from './courseTestReport';
import { courseTraceMemoryConfigurationError, formatToolchainFailure } from './courseTestToolchain';

interface ContinuousTraceSession {
  stopRequested: boolean;
  report: ContinuousTraceReport;
  reportFile: vscode.Uri;
  panel: vscode.WebviewPanel;
  lastMonitorFlushMs: number;
}

interface ContinuousTraceCaseLike {
  asm: vscode.Uri;
  stdin?: vscode.Uri;
}

interface ContinuousGeneratedBatch<TAsmCase> {
  asms: vscode.Uri[];
  source: CourseTraceBatchSource;
  asmCases?: TAsmCase[];
}

interface ContinuousIterationRunOptions {
  revealOutput?: boolean;
  source?: CourseTraceBatchSource;
}

export interface ContinuousGeneratedTraceDependencies<TSetup, TCase extends ContinuousTraceCaseLike, TAsmCase, TRunOptions extends object> {
  resolveGeneratorRunSetup: () => Promise<TSetup | undefined>;
  generatorResource: (setup: TSetup) => vscode.Uri;
  generatorFolder: (setup: TSetup) => vscode.WorkspaceFolder;
  generatorLabel: (setup: TSetup) => string;
  generatorCommandLine: (setup: TSetup) => string;
  generatorCwd: (setup: TSetup) => string;
  resolveCourseTraceRunOptions: (
    services: AppServices,
    resource: vscode.Uri,
    base: ContinuousIterationRunOptions
  ) => Promise<TRunOptions | undefined>;
  runGeneratorAndCollectAsms: (
    services: AppServices,
    setup: TSetup,
    options: { revealOutput: false }
  ) => Promise<ContinuousGeneratedBatch<TAsmCase> | undefined>;
  expandTraceCases: (asms: vscode.Uri[], asmCases?: TAsmCase[]) => Promise<TCase[]>;
  runCourseTraceCase: (
    services: AppServices,
    item: TCase,
    options: TRunOptions & ContinuousIterationRunOptions
  ) => Promise<CourseTraceCaseResult>;
}

let activeContinuousTraceSession: ContinuousTraceSession | undefined;
const continuousMonitorFlushIntervalMs = 1000;

export async function startContinuousGeneratedTraceTests<TSetup, TCase extends ContinuousTraceCaseLike, TAsmCase, TRunOptions extends object>(
  services: AppServices,
  deps: ContinuousGeneratedTraceDependencies<TSetup, TCase, TAsmCase, TRunOptions>
): Promise<void> {
  if (activeContinuousTraceSession) {
    vscode.window.showWarningMessage('已有一个持续课程 Trace 测试会话正在运行');
    return;
  }

  await vscode.workspace.saveAll(false);
  const setup = await deps.resolveGeneratorRunSetup();
  if (!setup) {
    return;
  }
  const resource = deps.generatorResource(setup);
  if (!await ensureContinuousTraceToolchainReady(services, resource)) {
    return;
  }
  const baseRunOptions = await deps.resolveCourseTraceRunOptions(services, resource, { revealOutput: false });
  if (!baseRunOptions) {
    return;
  }

  const intervalMs = getContinuousIntervalMs(resource);
  const maxIterations = getContinuousMaxIterations(resource);
  const stopOnFailure = getContinuousStopOnFailure(resource);
  const outDir = vscode.Uri.file(path.join(deps.generatorFolder(setup).uri.fsPath, '.co', 'out'));
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
    lastMonitorFlushMs: 0,
    report: {
      generatedAt: new Date().toISOString(),
      running: true,
      stopRequested: false,
      generator: deps.generatorLabel(setup),
      commandLine: deps.generatorCommandLine(setup),
      cwd: deps.generatorCwd(setup),
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
  services.output.appendLine(`生成器: ${deps.generatorLabel(setup)}`);
  services.output.appendLine(`间隔: ${intervalMs} 毫秒, 最大轮数: ${maxIterations || '无限制'}, 失败时停止: ${stopOnFailure}`);

  try {
    await updateContinuousTraceMonitor(session, { force: true });
    let index = 0;
    while (!session.stopRequested && (maxIterations === 0 || index < maxIterations)) {
      index++;
      services.statusBar.text = `CO: Continuous #${index}`;
      const iteration: ContinuousTraceIteration = {
        index,
        status: 'running',
        startedAt: new Date().toISOString(),
        summary: createContinuousCounts(),
        results: []
      };
      session.report.iterations.unshift(iteration);
      await updateContinuousTraceMonitor(session, { force: true });

      services.output.appendLine('');
      services.output.appendLine(`Continuous iteration #${index}`);
      try {
        const generated = await deps.runGeneratorAndCollectAsms(services, setup, { revealOutput: false });
        if (!generated?.asms.length) {
          iteration.status = 'error';
          iteration.message = '生成器已完成，但未检测到新建或修改的 ASM 文件';
          services.output.appendLine(iteration.message);
        } else {
          iteration.source = generated.source;
          const cases = await deps.expandTraceCases(generated.asms, generated.asmCases);
          for (let i = 0; i < cases.length; i++) {
            if (session.stopRequested) {
              break;
            }
            const item = cases[i];
            services.output.appendLine(`[iteration ${index}, case ${i + 1}/${cases.length}] ${item.asm.fsPath}`);
            let result: CourseTraceCaseResult;
            try {
              result = await deps.runCourseTraceCase(services, item, {
                ...baseRunOptions,
                revealOutput: false,
                source: generated.source
              });
            } catch (error) {
              result = {
                asm: item.asm.fsPath,
                stdin: item.stdin?.fsPath,
                status: 'error',
                stage: 'compare',
                message: error instanceof Error ? error.message : String(error)
              };
            }
            iteration.results.push(result);
            addContinuousResult(iteration.summary, result);
            iteration.status = continuousStatusFromCounts(iteration.summary, true, session.stopRequested);
            await updateContinuousTraceMonitor(session);
          }
          iteration.status = continuousStatusFromCounts(iteration.summary, false, session.stopRequested);
        }
      } catch (error) {
        iteration.status = 'error';
        iteration.message = error instanceof Error ? error.message : String(error);
      }

      iteration.finishedAt = new Date().toISOString();
      if (iteration.status === 'running') {
        iteration.status = continuousStatusFromCounts(iteration.summary, false, session.stopRequested);
      }
      await updateContinuousTraceMonitor(session, { force: true });

      if (session.stopRequested || shouldStopAfterIterationCounts(iteration.summary, stopOnFailure) || iteration.status === 'error') {
        break;
      }
      await delay(intervalMs);
    }
  } finally {
    session.report.running = false;
    session.report.stopRequested = session.stopRequested;
    services.statusBar.text = 'CO: Continuous stopped';
    await updateContinuousTraceMonitor(session, { force: true });
    if (activeContinuousTraceSession === session) {
      activeContinuousTraceSession = undefined;
    }
  }
}

export function stopContinuousTests(): void {
  if (!activeContinuousTraceSession) {
    vscode.window.showInformationMessage('当前没有正在运行的持续测试');
    return;
  }
  activeContinuousTraceSession.stopRequested = true;
  activeContinuousTraceSession.report.stopRequested = true;
  vscode.window.showInformationMessage('将在当前工具运行完成后停止持续测试');
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

  const checks = await checkToolchain(services.output, resource, profile === 'P3' ? { tools: ['java', 'mars', 'logisim'] } : {});
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

function requiredContinuousTraceChecks(profile: ProjectProfile, memoryConfiguration: string): Set<string> {
  if (profile === 'P3') {
    return new Set(['Java', 'MARS', 'MARS coL1', 'Logisim', `MARS ${memoryConfiguration}`]);
  }
  const names = new Set(['Java', 'MARS', 'MARS coL1', 'ISE fuse']);
  if (profile !== 'P7') {
    names.add(`MARS ${memoryConfiguration}`);
  }
  return names;
}

async function updateContinuousTraceMonitor(session: ContinuousTraceSession, options: { force?: boolean } = {}): Promise<void> {
  session.report.stopRequested = session.stopRequested;
  session.report.generatedAt = new Date().toISOString();
  const now = Date.now();
  if (!options.force && now - session.lastMonitorFlushMs < continuousMonitorFlushIntervalMs) {
    return;
  }
  session.lastMonitorFlushMs = now;
  await writeTextFile(session.reportFile, JSON.stringify(session.report, null, 2) + '\n');
  try {
    session.panel.webview.html = renderContinuousTraceMonitor(session.report, session.reportFile);
  } catch {
    // Webview 已关闭或不可更新时停止持续测试会话
    session.stopRequested = true;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
