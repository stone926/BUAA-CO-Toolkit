import { CO_DIR, CO_OUT_DIR } from './constants';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  ensureConcreteProfile,
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
import { checkToolchain } from './toolchain';
import { AppServices } from './types';
import { recordAsmCaseTestOutcome } from './asmCaseStore';
import {
  ContinuousTraceIteration,
  ContinuousTraceReport,
  CourseTraceBatchSource,
  CourseTraceCaseResult,
  neutralCourseTraceCaseResult,
  neutralCourseTraceStage,
  publicAutomaticDiagnosticMessage,
  publicContinuousTraceReport,
  renderContinuousTraceMonitor
} from './courseTestReport';
import {
  courseTraceMemoryConfigurationErrorForEngine,
  formatAutomaticToolchainFailure,
  requiredCourseTraceToolchainChecks,
  requiredToolchainFailures
} from './courseTestToolchain';
import { normalizePathKey } from './pathUtils';
import {
  automaticTestEngineMode,
  continuousAutomaticTestPolicy,
  type ContinuousAutomaticTestPolicy
} from './courseTesting/automaticTestPolicy';
import { tryAcquireCourseTestSession } from './courseTesting/courseTestSession';

interface ContinuousTraceSession {
  stopRequested: boolean;
  abortController: AbortController;
  wakeIntervalWait?: () => void;
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
  asmCase?: {
    id: string;
    manifestUri: vscode.Uri;
    asm: vscode.Uri;
  };
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
  signal?: AbortSignal;
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
  /** Test-only injection seam; the production facade always uses the internal policy. */
  automaticPolicy?: () => ContinuousAutomaticTestPolicy;
  resolveGeneratorRunSetup: () => Promise<TSetup | undefined>;
  generatorResource: (setup: TSetup) => vscode.Uri;
  generatorFolder: (setup: TSetup) => vscode.WorkspaceFolder;
  resolveCourseTraceRunOptions: (
    services: AppServices,
    resource: vscode.Uri,
    base: ContinuousIterationRunOptions
  ) => Promise<TRunOptions | undefined>;
  runGeneratorAndCollectAsms: (
    services: AppServices,
    setup: TSetup,
    options: { revealOutput: false; signal?: AbortSignal }
  ) => Promise<ContinuousGeneratedBatch<TAsmCase> | undefined>;
  expandTraceCases: (asms: vscode.Uri[], asmCases?: TAsmCase[]) => Promise<TCase[]>;
  runCourseTraceCase: (
    services: AppServices,
    item: TCase,
    options: TRunOptions & ContinuousIterationRunOptions
  ) => Promise<CourseTraceCaseResult>;
}

let activeContinuousTraceSession: ContinuousTraceSession | undefined;
let continuousTraceStartReserved = false;
let continuousTraceStartupStopRequested = false;
const continuousMonitorFlushIntervalMs = 1000;

