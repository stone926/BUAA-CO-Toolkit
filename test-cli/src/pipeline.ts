import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  BuiltinAsmGeneratorError,
  generateBuiltinAsmTestCase,
  resolveBuiltinInstructionSet
} from '../../src/courseTesting/builtinAsmGenerator';
import type {
  BuiltinAsmGeneratorResult,
  P7StressMode
} from '../../src/courseTesting/builtinAsmGenerator';
import {
  AsmCase,
  createAsmCaseFromText,
  updateAsmCaseMetadata
} from '../../src/asmCaseStore';
import {
  addContinuousResult,
  continuousStatusFromCounts,
  createContinuousCounts,
  pruneContinuousIterations,
  shouldStopAfterIterationCounts
} from '../../src/courseTesting/continuous';
import type { ContinuousCounts } from '../../src/courseTesting/continuous';
import {
  formatToolchainFailure,
  courseTraceMemoryConfigurationError,
  MARS_P7_CHECK,
  requiredToolchainFailures
} from '../../src/courseTestToolchain';
import type {
  ContinuousTraceIteration,
  ContinuousTraceReport,
  CourseTraceBatchSource,
  CourseTraceCaseResult
} from '../../src/courseTestReport';
import {
  CourseTraceRunOptions,
  runCourseTraceCase
} from '../../src/courseTesting/traceRunner';
import { checkToolchain } from '../../src/toolchain';
import { createIsimCompileCache } from '../../src/verilogIsimCache';
import type { AppServices } from '../../src/types';
import * as vscode from 'vscode';

export interface ContinuousPipelineOptions {
  projectRoot: string;
  instructions: string;
  instructionCount: number;
  intervalMs: number;
  maxIterations: number;
  stopOnFailure: boolean;
  retainedPassingCases: number;
  reportRetainedIterations: number;
  stressMode: P7StressMode;
  interrupt: boolean;
  timerInterrupt: boolean;
  externalInterruptIntensity: number;
  timerIntensity: number;
  probeScenarioCount: number;
  exceptionRate: number;
  exceptionTypes: string[];
  seed?: string;
  memoryConfiguration: string;
  checkToolchain: boolean;
  reportFile: string;
}

export interface ContinuousPipelineResult {
  report: ContinuousTraceReport;
  status: 'passed' | 'failed' | 'error';
  summary: ContinuousCounts;
}

interface GeneratedP7Case {
  asmCase: AsmCase;
  generated: BuiltinAsmGeneratorResult;
  mode: P7StressMode;
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

const generatorName = 'builtin:random-asm';

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
  if (!options.checkToolchain) {
    services.output.appendLine('已跳过工具链检查');
  } else {
    await ensureP7ToolchainReady(services, resource, options.memoryConfiguration);
  }

  const instructionSet = resolveBuiltinInstructionSet('P7', options.instructions);
  const commandLine = builtinCommandLine(options, instructionSet.mnemonics);
  const sourceBase: CourseTraceBatchSource = {
    kind: 'generator',
    generator: generatorName,
    commandLine,
    cwd: path.join(projectRoot, '.co', 'cases')
  };

