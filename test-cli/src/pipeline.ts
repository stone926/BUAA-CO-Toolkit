import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  recordAsmCaseTestOutcome,
  type AsmCase
} from '../../src/asmCaseStore';
import { getMemoryConfiguration } from '../../src/config';
import type { CourseTraceCaseInput } from '../../src/courseTestCases';
import type {
  ContinuousTraceIteration,
  ContinuousTraceReport,
  CourseTraceCaseResult
} from '../../src/courseTestReport';
import {
  neutralCourseTraceStage,
  publicAutomaticDiagnosticMessage,
  publicContinuousTraceReport
} from '../../src/courseTestReport';
import {
  courseTraceMemoryConfigurationErrorForEngine,
  requiredCourseTraceToolchainChecks,
  requiredToolchainFailures
} from '../../src/courseTestToolchain';
import {
  automaticTestEngineMode,
  continuousAutomaticTestPolicy
} from '../../src/courseTesting/automaticTestPolicy';
import {
  addContinuousResult,
  continuousStatusFromCounts,
  createContinuousCounts,
  pruneContinuousIterations,
  shouldStopAfterIterationCounts
} from '../../src/courseTesting/continuous';
import type { ContinuousCounts } from '../../src/courseTesting/continuous';
import {
  resolveGeneratorRunSetup,
  runGeneratorAndCollectAsms
} from '../../src/courseTesting/generatorWorkflow';
import { runCourseTraceCase } from '../../src/courseTesting/traceRunner';
import { checkToolchain } from '../../src/toolchain';
import type { AppServices } from '../../src/types';

/**
 * Public CLI inputs deliberately contain no coverage, scheduling, retention, seed, or
 * simulation-duration controls. Those are owned by the shared automatic-test policy.
 */
export interface ContinuousPipelineOptions {
  projectRoot: string;
  reportFile: string;
}

export interface ContinuousPipelineResult {
  /** The result returned to callers has already crossed the public-report boundary. */
  report: ContinuousTraceReport;
  status: 'passed' | 'failed' | 'error';
  summary: ContinuousCounts;
}

interface Session {
  stopRequested: boolean;
  abortController: AbortController;
  wakeIntervalWait?: () => void;
}

interface RetainedCaseArtifact {
  caseDir?: string;
  result: CourseTraceCaseResult;
}

export interface ContinuousPipelineController {
  result: Promise<ContinuousPipelineResult>;
  requestStop(): void;
}

export async function runContinuousP7Pipeline(
  services: AppServices,
  options: ContinuousPipelineOptions
): Promise<ContinuousPipelineResult> {
  return await startContinuousP7Pipeline(services, options).result;
}

export function startContinuousP7Pipeline(
  services: AppServices,
  options: ContinuousPipelineOptions
): ContinuousPipelineController {
  const session: Session = { stopRequested: false, abortController: new AbortController() };
  return {
    result: runContinuousP7PipelineWithSession(services, options, session),
    requestStop: () => {
      session.stopRequested = true;
      session.abortController.abort();
      session.wakeIntervalWait?.();
    }
  };
}

