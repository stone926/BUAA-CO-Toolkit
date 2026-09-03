// @index generator-workflow — ASM测试生成器setup/运行/产物收集
import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ensureConcreteProfile,
  getAutomaticTestInstructions,
  getGeneratedAsmLimit,
  getGeneratorArgs,
  getJava,
  resolvePython
} from '../config';
import {
  AsmCase,
  createAsmCaseFromText
} from '../asmCaseStore';
import { discardContinuousGeneratedAsmCase } from './continuousCaseRetention';
import {
  BuiltinAsmGeneratorError,
  generateBuiltinAsmTestCase,
  type P7ProbeShard,
  type P7StressMode
} from './builtinAsmGenerator';
import { automaticProbeShards, probeVariantCount } from './builtinAsm/p7/probeVariants';
import {
  buildGeneratorInvocation,
  changedAsmFiles,
  GeneratorInvocation,
  isSupportedGeneratorFile,
  snapshotAsmFiles
} from './generator';
import { CourseTraceBatchSource } from '../courseTestReport';
import { workspaceFolderForOrFirst } from '../fsUtil';
import { revealOutputChannel, runTool } from '../process';
import { AppServices, ProjectProfile } from '../types';
import { resolveFileInput } from '../workflowInputs';
import {
  automaticTestEngineMode,
  automaticTestPolicy
} from './automaticTestPolicy';
import { resolveCourseEnginePlan } from '../mips/providers/courseEnginePolicy';

export type GeneratorRunSetup = ExternalGeneratorRunSetup | BuiltinGeneratorRunSetup;

export interface ExternalGeneratorRunSetup {
  kind: 'external';
  folder: vscode.WorkspaceFolder;
  generator: vscode.Uri;
  invocation: GeneratorInvocation;
}