export async function startContinuousGeneratedTraceTests<TSetup, TCase extends ContinuousTraceCaseLike, TAsmCase, TRunOptions extends object>(
  services: AppServices,
  deps: ContinuousGeneratedTraceDependencies<TSetup, TCase, TAsmCase, TRunOptions>
): Promise<void> {
  const sessionLease = tryAcquireCourseTestSession('continuous');
  if (!sessionLease || activeContinuousTraceSession || continuousTraceStartReserved) {
    sessionLease?.release();
    vscode.window.showWarningMessage('已有一个测试任务正在运行');
    return;
  }

  continuousTraceStartReserved = true;
  continuousTraceStartupStopRequested = false;
  let session: ContinuousTraceSession | undefined;
  try {
    await vscode.workspace.saveAll(false);
    if (continuousTraceStartupStopRequested) {
      return;
    }
    const setup = await deps.resolveGeneratorRunSetup();
    if (!setup || continuousTraceStartupStopRequested) {
      return;
    }
    const resource = deps.generatorResource(setup);
    if (!await ensureContinuousTraceToolchainReady(services, resource)) {
      return;
    }
    if (continuousTraceStartupStopRequested) {
      return;
    }
    const baseRunOptions = await deps.resolveCourseTraceRunOptions(services, resource, {
      revealOutput: false,
      artifactOutputMode: 'case',
      source: { kind: 'generator' }
    });
    if (!baseRunOptions || continuousTraceStartupStopRequested) {
      return;
    }

    const automaticPolicy = deps.automaticPolicy?.() ?? continuousAutomaticTestPolicy;
    const { intervalMs, maxIterations, stopOnFailure } = automaticPolicy;
    const retention: ContinuousTraceRetention = {
      retainedPassingCases: automaticPolicy.retainedPassingCases,
      reportRetainedIterations: automaticPolicy.reportRetainedIterations
    };
    const outDir = vscode.Uri.file(path.join(deps.generatorFolder(setup).uri.fsPath, CO_OUT_DIR));
    await ensureDirectory(outDir);
    if (continuousTraceStartupStopRequested) {
      return;
    }
    const reportFile = vscode.Uri.file(path.join(outDir.fsPath, 'continuous-trace-report.json'));
    const panel = vscode.window.createWebviewPanel('coContinuousTraceReport', '持续测试', vscode.ViewColumn.Beside, {
      enableScripts: false,
      retainContextWhenHidden: true
    });
    session = {
      stopRequested: false,
      abortController: new AbortController(),
      reportFile,
      panel,
      lastMonitorFlushMs: 0,
      retainedPassingArtifacts: [],
      retention,
      report: {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        running: true,
        stopRequested: false,
        totalIterations: 0,
        iterations: []
      }
    };
    activeContinuousTraceSession = session;
    continuousTraceStartReserved = false;
    continuousTraceStartupStopRequested = false;
    panel.onDidDispose(() => requestContinuousTraceStop(session!));

    services.output.appendLine('');
    services.output.appendLine('正在启动持续测试');

    await updateContinuousTraceMonitor(session, { force: true });
    let index = 0;
    while (!session.stopRequested && (maxIterations === 0 || index < maxIterations)) {
      index++;
      session.report.totalIterations = index;
      services.statusBar.text = `CO: 持续测试 #${index}`;
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
      services.output.appendLine(`持续测试第 ${index} 轮`);
      let iterationLevelError = false;
      try {
        const generated = await deps.runGeneratorAndCollectAsms(services, setup, {
          revealOutput: false,
          signal: session.abortController.signal
        });
        if (!generated?.asms.length) {
          iteration.status = 'error';
          iteration.message = '未能准备新的自动测试点';
          iterationLevelError = true;
          services.output.appendLine(iteration.message);
        } else {
          iteration.source = { kind: 'generator' };
          const cases = await deps.expandTraceCases(generated.asms, generated.asmCases);
          for (let i = 0; i < cases.length; i++) {
            if (session.stopRequested) {
              break;
            }
            const item = cases[i];
            services.output.appendLine(`[第 ${index} 轮，测试点 ${i + 1}/${cases.length}] 正在验证`);
            let result: CourseTraceCaseResult;
            try {
              result = await deps.runCourseTraceCase(services, item, {
                ...baseRunOptions,
                revealOutput: false,
                source: generated.source,
                signal: session.abortController.signal
              });
            } catch (error) {
              if (session.stopRequested) {
                iteration.status = 'stopped';
                break;
              }
              result = {
                asm: item.asm.fsPath,
                stdin: item.stdin?.fsPath,
                ...(item.asmCase ? {
                  caseId: item.asmCase.id,
                  caseManifest: item.asmCase.manifestUri.fsPath,
                  asmSnapshot: item.asmCase.asm.fsPath
                } : {}),
                status: 'error',
                stage: 'internal',
                message: error instanceof Error ? error.message : String(error)
              };
            }
            result = neutralCourseTraceCaseResult(result);
            try {
              await recordAsmCaseTestOutcome(result.caseManifest, {
                status: result.status,
                stage: neutralCourseTraceStage(result.stage),
                diagnostic: publicAutomaticDiagnosticMessage(result)
              });
            } catch {
              services.output.appendLine('测试历史结果保存失败');
            }
            if (session.stopRequested && result.cancelled) {
              iteration.status = 'stopped';
              break;
            }
            iteration.results.push(result);
            addContinuousResult(iteration.summary, result);
            iteration.status = continuousStatusFromCounts(iteration.summary, true, session.stopRequested);
            await updateContinuousTraceMonitor(session);
            if (shouldStopAfterIterationCounts(iteration.summary, stopOnFailure)) {
              break;
            }
          }
          iteration.status = continuousStatusFromCounts(iteration.summary, false, session.stopRequested);
        }
      } catch (error) {
        iteration.status = 'error';
        iteration.message = error instanceof Error ? error.message : String(error);
        iterationLevelError = true;
      }

      iteration.finishedAt = new Date().toISOString();
      if (iteration.status === 'running') {
        iteration.status = continuousStatusFromCounts(iteration.summary, false, session.stopRequested);
      }
      await applyContinuousRetention(session, iteration);
      await updateContinuousTraceMonitor(session, { force: true });

      const reachedMaxIterations = maxIterations > 0 && index >= maxIterations;
      if (
        session.stopRequested
        || iterationLevelError
        || shouldStopAfterIterationCounts(iteration.summary, stopOnFailure)
        || reachedMaxIterations
      ) {
        break;
      }
      await waitForNextContinuousIteration(session, intervalMs);
    }
  } finally {
    continuousTraceStartReserved = false;
    continuousTraceStartupStopRequested = false;
    if (session) {
      session.report.running = false;
      session.report.stopRequested = session.stopRequested;
      services.statusBar.text = 'CO: 持续测试已停止';
      try {
        await updateContinuousTraceMonitor(session, { force: true });
      } catch {
        services.output.appendLine('持续测试最终报告写入失败');
      } finally {
        if (activeContinuousTraceSession === session) {
          activeContinuousTraceSession = undefined;
        }
      }
    }
    sessionLease.release();
  }
}