async function runContinuousP7PipelineWithSession(
  services: AppServices,
  options: ContinuousPipelineOptions,
  session: Session
): Promise<ContinuousPipelineResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const resource = vscode.Uri.file(projectRoot);
  await ensureP7ToolchainReady(services, resource);

  // The shared resolver is the single source of truth for maximum instruction count,
  // full P7 exception/interrupt coverage, and anchor/core-probe/timer-probe expansion.
  const setup = await resolveGeneratorRunSetup();
  if (!setup
    || setup.kind !== 'builtin'
    || setup.profile !== 'P7'
    || normalizePath(setup.folder.uri.fsPath) !== normalizePath(projectRoot)) {
    throw new Error('自动测试点准备失败；请检查项目 Profile 和指令集配置');
  }
  const policy = continuousAutomaticTestPolicy;
  const report: ContinuousTraceReport = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    running: true,
    stopRequested: false,
    totalIterations: 0,
    iterations: []
  };

  const retainedArtifacts: RetainedCaseArtifact[] = [];
  const totalSummary = createContinuousCounts();

  services.output.appendLine('');
  services.output.appendLine('正在启动持续测试');
  await writePublicReport(options.reportFile, report);

  let index = 0;
  while (!session.stopRequested && (policy.maxIterations === 0 || index < policy.maxIterations)) {
    index++;
    report.totalIterations = index;
    const iteration: ContinuousTraceIteration = {
      index,
      status: 'running',
      startedAt: new Date().toISOString(),
      summary: createContinuousCounts(),
      results: []
    };
    report.iterations.unshift(iteration);
    await writePublicReport(options.reportFile, report);

    services.output.appendLine('');
    services.output.appendLine(`持续测试第 ${index} 轮`);
    let iterationLevelError = false;
    try {
      const generated = await runGeneratorAndCollectAsms(services, setup, {
        revealOutput: false,
        signal: session.abortController.signal
      });
      if (!generated?.asms.length) {
        throw new Error('未能准备新的自动测试点');
      }
      iteration.source = { kind: 'generator' };
      const cases = generatedCases(generated.asms, generated.asmCases);

      for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
        if (session.stopRequested) {
          break;
        }
        const item = cases[caseIndex];
        services.output.appendLine(`[第 ${index} 轮，测试点 ${caseIndex + 1}/${cases.length}] 正在验证`);
        let result: CourseTraceCaseResult;
        try {
          result = await runCourseTraceCase(services, item, {
            revealOutput: false,
            source: generated.source,
            artifactOutputMode: 'case',
            signal: session.abortController.signal
          });
        } catch (error) {
          if (session.stopRequested) {
            iteration.status = 'stopped';
            break;
          }
          result = {
            asm: item.asm.fsPath,
            caseId: item.asmCase?.id,
            caseManifest: item.asmCase?.manifestUri.fsPath,
            asmSnapshot: item.asmCase?.asm.fsPath,
            status: 'error',
            stage: 'internal',
            message: error instanceof Error ? error.message : String(error)
          };
        }
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
        addContinuousResult(totalSummary, result);
        iteration.status = continuousStatusFromCounts(iteration.summary, true, session.stopRequested);
        await writePublicReport(options.reportFile, report);
        if (shouldStopAfterIterationCounts(iteration.summary, policy.stopOnFailure)) {
          break;
        }
      }

      iteration.status = continuousStatusFromCounts(iteration.summary, false, session.stopRequested);
    } catch (error) {
      iteration.status = 'error';
      iteration.message = error instanceof Error ? error.message : String(error);
      iterationLevelError = true;
      totalSummary.errors++;
      services.output.appendLine('本轮自动测试未完成');
    }

    iteration.finishedAt = new Date().toISOString();
    if (iteration.status === 'running') {
      iteration.status = continuousStatusFromCounts(iteration.summary, false, session.stopRequested);
    }
    await applyRetention(
      report,
      iteration,
      retainedArtifacts,
      policy.retainedPassingCases,
      policy.reportRetainedIterations,
      path.join(projectRoot, '.co', 'cases')
    );
    await writePublicReport(options.reportFile, report);

    const reachedMaxIterations = policy.maxIterations > 0 && index >= policy.maxIterations;
    if (
      session.stopRequested
      || iterationLevelError
      || shouldStopAfterIterationCounts(iteration.summary, policy.stopOnFailure)
      || reachedMaxIterations
    ) {
      break;
    }
    await waitForInterval(session, policy.intervalMs);
  }

  report.running = false;
  report.stopRequested = session.stopRequested;
  report.generatedAt = new Date().toISOString();
  await writePublicReport(options.reportFile, report);

  const status = totalSummary.errors > 0
    ? 'error'
    : totalSummary.failed > 0
      ? 'failed'
      : 'passed';
  return { report: publicContinuousTraceReport(report), status, summary: totalSummary };
}