export interface BuiltinGeneratorRunSetup {
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

export interface GeneratedAsmBatch {
  asms: vscode.Uri[];
  source: CourseTraceBatchSource;
  asmCases?: AsmCase[];
}

export interface GeneratorRunOptions {
  revealOutput?: boolean;
  signal?: AbortSignal;
  continuous?: {
    sessionId: string;
    iteration: number;
  };
}

export interface ResolveGeneratedAsmBatchOptions {
  resolveAsmBatchInputs: () => Promise<vscode.Uri[]>;
}

export async function resolveGeneratedAsmBatch(
  services: AppServices,
  _options: ResolveGeneratedAsmBatchOptions
): Promise<GeneratedAsmBatch | undefined> {
  const setup = await resolveGeneratorRunSetup();
  if (!setup) {
    return undefined;
  }
  // The public automatic facade stays quiet even when the generic run setting asks
  // manual tools to reveal their output panel. Failures are surfaced by the compact
  // automatic-test report instead.
  const generated = await runGeneratorAndCollectAsms(services, setup, { revealOutput: false });
  if (generated) {
    return generated;
  }
  return undefined;
}

export async function resolveGeneratorRunSetup(): Promise<GeneratorRunSetup | undefined> {
  const folder = workspaceFolderForOrFirst(vscode.window.activeTextEditor?.document.uri);
  if (!folder) {
    vscode.window.showErrorMessage('运行测试生成器前请先打开一个工作区文件夹');
    return undefined;
  }

  const resource = vscode.window.activeTextEditor?.document.uri ?? folder.uri;
  const profile = await ensureConcreteProfile(resource, '运行测试生成器需要先确定项目 Profile');
  if (!profile) {
    return undefined;
  }
  const policy = automaticTestPolicy(profile);
  return {
    kind: 'builtin',
    folder,
    resource,
    profile,
    instructionText: getAutomaticTestInstructions(resource),
    instructionCount: policy.instructionCount,
    interrupt: policy.interrupt,
    p7StressMode: policy.p7StressMode,
    timerInterrupt: policy.timerInterrupt,
    externalInterruptIntensity: policy.externalInterruptIntensity,
    timerIntensity: policy.timerIntensity,
    probeScenarioCount: policy.probeScenarioCount,
    exceptionRate: policy.exceptionRate,
    exceptionTypes: [...policy.exceptionTypes]
  };
}

export async function runGeneratorAndCollectAsms(
  services: AppServices,
  setup: GeneratorRunSetup,
  options: GeneratorRunOptions = {}
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
    resource: setup.generator,
    signal: options.signal
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

export function generatorResource(setup: GeneratorRunSetup): vscode.Uri {
  return setup.kind === 'external' ? setup.generator : setup.resource;
}

export function generatorFolder(setup: GeneratorRunSetup): vscode.WorkspaceFolder {
  return setup.folder;
}

export function generatorLabel(setup: GeneratorRunSetup): string {
  return setup.kind === 'external' ? setup.generator.fsPath : 'builtin:random-asm';
}

export function generatorCommandLine(setup: GeneratorRunSetup): string {
  if (setup.kind === 'external') {
    return [setup.invocation.command, ...setup.invocation.args].join(' ');
  }
  const instructionArg = setup.instructionText.trim() ? ` --instructions "${setup.instructionText.trim()}"` : ' --instructions <profile-default>';
  return `builtin-random-asm --profile ${setup.profile} --count ${setup.instructionCount}${instructionArg}`;
}

export function generatorCwd(setup: GeneratorRunSetup): string {
  return setup.kind === 'external' ? setup.invocation.cwd : path.join(setup.folder.uri.fsPath, '.co', 'cases');
}

export function generatorSource(
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

async function runBuiltinGeneratorAndCollectAsms(
  services: AppServices,
  setup: BuiltinGeneratorRunSetup,
  options: GeneratorRunOptions = {}
): Promise<GeneratedAsmBatch | undefined> {
  const generatedAt = new Date();
  const specs = builtinGenerationSpecs(setup);
  const enginePlan = resolveCourseEnginePlan(automaticTestEngineMode, setup.profile);
  const asms: vscode.Uri[] = [];
  const asmCases: AsmCase[] = [];
  try {
    for (const spec of specs) {
      if (options.signal?.aborted) {
        throw new Error('continuous builtin generation cancelled');
      }
      const mode = spec.mode;
      const generated = generateBuiltinAsmTestCase({
        profile: setup.profile,
        instructionText: setup.instructionText,
        instructionCount: setup.instructionCount,
        generatedAt,
        interrupt: setup.interrupt && mode !== 'off' && spec.probeShard !== 'timer',
        p7StressMode: mode,
        timerInterrupt: mode === 'probe' && setup.timerInterrupt,
        externalInterruptIntensity: setup.externalInterruptIntensity,
        timerIntensity: setup.timerIntensity,
        probeScenarioCount: spec.probeScenarioCount ?? setup.probeScenarioCount,
        probeShard: spec.probeShard,
        exceptionRate: mode === 'probe' ? 0 : setup.exceptionRate,
        exceptionTypes: setup.exceptionTypes
      });
      // File names are intentionally opaque. Exact mode/shard provenance belongs in the
      // immutable case manifest, not in the public automatic-test surface.
      const fileName = builtinAsmFileName(generated.profile, generatedAt);
      const asmCase = await createAsmCaseFromText(fileName, generated.text, {
        resource: setup.resource,
        source: {
          kind: 'builtin',
          generator: 'builtin:random-asm',
          commandLine: generatorCommandLine(setup),
          cwd: generatorCwd(setup)
        },
        createdAt: generatedAt,
        enginePlan,
        p7: {
          interruptSchedule: generated.interruptSchedule,
          probe: generated.probe
        },
        metadata: {
          'source.generatedName': fileName,
          'source.seed': generated.seed,
          'source.mode': generated.mode ?? mode ?? 'default',
          'source.instructionCount': String(generated.instructionCount),
          ...(spec.probeShard ? { 'source.probeShard': spec.probeShard } : {}),
          ...(options.continuous ? {
            'continuous.sessionId': options.continuous.sessionId,
            'continuous.iteration': String(options.continuous.iteration),
            'continuous.state': 'generated'
          } : {})
        }
      });
      asms.push(asmCase.sourceAsm);
      asmCases.push(asmCase);
      if (options.signal?.aborted) {
        throw new Error('continuous builtin generation cancelled');
      }
    }
  } catch (error) {
    if (options.continuous) {
      for (const asmCase of asmCases) {
        await discardContinuousGeneratedAsmCase(
          asmCase.manifestUri.fsPath,
          options.continuous.sessionId
        ).catch(() => false);
      }
    }
    if (options.signal?.aborted) {
      return undefined;
    }
    const message = publicBuiltinGeneratorFailure(error);
    vscode.window.showErrorMessage(message);
    if (options.revealOutput !== false) {
      revealOutputChannel(services.output, setup.folder.uri);
    }
    services.output.appendLine('');
    services.output.appendLine(message);
    return undefined;
  }

  if (options.revealOutput !== false) {
    revealOutputChannel(services.output, setup.folder.uri);
  }
  services.output.appendLine('');
  services.output.appendLine('自动测试点已准备');

  return {
    asms,
    source: generatorSource(setup, asms),
    asmCases
  };
}

function publicBuiltinGeneratorFailure(error: unknown): string {
  if (error instanceof BuiltinAsmGeneratorError
    && /^Invalid built-in ASM generator instruction set:/i.test(error.message)) {
    const detail = error.message
      .replace(/^Invalid built-in ASM generator instruction set:\s*/i, '')
      .replace(/\.$/, '');
    return `自动测试指令集无效：${detail}`;
  }
  return '自动测试点准备失败；请检查 co.test.instructions 后重试';
}

interface BuiltinGenerationSpec {
  mode: P7StressMode | undefined;
  probeShard?: P7ProbeShard;
  probeScenarioCount?: number;
}

function builtinGenerationSpecs(setup: BuiltinGeneratorRunSetup): BuiltinGenerationSpec[] {
  if (setup.profile !== 'P7') {
    return [{ mode: undefined }];
  }
  if (setup.p7StressMode !== 'probe' && setup.p7StressMode !== 'hybrid') {
    return [{ mode: setup.p7StressMode }];
  }

  const probes: BuiltinGenerationSpec[] = automaticProbeShards.flatMap((probeShard) => {
    const count = (['external', 'adel', 'ades', 'syscall', 'ri', 'ov', 'timer0', 'timer1'] as const)
      .filter((kind) => setup.timerInterrupt || (kind !== 'timer0' && kind !== 'timer1'))
      .filter((kind) => setup.interrupt || kind !== 'external')
      .reduce((total, kind) => total + probeVariantCount(kind, probeShard), 0);
    return count ? [{
      mode: 'probe' as const,
      probeShard,
      probeScenarioCount: probeShard === 'core' ? Math.max(count, setup.probeScenarioCount) : count
    }] : [];
  });
  return setup.p7StressMode === 'hybrid'
    ? [{ mode: 'anchor' }, ...probes]
    : probes;
}

function builtinAsmFileName(profile: string, generatedAt: Date): string {
  const timestamp = generatedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = randomBytes(3).toString('hex');
  return `builtin-${profile.toLowerCase()}-${timestamp}-${suffix}.asm`;
}

async function resolveGeneratorInput(folder: vscode.WorkspaceFolder): Promise<vscode.Uri | undefined> {
  return await resolveFileInput({
    title: '选择随机测试生成器',
    active: {
      predicate: (uri) => isSupportedGeneratorFile(uri.fsPath),
      saveDirty: true
    },
    folder,
    include: '**/*.{py,js,mjs,cjs,jar,bat,cmd,exe,ps1}',
    exclude: '**/{node_modules,out,.git,.co}/**',
    maxResults: 200,
    filters: {
    Generator: ['py', 'js', 'mjs', 'cjs', 'jar', 'bat', 'cmd', 'exe', 'ps1'],
    All: ['*']
    }
  });
}