  const report: ContinuousTraceReport = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    running: true,
    stopRequested: false,
    totalIterations: 0,
    generator: generatorName,
    commandLine,
    cwd: sourceBase.cwd ?? projectRoot,
    options: {
      intervalMs: options.intervalMs,
      maxIterations: options.maxIterations,
      stopOnFailure: options.stopOnFailure
    },
    retention: {
      retainedPassingCases: options.retainedPassingCases,
      reportRetainedIterations: options.reportRetainedIterations,
      artifactOutputMode: 'case'
    },
    iterations: []
  };

  const compileCache = createIsimCompileCache();
  const retainedArtifacts: RetainedCaseArtifact[] = [];
  const totalSummary = createContinuousCounts();

  services.output.appendLine('');
  services.output.appendLine('正在启动无头持续生成 P7 Trace 测试');
  services.output.appendLine(`项目: ${projectRoot}`);
  services.output.appendLine(`指令集: ${instructionSet.mnemonics.join(' ')}`);
  services.output.appendLine(`指令数: ${options.instructionCount}, 间隔: ${options.intervalMs} 毫秒, 最大轮数: ${options.maxIterations || '无限制'}, 失败时停止: ${options.stopOnFailure}`);
  services.output.appendLine(`报告: ${options.reportFile}`);

  await writeReport(options.reportFile, report);

  let index = 0;
  while (!session.stopRequested && (options.maxIterations === 0 || index < options.maxIterations)) {
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
    await writeReport(options.reportFile, report);

    services.output.appendLine('');
    services.output.appendLine(`Continuous iteration #${index}`);
    let iterationLevelError = false;
    try {
      const generatedCases = await generateP7CasesAsync(services, options, sourceBase, new Date());
      if (!generatedCases.length) {
        throw new Error('P7 内置生成器未产生任何测试点');
      }
      iteration.source = {
        ...sourceBase,
        asmFiles: generatedCases.map((item) => item.asmCase.sourceAsm.fsPath)
      };

      for (let i = 0; i < generatedCases.length; i++) {
        if (session.stopRequested) {
          break;
        }
        const { asmCase } = generatedCases[i];
        services.output.appendLine(`[iteration ${index}, case ${i + 1}/${generatedCases.length}] ${asmCase.sourceAsm.fsPath}`);
        let result: CourseTraceCaseResult;
        try {
          result = await runCourseTraceCase(services, { asm: asmCase.sourceAsm, asmCase }, {
            revealOutput: false,
            source: iteration.source,
            artifactOutputMode: 'case',
            isimCompileCache: compileCache,
            signal: session.abortController.signal
          } as CourseTraceRunOptions);
        } catch (error) {
          if (session.stopRequested) {
            iteration.status = 'stopped';
            break;
          }
          result = {
            asm: asmCase.sourceAsm.fsPath,
            caseId: asmCase.id,
            caseManifest: asmCase.manifestUri.fsPath,
            asmSnapshot: asmCase.asm.fsPath,
            status: 'error',
            stage: 'compare',
            message: error instanceof Error ? error.message : String(error)
          };
        }
        if (session.stopRequested && result.cancelled) {
          iteration.status = 'stopped';
          break;
        }
        iteration.results.push(result);
        addContinuousResult(iteration.summary, result);
        addContinuousResult(totalSummary, result);
        iteration.status = continuousStatusFromCounts(iteration.summary, true, session.stopRequested);
        await writeReport(options.reportFile, report);
      }

      iteration.status = continuousStatusFromCounts(iteration.summary, false, session.stopRequested);
    } catch (error) {
      iteration.status = 'error';
      iteration.message = error instanceof BuiltinAsmGeneratorError || error instanceof Error
        ? error.message
        : String(error);
      iterationLevelError = true;
      services.output.appendLine(`iteration #${index} 错误: ${iteration.message}`);
      totalSummary.errors++;
    }

    iteration.finishedAt = new Date().toISOString();
    if (iteration.status === 'running') {
      iteration.status = continuousStatusFromCounts(iteration.summary, false, session.stopRequested);
    }
    await applyRetention(report, iteration, retainedArtifacts, options.retainedPassingCases, options.reportRetainedIterations);
    await writeReport(options.reportFile, report);

    const reachedMaxIterations = options.maxIterations > 0 && index >= options.maxIterations;
    if (
      session.stopRequested
      || iterationLevelError
      || shouldStopAfterIterationCounts(iteration.summary, options.stopOnFailure)
      || reachedMaxIterations
    ) {
      break;
    }
    await waitForInterval(session, options.intervalMs);
  }

  report.running = false;
  report.stopRequested = session.stopRequested;
  report.generatedAt = new Date().toISOString();
  await writeReport(options.reportFile, report);

  const status = totalSummary.errors > 0
    ? 'error'
    : totalSummary.failed > 0
      ? 'failed'
      : 'passed';
  return { report, status, summary: totalSummary };
}

async function ensureP7ToolchainReady(
  services: AppServices,
  resource: vscode.Uri,
  memoryConfiguration: string
): Promise<void> {
  services.output.appendLine('');
  services.output.appendLine('正在检查 P7 持续生成 Trace 测试工具链');
  const configurationError = courseTraceMemoryConfigurationError('P7', memoryConfiguration);
  if (configurationError) {
    throw new Error(configurationError);
  }
  const checks = await checkToolchain(services.output, resource);
  const required = new Set([
    'Java',
    'MARS',
    'MARS coL2',
    'ISE fuse',
    `MARS ${memoryConfiguration}`,
    MARS_P7_CHECK
  ]);
  const failed = requiredToolchainFailures(checks, required);
  if (!failed.length) {
    return;
  }
  throw new Error(`P7 持续生成测试工具链检查失败：${failed.map(formatToolchainFailure).join('；')}`);
}

function builtinCommandLine(options: ContinuousPipelineOptions, mnemonics: readonly string[]): string {
  const parts = [
    'builtin-random-asm',
    '--profile P7',
    `--count ${options.instructionCount}`,
    `--stress-mode ${options.stressMode}`
  ];
  if (mnemonics.length) {
    parts.push(`--instructions ${JSON.stringify(mnemonics.join(' '))}`);
  }
  return parts.join(' ');
}