async function ensureP7ToolchainReady(
  services: AppServices,
  resource: vscode.Uri
): Promise<void> {
  services.output.appendLine('');
  services.output.appendLine('正在检查持续测试工具链');
  const profile = 'P7' as const;
  const engineMode = automaticTestEngineMode;
  const memoryConfiguration = getMemoryConfiguration(resource);
  const configurationError = courseTraceMemoryConfigurationErrorForEngine(
    profile,
    engineMode,
    memoryConfiguration
  );
  if (configurationError) {
    throw new Error('自动测试工具链配置不兼容；请检查项目工具链设置');
  }
  const checks = await checkToolchain(services.output, resource, {
    nonInteractive: true,
    engineMode: automaticTestEngineMode,
    extensionRoot: services.extensionRoot
  });
  const required = requiredCourseTraceToolchainChecks(profile, engineMode, memoryConfiguration);
  if (requiredToolchainFailures(checks, required).length) {
    throw new Error('自动测试工具链检查失败；请检查项目工具链设置');
  }
}

function generatedCases(asms: vscode.Uri[], asmCases?: AsmCase[]): CourseTraceCaseInput[] {
  if (asmCases?.length) {
    return asmCases.map((asmCase) => ({ asm: asmCase.sourceAsm, asmCase }));
  }
  return asms.map((asm) => ({ asm }));
}

async function applyRetention(
  report: ContinuousTraceReport,
  iteration: ContinuousTraceIteration,
  retainedArtifacts: RetainedCaseArtifact[],
  retainedPassingCases: number,
  reportRetainedIterations: number,
  casesRoot: string
): Promise<void> {
  for (const result of iteration.results) {
    if (result.status !== 'passed') {
      continue;
    }
    const caseDir = caseDirFromManifest(result.caseManifest, casesRoot);
    if (caseDir) {
      retainedArtifacts.push({ caseDir, result });
    }
  }

  while (retainedArtifacts.length > retainedPassingCases) {
    const victim = retainedArtifacts.shift();
    if (!victim?.caseDir) {
      continue;
    }
    if (isProtectedCaseDir(report, retainedArtifacts, victim.caseDir, casesRoot)) {
      continue;
    }
    try {
      await fs.promises.rm(victim.caseDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
    markArtifactsPruned(victim.result);
  }

  report.iterations = pruneContinuousIterations(report.iterations, reportRetainedIterations);
}

function isProtectedCaseDir(
  report: ContinuousTraceReport,
  retainedArtifacts: RetainedCaseArtifact[],
  caseDir: string,
  casesRoot: string
): boolean {
  if (retainedArtifacts.some((item) => item.caseDir && normalizePath(item.caseDir) === normalizePath(caseDir))) {
    return true;
  }
  for (const iteration of report.iterations) {
    for (const result of iteration.results) {
      if (result.status === 'passed') {
        continue;
      }
      const protectedDir = caseDirFromManifest(result.caseManifest, casesRoot);
      if (protectedDir && normalizePath(protectedDir) === normalizePath(caseDir)) {
        return true;
      }
    }
  }
  return false;
}

function caseDirFromManifest(manifest: string | undefined, casesRoot: string): string | undefined {
  if (!manifest || path.basename(manifest).toLowerCase() !== 'case.json') {
    return undefined;
  }
  const resolved = path.resolve(path.dirname(manifest));
  const resolvedRoot = path.resolve(casesRoot);
  const relative = path.relative(resolvedRoot, resolved);
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
    && normalizePath(path.dirname(resolved)) === normalizePath(resolvedRoot)
    && path.basename(resolved).length > 0
    ? resolved
    : undefined;
}

function markArtifactsPruned(result: CourseTraceCaseResult): void {
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

function normalizePath(value: string): string {
  return path.resolve(value).toLowerCase();
}

async function waitForInterval(session: Session, ms: number): Promise<void> {
  if (session.stopRequested) {
    return;
  }
  // Even a zero-delay strongest policy yields once so SIGINT and I/O are not starved.
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
    timer = setTimeout(finish, Math.max(0, ms));
  });
}

async function writePublicReport(reportFile: string, report: ContinuousTraceReport): Promise<void> {
  await fs.promises.mkdir(path.dirname(reportFile), { recursive: true });
  report.generatedAt = new Date().toISOString();
  const publicReport = publicContinuousTraceReport(report);
  await fs.promises.writeFile(reportFile, `${JSON.stringify(publicReport, null, 2)}\n`, 'utf8');
}
