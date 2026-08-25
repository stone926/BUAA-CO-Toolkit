// @index generator-workflow — ASM测试生成器setup/运行/产物收集
import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ensureConcreteProfile,
  getBuiltinGeneratorInstructionCount,
  getBuiltinGeneratorInstructions,
  getBuiltinGeneratorP7InstructionCount,
  getGeneratedAsmLimit,
  getGeneratorArgs,
  getJava,
  getP7ExceptionRate,
  getP7ExceptionTypes,
  getP7ExternalInterruptIntensity,
  getP7InterruptEnabled,
  getP7ProbeScenarioCount,
  getP7StressMode,
  getP7TimerIntensity,
  getP7TimerInterruptEnabled,
  P7StressMode,
  resolvePython,
  useBuiltinTestGenerator
} from '../config';
import {
  AsmCase,
  createAsmCaseFromText,
  updateAsmCaseMetadata
} from '../asmCaseStore';
import {
  BuiltinAsmGeneratorError,
  generateBuiltinAsmTestCase
} from './builtinAsmGenerator';
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
import { resolveActiveFile, resolveFileInput } from '../workflowInputs';

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

export interface ResolveGeneratedAsmBatchOptions {
  resolveAsmBatchInputs: () => Promise<vscode.Uri[]>;
}

export async function resolveGeneratedAsmBatch(
  services: AppServices,
  options: ResolveGeneratedAsmBatchOptions
): Promise<GeneratedAsmBatch | undefined> {
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
  const picked = await options.resolveAsmBatchInputs();
  if (!picked.length) {
    return undefined;
  }
  return {
    asms: picked,
    source: generatorSource(setup, picked)
  };
}

export async function resolveGeneratorRunSetup(): Promise<GeneratorRunSetup | undefined> {
  const folder = workspaceFolderForOrFirst(vscode.window.activeTextEditor?.document.uri);
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

export async function runGeneratorAndCollectAsms(
  services: AppServices,
  setup: GeneratorRunSetup,
  options: { revealOutput?: boolean } = {}
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
  options: { revealOutput?: boolean } = {}
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
      await updateAsmCaseMetadata(asmCase, {
        'source.generatedName': fileName,
        'source.seed': generated.seed,
        'source.mode': generated.mode ?? mode ?? 'default'
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
    services.output.appendLine(`ASM: ${asms[i].fsPath}`);
  }

  return {
    asms,
    source: generatorSource(setup, asms),
    asmCases
  };
}

async function resolveActiveGeneratorInput(): Promise<vscode.Uri | undefined> {
  return await resolveActiveFile({
    predicate: (uri) => isSupportedGeneratorFile(uri.fsPath),
    saveDirty: true
  });
}

function builtinInstructionCountForProfile(profile: ProjectProfile, resource: vscode.Uri): number {
  if (profile === 'P7') {
    return getBuiltinGeneratorP7InstructionCount(resource);
  }
  return getBuiltinGeneratorInstructionCount(resource);
}

function builtinAsmFileName(profile: string, generatedAt: Date, mode?: string): string {
  const timestamp = generatedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = randomBytes(3).toString('hex');
  const modePart = mode ? `-${mode}` : '';
  return `builtin-${profile.toLowerCase()}${modePart}-${timestamp}-${suffix}.asm`;
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