async function generateP7CasesAsync(
  services: AppServices,
  options: ContinuousPipelineOptions,
  sourceBase: CourseTraceBatchSource,
  generatedAt: Date
): Promise<GeneratedP7Case[]> {
  const modes: P7StressMode[] = options.stressMode === 'hybrid'
    ? ['anchor', 'probe']
    : [options.stressMode];
  const generatedCases: GeneratedP7Case[] = [];
  services.output.appendLine('');
  services.output.appendLine('正在运行内置随机 ASM 生成器');
  services.output.appendLine('Profile: P7');
  services.output.appendLine(`模式: ${modes.join(', ')}`);

  for (const mode of modes) {
    const generated = generateBuiltinAsmTestCase({
      profile: 'P7',
      instructionText: options.instructions,
      instructionCount: options.instructionCount,
      seed: options.seed ? `${options.seed}-${mode}` : undefined,
      generatedAt,
      interrupt: options.interrupt && mode !== 'off',
      p7StressMode: mode,
      timerInterrupt: mode === 'probe' && options.timerInterrupt,
      externalInterruptIntensity: options.externalInterruptIntensity,
      timerIntensity: options.timerIntensity,
      probeScenarioCount: options.probeScenarioCount,
      exceptionRate: mode === 'probe' ? 0 : options.exceptionRate,
      exceptionTypes: options.exceptionTypes
    });
    const fileName = builtinAsmFileName(generated.profile, generatedAt, generated.mode ?? mode);
    const asmCase = await createAsmCaseFromText(fileName, generated.text, {
      resource: vscode.Uri.file(options.projectRoot),
      source: {
        kind: 'builtin',
        generator: generatorName,
        commandLine: sourceBase.commandLine,
        cwd: sourceBase.cwd
      },
      createdAt: generatedAt,
      p7: {
        interruptSchedule: generated.interruptSchedule,
        probe: generated.probe
      }
    });
    await updateAsmCaseMetadata(asmCase, {
      'source.generatedName': fileName,
      'source.seed': generated.seed,
      'source.mode': generated.mode ?? mode ?? 'default'
    });
    services.output.appendLine(generated.mode === 'probe'
      ? `Probe 主程序指令数量: ${generated.instructionCount}（含固定终止尾部）`
      : `有效载荷指令数量: ${generated.instructionCount}（另有 2 条停机自环尾指令）`);
    services.output.appendLine(`指令集: ${generated.instructionSet.join(' ')}`);
    services.output.appendLine(`种子: ${generated.seed}`);
    if (generated.interruptSchedule.length) {
      services.output.appendLine(`外部中断目标 PC: ${generated.interruptSchedule.map((pc) => `0x${(pc >>> 0).toString(16)}`).join(', ')}`);
    }
    if (generated.probe) {
      services.output.appendLine(`Probe 场景: ${generated.probe.scenarios.map((scenario) => `${scenario.id}:${scenario.kind}`).join(', ')}`);
    }
    services.output.appendLine(`ASM: ${asmCase.sourceAsm.fsPath}`);
    generatedCases.push({ asmCase, generated, mode });
  }
  return generatedCases;
}

function builtinAsmFileName(profile: string, generatedAt: Date, mode?: string): string {
  const timestamp = generatedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = randomBytes(3).toString('hex');
  const modePart = mode ? `-${mode}` : '';
  return `builtin-${profile.toLowerCase()}${modePart}-${timestamp}-${suffix}.asm`;
}

async function applyRetention(
  report: ContinuousTraceReport,
  iteration: ContinuousTraceIteration,
  retainedArtifacts: RetainedCaseArtifact[],
  retainedPassingCases: number,
  reportRetainedIterations: number
): Promise<void> {
  for (const result of iteration.results) {
    if (result.status !== 'passed') {
      continue;
    }
    const caseDir = caseDirFromManifest(result.caseManifest);
    if (caseDir) {
      retainedArtifacts.push({ caseDir, result });
    }
  }

  while (retainedArtifacts.length > retainedPassingCases) {
    const victim = retainedArtifacts.shift();
    if (!victim?.caseDir) {
      continue;
    }
    if (isProtectedCaseDir(report, retainedArtifacts, victim.caseDir)) {
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
  caseDir: string
): boolean {
  if (retainedArtifacts.some((item) => item.caseDir && normalizePath(item.caseDir) === normalizePath(caseDir))) {
    return true;
  }
  for (const iteration of report.iterations) {
    for (const result of iteration.results) {
      if (result.status === 'passed') {
        continue;
      }
      const protectedDir = caseDirFromManifest(result.caseManifest);
      if (protectedDir && normalizePath(protectedDir) === normalizePath(caseDir)) {
        return true;
      }
    }
  }
  return false;
}

function caseDirFromManifest(manifest: string | undefined): string | undefined {
  if (!manifest || path.basename(manifest).toLowerCase() !== 'case.json') {
    return undefined;
  }
  const dir = path.dirname(manifest);
  const resolved = path.resolve(dir);
  return path.basename(path.dirname(resolved)).toLowerCase() === 'cases'
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
  if (session.stopRequested || ms <= 0) {
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
    timer = setTimeout(finish, ms);
  });
}

async function writeReport(reportFile: string, report: ContinuousTraceReport): Promise<void> {
  await fs.promises.mkdir(path.dirname(reportFile), { recursive: true });
  report.generatedAt = new Date().toISOString();
  await fs.promises.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
