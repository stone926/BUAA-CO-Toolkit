import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  ensureConcreteProfile,
  getContinuousIntervalMs,
  getContinuousMaxIterations,
  getContinuousReportRetainedIterations,
  getContinuousRetainedPassingCases,
  getContinuousStopOnFailure,
  getMemoryConfiguration
} from './config';
import {
  addContinuousResult,
  continuousStatusFromCounts,
  createContinuousCounts,
  pruneContinuousIterations,
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
  retainedPassingArtifacts: ContinuousRetainedArtifacts[];
  retention: ContinuousTraceRetention;
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
  artifactOutputMode?: 'workspace' | 'case';
}

interface ContinuousTraceRetention {
  retainedPassingCases: number;
  reportRetainedIterations: number;
}

interface ContinuousRetainedArtifacts {
  iterationIndex: number;
  resultIndex: number;
  result: CourseTraceCaseResult;
  caseDir?: string;
  files: string[];
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
  const baseRunOptions = await deps.resolveCourseTraceRunOptions(services, resource, {
    revealOutput: false,
    artifactOutputMode: 'case'
  });
  if (!baseRunOptions) {
    return;
  }

  const intervalMs = getContinuousIntervalMs(resource);
  const maxIterations = getContinuousMaxIterations(resource);
  const stopOnFailure = getContinuousStopOnFailure(resource);
  const retention: ContinuousTraceRetention = {
    retainedPassingCases: getContinuousRetainedPassingCases(resource),
    reportRetainedIterations: getContinuousReportRetainedIterations(resource)
  };
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
    retainedPassingArtifacts: [],
    retention,
    report: {
      generatedAt: new Date().toISOString(),
      running: true,
      stopRequested: false,
      totalIterations: 0,
      generator: deps.generatorLabel(setup),
      commandLine: deps.generatorCommandLine(setup),
      cwd: deps.generatorCwd(setup),
      options: {
        intervalMs,
        maxIterations,
        stopOnFailure
      },
      retention: {
        retainedPassingCases: retention.retainedPassingCases,
        reportRetainedIterations: retention.reportRetainedIterations,
        artifactOutputMode: 'case'
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
  services.output.appendLine(`产物: 通过 case 仅保留最近 ${retention.retainedPassingCases} 个，失败/异常 case 始终保留`);

  try {
    await updateContinuousTraceMonitor(session, { force: true });
    let index = 0;
    while (!session.stopRequested && (maxIterations === 0 || index < maxIterations)) {
      index++;
      session.report.totalIterations = index;
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
      await applyContinuousRetention(session, iteration);
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

async function applyContinuousRetention(
  session: ContinuousTraceSession,
  iteration: ContinuousTraceIteration
): Promise<void> {
  for (let resultIndex = 0; resultIndex < iteration.results.length; resultIndex++) {
    const result = iteration.results[resultIndex];
    if (result.status !== 'passed') {
      continue;
    }
    const artifacts = continuousRetainedArtifacts(iteration.index, resultIndex, result);
    if (artifacts) {
      session.retainedPassingArtifacts.push(artifacts);
    }
  }

  while (session.retainedPassingArtifacts.length > session.retention.retainedPassingCases) {
    const victim = session.retainedPassingArtifacts.shift();
    if (victim) {
      await pruneContinuousPassingArtifacts(victim, session);
    }
  }

  session.report.iterations = pruneContinuousIterations(
    session.report.iterations,
    session.retention.reportRetainedIterations
  );
}

function continuousRetainedArtifacts(
  iterationIndex: number,
  resultIndex: number,
  result: CourseTraceCaseResult
): ContinuousRetainedArtifacts | undefined {
  const caseDir = continuousCaseDirFromManifest(result.caseManifest);
  const files = continuousResultFiles(result)
    .filter((file) => !caseDir || !isPathInside(file, caseDir));
  if (!caseDir && !files.length) {
    return undefined;
  }
  return {
    iterationIndex,
    resultIndex,
    result,
    caseDir,
    files
  };
}

async function pruneContinuousPassingArtifacts(
  victim: ContinuousRetainedArtifacts,
  session: ContinuousTraceSession
): Promise<void> {
  const protectedPaths = protectedContinuousArtifactPaths(session);
  const protectedDirs = protectedContinuousCaseDirs(session);
  const victimDirKey = victim.caseDir ? normalizePathKey(victim.caseDir) : undefined;

  if (victim.caseDir && !protectedDirs.has(victimDirKey!) && isSafeContinuousCaseDir(victim.caseDir)) {
    try {
      await fs.promises.rm(victim.caseDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only. The report is still compacted so the monitor stays small.
    }
  }

  for (const file of victim.files) {
    const key = normalizePathKey(file);
    if (protectedPaths.has(key) || !isSafeContinuousOutFile(file)) {
      continue;
    }
    try {
      await fs.promises.rm(file, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  markContinuousArtifactsPruned(victim.result);
}

function protectedContinuousArtifactPaths(session: ContinuousTraceSession): Set<string> {
  const protectedPaths = new Set<string>();
  for (const item of session.retainedPassingArtifacts) {
    for (const file of item.files) {
      protectedPaths.add(normalizePathKey(file));
    }
  }
  for (const iteration of session.report.iterations) {
    for (const result of iteration.results) {
      if (result.status === 'passed') {
        continue;
      }
      for (const file of continuousResultFiles(result)) {
        protectedPaths.add(normalizePathKey(file));
      }
    }
  }
  return protectedPaths;
}

function protectedContinuousCaseDirs(session: ContinuousTraceSession): Set<string> {
  const protectedDirs = new Set<string>();
  for (const item of session.retainedPassingArtifacts) {
    if (item.caseDir) {
      protectedDirs.add(normalizePathKey(item.caseDir));
    }
  }
  for (const iteration of session.report.iterations) {
    for (const result of iteration.results) {
      if (result.status === 'passed') {
        continue;
      }
      const dir = continuousCaseDirFromManifest(result.caseManifest);
      if (dir) {
        protectedDirs.add(normalizePathKey(dir));
      }
    }
  }
  return protectedDirs;
}

function continuousResultFiles(result: CourseTraceCaseResult): string[] {
  return [
    result.asmSnapshot,
    result.caseManifest,
    result.machineCode,
    result.marsOut,
    result.simOut,
    result.logisimOut,
    result.logisimCircuit
  ].filter((file): file is string => Boolean(file));
}

function markContinuousArtifactsPruned(result: CourseTraceCaseResult): void {
  result.artifactsPruned = true;
  delete result.caseManifest;
  delete result.asmSnapshot;
  delete result.machineCode;
  delete result.marsOut;
  delete result.simOut;
  delete result.logisimOut;
  delete result.logisimCircuit;
}

function continuousCaseDirFromManifest(manifest: string | undefined): string | undefined {
  if (!manifest || path.basename(manifest).toLowerCase() !== 'case.json') {
    return undefined;
  }
  const dir = path.dirname(manifest);
  return isSafeContinuousCaseDir(dir) ? dir : undefined;
}

function isSafeContinuousCaseDir(dir: string): boolean {
  const resolved = path.resolve(dir);
  return path.basename(path.dirname(resolved)).toLowerCase() === 'cases'
    && path.basename(path.dirname(path.dirname(resolved))).toLowerCase() === '.co'
    && path.basename(resolved).length > 0;
}

function isSafeContinuousOutFile(file: string): boolean {
  const resolved = path.resolve(file);
  return path.basename(path.dirname(resolved)).toLowerCase() === 'out'
    && path.basename(path.dirname(path.dirname(resolved))).toLowerCase() === '.co';
}

function isPathInside(file: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  return relative === '' || Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizePathKey(file: string): string {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