export function stopContinuousTests(): void {
  const state = requestContinuousTestsStop();
  if (state === 'none') {
    vscode.window.showInformationMessage('当前没有正在运行的持续测试');
    return;
  }
  vscode.window.showInformationMessage(state === 'starting'
    ? '已请求取消正在启动的持续测试'
    : '已请求取消当前工具并停止持续测试');
}

/** Quiet primitive used by the public stop-continuous-test facade. */
export function requestContinuousTestsStop(): 'none' | 'starting' | 'running' {
  if (activeContinuousTraceSession) {
    requestContinuousTraceStop(activeContinuousTraceSession);
    return 'running';
  }
  if (continuousTraceStartReserved) {
    continuousTraceStartupStopRequested = true;
    return 'starting';
  }
  return 'none';
}

function requestContinuousTraceStop(session: ContinuousTraceSession): void {
  session.stopRequested = true;
  session.report.stopRequested = true;
  session.abortController.abort();
  session.wakeIntervalWait?.();
}

async function ensureContinuousTraceToolchainReady(services: AppServices, resource: vscode.Uri): Promise<boolean> {
  services.output.appendLine('');
  services.output.appendLine('正在检查持续测试工具链');

  const profile = await ensureConcreteProfile(resource, '持续测试需要先确定项目 Profile');
  if (!profile) {
    return false;
  }
  const engineMode = automaticTestEngineMode;
  const memoryConfiguration = getMemoryConfiguration(resource);
  const configurationError = courseTraceMemoryConfigurationErrorForEngine(profile, engineMode, memoryConfiguration);
  if (configurationError) {
    services.output.appendLine(configurationError);
    vscode.window.showErrorMessage(configurationError);
    return false;
  }

  const checks = await checkToolchain(services.output, resource, {
    nonInteractive: true,
    engineMode: automaticTestEngineMode
  });
  const required = requiredCourseTraceToolchainChecks(profile, engineMode, memoryConfiguration);
  const failed = requiredToolchainFailures(checks, required);
  if (!failed.length) {
    return true;
  }

  const message = `持续测试工具链检查失败：${failed.map(formatAutomaticToolchainFailure).join('；')}`;
  services.output.appendLine(message);
  vscode.window.showErrorMessage(message);
  return false;
}

async function updateContinuousTraceMonitor(session: ContinuousTraceSession, options: { force?: boolean } = {}): Promise<void> {
  session.report.stopRequested = session.stopRequested;
  session.report.generatedAt = new Date().toISOString();
  const now = Date.now();
  if (!options.force && now - session.lastMonitorFlushMs < continuousMonitorFlushIntervalMs) {
    return;
  }
  session.lastMonitorFlushMs = now;
  await writeTextFile(
    session.reportFile,
    JSON.stringify(publicContinuousTraceReport(session.report), null, 2) + '\n'
  );
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
    result.oracleOut,
    result.dutOut,
    result.dutRawOut,
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
  delete result.oracleOut;
  delete result.dutOut;
  delete result.dutRawOut;
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
    && path.basename(path.dirname(path.dirname(resolved))).toLowerCase() === CO_DIR
    && path.basename(resolved).length > 0;
}

function isSafeContinuousOutFile(file: string): boolean {
  const resolved = path.resolve(file);
  return path.basename(path.dirname(resolved)).toLowerCase() === 'out'
    && path.basename(path.dirname(path.dirname(resolved))).toLowerCase() === CO_DIR;
}

function isPathInside(file: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  return relative === '' || Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function waitForNextContinuousIteration(session: ContinuousTraceSession, ms: number): Promise<void> {
  if (session.stopRequested) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (session.wakeIntervalWait === finish) {
        session.wakeIntervalWait = undefined;
      }
      resolve();
    };
    session.wakeIntervalWait = finish;
    if (session.stopRequested) {
      finish();
      return;
    }
    timer = setTimeout(finish, ms);
  });
}
