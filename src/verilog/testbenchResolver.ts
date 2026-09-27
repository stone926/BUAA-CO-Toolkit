// @index verilog-testbench-resolver — Verilog testbench 发现、生成和 case 记录
import * as path from 'path';
import * as vscode from 'vscode';
import { CO_IVERILOG_DIR } from '../constants';
import {
  getProfile,
  getTestbench,
  getTopModule
} from '../config';
import {
  buildTestbench,
  moduleAtPosition,
  parseVerilog,
  VerilogModule
} from '../language/verilog/service';
import { ensureDirectory, isFile, pathExists, workspaceFolderFor, workspaceFolderForOrFirst, writeTextFile } from '../fsUtil';
import { AppServices } from '../types';
import { P7ProbeMetadata } from '../courseTesting/builtinAsmGenerator';
import type { MutableVerilogModuleProvider } from '../language/verilog/moduleProvider';
import type { ConcreteProjectProfile } from '../projectProfile';
import {
  AsmCase,
  copyAsmCaseArtifact,
  updateAsmCaseMetadata
} from '../asmCaseStore';
import { sha256Bytes } from '../asmCaseStoreCore';
import {
  automaticRuntimeTestbenchName,
  generatedRuntimeTestbenchText,
  isCustomTestbenchPath,
  isGeneratedRuntimeTestbench,
  isPrivateRuntimeTestbenchPath,
  p7AutoRuntimeTestbenchName,
  verilogProjectExcludeGlob
} from '../verilogSimulationFiles';
import {
  normalizePathKey,
  samePath
} from '../pathUtils';
import {
  coSettingsForUri,
  verilogDocumentForUri
} from './documentContext';
import { isVerilogProjectDiscoveryCandidate } from './verilogProject';
import {
  createUserTestbench,
  findUserTestbench,
  isUserTestbenchUri,
  userTestbenchUri
} from './userTestbench';
import { findWorkspaceFileCandidates } from '../workflowInputs';
import { buildUserTestbenchText, userCpuTestbenchProfile, type UserCpuTestbenchProfile } from './userCpuTestbench';
export { userCpuTestbenchProfile } from './userCpuTestbench';

export interface VerilogModuleDefinition {
  module: VerilogModule;
  uri: vscode.Uri;
}

export type TestbenchResolutionKind = 'active' | 'user' | 'generated' | 'p7-auto';

export interface TestbenchResolution {
  moduleName: string;
  kind: TestbenchResolutionKind;
  /** DUT top source retained when automatic runs exclude user testbench sources. */
  designSourceUri?: vscode.Uri;
  sourceUri?: vscode.Uri;
  generatedUri?: vscode.Uri;
  sha256?: string;
}

export interface ExistingTestbenchSearchResult {
  resolution?: TestbenchResolution;
  conflict: boolean;
}

export interface TestbenchResolutionOptions {
  /** Internal automation lane: suppress UI/path details and let the runner control termination. */
  nonInteractive?: boolean;
  /** Prepare CPU input before creating its runnable user template; false cancels. */
  beforeCreateUserCpuTestbench?: (uri: vscode.Uri, profile: UserCpuTestbenchProfile) => Promise<boolean>;
}

/** Outcome of resolving the testbench for the module under the cursor (P1 module runs). */
type ActiveModuleTestbenchResult =
  | { status: 'resolved'; resolution: TestbenchResolution }
  /** A conflict was reported, or a new `.co/tb` scaffold now awaits the user's stimulus. */
  | { status: 'stopped' }
  | { status: 'no-module' };

/**
 * CPU tops use the course shell with an editable stimulus area. Other modules
 * use the generic stimulus scaffold. Private automatic templates are separate.
 */
export function userTestbenchText(
  module: VerilogModule,
  tbName: string,
  context: { profile: ConcreteProjectProfile; configuredTop: boolean; simTime: string }
): string {
  return buildUserTestbenchText(module, tbName, context);
}

/**
 * Testbench files a simulator must append after the project sources: generated
 * runtime testbenches and user testbenches that project discovery never returns
 * (for example `.co/tb`). Discoverable sources keep their project order.
 */
export function testbenchCompileSources(
  folder: vscode.WorkspaceFolder,
  resolution: TestbenchResolution
): vscode.Uri[] {
  const sources: vscode.Uri[] = [];
  if (resolution.generatedUri) {
    sources.push(resolution.generatedUri);
  }
  if (resolution.sourceUri?.scheme === 'file' && !isVerilogProjectDiscoveryCandidate(folder, resolution.sourceUri)) {
    sources.push(resolution.sourceUri);
  }
  return sources;
}

/**
 * For P7 automated trace runs that inject an external interrupt, generate a dedicated testbench
 * (the official P7 interrupt testbench with the interrupt block active and target_pc baked in)
 * under .co/iverilog, without overwriting the student's own testbench.
 */
export async function ensureP7InterruptTestbench(
  _services: AppServices,
  resource: vscode.Uri | undefined,
  interruptSchedule: number[] | undefined,
  p7Probe: P7ProbeMetadata | undefined,
  _showMessages: boolean,
  options: TestbenchResolutionOptions = {},
  moduleRegistry?: MutableVerilogModuleProvider
): Promise<TestbenchResolution | undefined> {
  if (!options.nonInteractive || ((!interruptSchedule || !interruptSchedule.length) && !p7Probe)) {
    return undefined;
  }
  const topName = getTopModule(resource);
  const topDefinition = await findTopModuleDefinition(resource, topName, moduleRegistry);
  if (!topDefinition) {
    return undefined;
  }
  const folder = workspaceFolderFor(resource) ?? workspaceFolderForOrFirst(topDefinition.uri);
  const baseDir = folder?.uri.fsPath ?? path.dirname(topDefinition.uri.fsPath);
  const outDir = vscode.Uri.file(path.join(baseDir, CO_IVERILOG_DIR));
  await ensureDirectory(outDir);
  const tbUri = vscode.Uri.file(path.join(outDir.fsPath, `${p7AutoRuntimeTestbenchName}.v`));
  const sha256 = await writeGeneratedRuntimeTestbench(tbUri, buildTestbench(topDefinition.module, p7AutoRuntimeTestbenchName, {
    profile: 'P7',
    interruptSchedule,
    p7Probe
  }), options);
  if (!sha256) {
    return undefined;
  }
  return {
    moduleName: p7AutoRuntimeTestbenchName,
    kind: 'p7-auto',
    designSourceUri: topDefinition.uri,
    generatedUri: tbUri,
    sha256
  };
}

export async function ensureRunnableTestbench(
  services: AppServices,
  resource: vscode.Uri | undefined,
  showMessages: boolean,
  moduleRegistry?: MutableVerilogModuleProvider,
  options: TestbenchResolutionOptions = {}
): Promise<TestbenchResolution | undefined> {
  if (resource?.scheme === 'file' && isPrivateRuntimeTestbenchPath(resource.fsPath)) {
    return undefined;
  }
  // Automatic course tests own their observation window. A user testbench may
  // contain an early $finish, custom stimulus, or a module name that conflicts
  // with the configured testbench, so it must never participate in this lane.
  if (options.nonInteractive) {
    const topName = getTopModule(resource);
    const topDefinition = await findTopModuleDefinition(resource, topName, moduleRegistry);
    if (!topDefinition) {
      return undefined;
    }
    const tbUri = await privateRuntimeTestbenchUri(topDefinition.uri, automaticRuntimeTestbenchName);
    const sha256 = await writeGeneratedRuntimeTestbench(
      tbUri,
      buildTestbench(topDefinition.module, automaticRuntimeTestbenchName, {
        finishDelay: false,
        profile: getProfile(topDefinition.uri)
      }),
      options
    );
    if (!sha256) {
      return undefined;
    }
    return {
      moduleName: automaticRuntimeTestbenchName,
      kind: 'generated',
      designSourceUri: topDefinition.uri,
      generatedUri: tbUri,
      sha256
    };
  }

  const configuredTestbench = getTestbench(resource);
  const activeTestbench = await activeTestbenchModuleName(resource);
  if (activeTestbench) {
    return {
      moduleName: activeTestbench,
      kind: 'active',
      sourceUri: resource,
      sha256: resource ? await fileSha256(resource) : undefined
    };
  }
  if (resource?.scheme === 'file' && (isUserTestbenchUri(resource) || isCustomTestbenchPath(resource.fsPath))) {
    services.output.appendLine(`当前 testbench 文件未找到可仿真的模块：${resource.fsPath}`);
    if (showMessages) {
      vscode.window.showErrorMessage('当前 testbench 文件未找到可仿真的模块，请检查文件内容');
    }
    return undefined;
  }

  // P1 has no project-wide top: the module under the cursor owns the run,
  // even when a wizard-created `main` module also exists.
  if (getProfile(resource) === 'P1') {
    const moduleRun = await resolveActiveModuleTestbench(services, resource, showMessages, moduleRegistry, options);
    if (moduleRun.status === 'resolved') {
      return moduleRun.resolution;
    }
    if (moduleRun.status === 'stopped') {
      return undefined;
    }
  }

  const topName = getTopModule(resource);
  const topDefinition = await findTopModuleDefinition(resource, topName, moduleRegistry);
  if (!topDefinition) {
    if (!options.nonInteractive) {
      services.output.appendLine(`未找到顶层模块 ${topName}；使用配置的 testbench ${configuredTestbench}`);
    }
    return await resolveNamedTestbench(configuredTestbench, resource, moduleRegistry, options);
  }

  const existing = await findExistingTestbenchResolution(topDefinition.uri, configuredTestbench, moduleRegistry, options);
  if (existing.conflict) {
    return undefined;
  }
  if (existing.resolution) {
    return existing.resolution;
  }

  return await createAndOpenUserTestbench(services, topDefinition, configuredTestbench, showMessages, options);
}

export async function resolveNamedTestbench(
  testbenchName: string,
  resource: vscode.Uri | undefined,
  moduleRegistry?: MutableVerilogModuleProvider,
  options: TestbenchResolutionOptions = {}
): Promise<TestbenchResolution | undefined> {
  const existing = resource
    ? await findExistingTestbenchResolution(resource, testbenchName, moduleRegistry, options)
    : { resolution: undefined, conflict: false };
  if (existing.conflict) {
    return undefined;
  }
  return existing.resolution;
}

export async function findExistingTestbenchResolution(
  resource: vscode.Uri,
  tbName: string,
  moduleRegistry?: MutableVerilogModuleProvider,
  options: TestbenchResolutionOptions = {}
): Promise<ExistingTestbenchSearchResult> {
  const candidates = await testbenchCandidates(resource, tbName, moduleRegistry);
  if (!candidates.length) {
    // Project sources win; `.co/tb` holds the testbenches this extension created for the user.
    const userTestbench = await findUserTestbench(resource, tbName);
    if (userTestbench) {
      return {
        conflict: false,
        resolution: {
          moduleName: userTestbench.module.name,
          kind: 'user',
          sourceUri: userTestbench.uri,
          sha256: await fileSha256(userTestbench.uri)
        }
      };
    }
    if (moduleRegistry?.scanning && !options.nonInteractive) {
      vscode.window.showWarningMessage('项目 Verilog 模块仍在解析，未找到跨文件 testbench 时可稍后重试');
    }
    return { conflict: false };
  }
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      rank: testbenchCandidateRank(candidate.uri, resource, tbName)
    }))
    .sort((left, right) => left.rank - right.rank || left.uri.fsPath.localeCompare(right.uri.fsPath));
  const best = ranked[0];
  const sameRank = ranked.filter((candidate) => candidate.rank === best.rank);
  if (sameRank.length > 1) {
    const choices = sameRank.map((candidate) => vscode.workspace.asRelativePath(candidate.uri)).join(', ');
    if (!options.nonInteractive) {
      vscode.window.showErrorMessage(`发现多个同优先级 testbench 模块 ${tbName}: ${choices}`);
    }
    return { conflict: true };
  }
  return {
    conflict: false,
    resolution: {
      moduleName: best.module.name,
      kind: 'user',
      sourceUri: best.uri,
      sha256: await fileSha256(best.uri)
    }
  };
}

/** All parseable user sources that declare the configured testbench module. */
export async function findUserTestbenchSourceUris(
  resource: vscode.Uri,
  tbName: string,
  moduleRegistry?: MutableVerilogModuleProvider
): Promise<vscode.Uri[]> {
  const candidates = await testbenchCandidates(resource, tbName, moduleRegistry);
  return candidates.map((candidate) => candidate.uri);
}

export async function recordTestbenchForAsmCase(asmCase: AsmCase, resolution: TestbenchResolution): Promise<void> {
  const source = resolution.sourceUri ?? resolution.generatedUri;
  const metadata: Record<string, string> = {
    'dut.verilog.testbenchModule': resolution.moduleName,
    'dut.verilog.testbenchKind': resolution.kind
  };
  if (source) {
    metadata['dut.verilog.testbenchSource'] = source.fsPath;
    await copyAsmCaseArtifact(
      asmCase,
      'verilog',
      source,
      'testbench.v',
      'testbenchSnapshot',
      (snapshot) => ({
        ...metadata,
        'dut.verilog.testbenchSha256': snapshot.sha256
      })
    );
    return;
  } else if (resolution.sha256) {
    metadata['dut.verilog.testbenchSha256'] = resolution.sha256;
  }
  await updateAsmCaseMetadata(asmCase, metadata);
}

async function resolveActiveModuleTestbench(
  services: AppServices,
  resource: vscode.Uri | undefined,
  showMessages: boolean,
  moduleRegistry?: MutableVerilogModuleProvider,
  options: TestbenchResolutionOptions = {}
): Promise<ActiveModuleTestbenchResult> {
  const definition = await activeModuleDefinition(resource);
  if (!definition) {
    return { status: 'no-module' };
  }
  const tbName = `${definition.module.name}_tb`;
  const existing = await findExistingTestbenchResolution(definition.uri, tbName, moduleRegistry, options);
  if (existing.conflict) {
    return { status: 'stopped' };
  }
  if (existing.resolution) {
    return { status: 'resolved', resolution: existing.resolution };
  }
  await createAndOpenUserTestbench(services, definition, tbName, showMessages);
  return { status: 'stopped' };
}

async function createAndOpenUserTestbench(
  services: AppServices,
  definition: VerilogModuleDefinition,
  tbName: string,
  showMessages: boolean,
  options: TestbenchResolutionOptions = {}
): Promise<TestbenchResolution | undefined> {
  const tbUri = userTestbenchUri(definition.uri, tbName);
  const relativePath = vscode.workspace.asRelativePath(tbUri);
  const profile = getProfile(definition.uri);
  const text = userTestbenchText(definition.module, tbName, {
    profile: profile === 'auto' ? 'P1' : profile,
    configuredTop: definition.module.name === getTopModule(definition.uri),
    simTime: ''
  });
  const cpuProfile = userCpuTestbenchProfile(text);
  const continueRun = cpuProfile !== undefined && options.beforeCreateUserCpuTestbench !== undefined;
  if (cpuProfile && options.beforeCreateUserCpuTestbench
    && !await options.beforeCreateUserCpuTestbench(tbUri, cpuProfile)) return undefined;
  if (await createUserTestbench(tbUri, text)) {
    if (continueRun) {
      services.output.appendLine(`已生成 testbench ${tbUri.fsPath}，继续仿真`);
      await vscode.window.showTextDocument(tbUri, { preview: false });
      return { moduleName: tbName, kind: 'user', sourceUri: tbUri, designSourceUri: definition.uri, sha256: await fileSha256(tbUri) };
    }
    const isCpu = cpuProfile !== undefined;
    services.output.appendLine(`已生成 testbench ${tbUri.fsPath}；${isCpu ? '再次运行时选择 ASM' : '编写激励后再次运行即可仿真'}`);
    if (showMessages) {
      vscode.window.showInformationMessage(isCpu
        ? `已生成 ${relativePath}：再次点击运行时选择 ASM`
        : `已生成 ${relativePath}：请在“在此编写激励”处添加输入，然后再次点击运行`);
    }
  } else {
    // The file exists but declares no usable testbench module; keep the user's content.
    services.output.appendLine(`${tbUri.fsPath} 已存在，但未找到 testbench 模块 ${tbName}`);
    if (showMessages) {
      vscode.window.showErrorMessage(`${relativePath} 已存在，但未找到 testbench 模块 ${tbName}；请检查该文件`);
    }
  }
  await vscode.window.showTextDocument(tbUri, { preview: false });
}

async function privateRuntimeTestbenchUri(resource: vscode.Uri, moduleName: string): Promise<vscode.Uri> {
  const folder = workspaceFolderForOrFirst(resource);
  const baseDir = folder?.uri.fsPath ?? path.dirname(resource.fsPath);
  const outDir = vscode.Uri.file(path.join(baseDir, CO_IVERILOG_DIR));
  await ensureDirectory(outDir);
  return vscode.Uri.file(path.join(outDir.fsPath, `${moduleName}.v`));
}

async function testbenchCandidates(
  resource: vscode.Uri,
  tbName: string,
  moduleRegistry?: MutableVerilogModuleProvider
): Promise<Array<{ module: VerilogModule; uri: vscode.Uri }>> {
  const seen = new Set<string>();
  const candidates: Array<{ module: VerilogModule; uri: vscode.Uri }> = [];
  const add = async (module: VerilogModule): Promise<void> => {
    if (module.name !== tbName) {
      return;
    }
    const uri = uriForVerilogModule(module);
    if (!uri || !isCustomTestbenchPath(uri.fsPath)) {
      return;
    }
    if (!await isFile(uri.fsPath)) {
      moduleRegistry?.removeUri(uri);
      return;
    }
    const key = `${module.name}@${normalizePathKey(uri.fsPath)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({ module, uri });
  };

  const active = await activeModuleDefinition(resource);
  if (active) {
    await add(active.module);
  }
  for (const module of moduleRegistry?.getModules(tbName) ?? []) {
    await add(module);
  }
  if (!moduleRegistry) {
    for (const module of await scanWorkspaceModulesByName(resource, tbName)) {
      await add(module);
    }
  }
  return candidates;
}

function testbenchCandidateRank(uri: vscode.Uri, resource: vscode.Uri, tbName: string): number {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri && samePath(activeUri.fsPath, uri.fsPath)) {
    return 0;
  }
  const folder = workspaceFolderFor(resource) ?? workspaceFolderFor(uri);
  const relativeParts = folder ? path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).map((part) => part.toLowerCase()) : [];
  if (relativeParts.includes('test') || relativeParts.includes('tests')) {
    return 10;
  }
  if (path.basename(uri.fsPath).toLowerCase() === `${tbName.toLowerCase()}.v`) {
    return 20;
  }
  return 50 + relativeParts.length;
}

async function scanWorkspaceModulesByName(resource: vscode.Uri, moduleName: string): Promise<VerilogModule[]> {
  const folder = workspaceFolderFor(resource);
  if (!folder) {
    return [];
  }
  const found: VerilogModule[] = [];
  const candidates = await findWorkspaceFileCandidates({
    folder,
    include: '**/*.v',
    exclude: verilogProjectExcludeGlob,
    maxResults: 5000
  });
  for (const { uri } of candidates) {
    const document = await verilogDocumentForUri(uri);
    if (!document) {
      continue;
    }
    const parsed = parseVerilog(document, coSettingsForUri(uri), false);
    found.push(...parsed.modules.filter((module) => module.name === moduleName));
  }
  return found;
}

async function writeGeneratedRuntimeTestbench(
  uri: vscode.Uri,
  testbenchText: string,
  options: TestbenchResolutionOptions = {}
): Promise<string | undefined> {
  const next = generatedRuntimeTestbenchText(testbenchText);
  const sha256 = sha256Bytes(Buffer.from(next, 'utf8'));
  if (await pathExists(uri.fsPath)) {
    const existing = await readTextFileSafe(uri);
    if (!isGeneratedRuntimeTestbench(existing)) {
      if (!options.nonInteractive) {
        vscode.window.showErrorMessage(`不会覆盖非插件生成的 testbench：${uri.fsPath}`);
      }
      return undefined;
    }
    if (existing === next) {
      return sha256;
    }
  }
  await writeTextFile(uri, next);
  return sha256;
}

async function readTextFileSafe(uri: vscode.Uri): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    // 读取失败时按空文件处理，调用方只用它做生成标记检查
    return '';
  }
}

async function activeModuleDefinition(resource: vscode.Uri | undefined): Promise<VerilogModuleDefinition | undefined> {
  if (!resource || resource.scheme !== 'file' || path.extname(resource.fsPath).toLowerCase() !== '.v') {
    return undefined;
  }
  const document = await verilogDocumentForUri(resource);
  if (!document) {
    return undefined;
  }
  const parsed = parseVerilog(document, coSettingsForUri(resource), false);
  const activeEditor = vscode.window.activeTextEditor;
  const activePosition = activeEditor?.document.uri.toString() === resource.toString()
    ? activeEditor.selection.active
    : undefined;
  const module = activePosition
    ? moduleAtPosition(parsed.modules, activePosition) ?? parsed.modules[0]
    : parsed.modules[0];
  return module ? { module, uri: resource } : undefined;
}

async function activeTestbenchModuleName(resource: vscode.Uri | undefined): Promise<string | undefined> {
  if (!resource || resource.scheme !== 'file' || path.extname(resource.fsPath).toLowerCase() !== '.v'
      || isPrivateRuntimeTestbenchPath(resource.fsPath)
      || (!isUserTestbenchUri(resource) && !isCustomTestbenchPath(resource.fsPath))) {
    return undefined;
  }
  const document = await verilogDocumentForUri(resource);
  if (!document) {
    return undefined;
  }
  const parsed = parseVerilog(document, coSettingsForUri(resource), false);
  const activeEditor = vscode.window.activeTextEditor;
  const activePosition = activeEditor?.document.uri.toString() === resource.toString()
    ? activeEditor.selection.active
    : undefined;
  const activeModule = activePosition ? moduleAtPosition(parsed.modules, activePosition) : undefined;
  const fileStem = path.basename(resource.fsPath, path.extname(resource.fsPath));
  return (parsed.modules.find((module) => module.name === fileStem)
    ?? activeModule
    ?? parsed.modules.find((module) => /(?:_tb|_testbench)$/i.test(module.name))
    ?? parsed.modules[0])?.name;
}

async function findTopModuleDefinition(
  resource: vscode.Uri | undefined,
  topName: string,
  moduleRegistry?: MutableVerilogModuleProvider
): Promise<VerilogModuleDefinition | undefined> {
  if (!topName.trim()) {
    return undefined;
  }
  const active = await topModuleDefinitionFromUri(resource, topName);
  if (active) {
    return active;
  }

  for (const module of moduleRegistry?.getModules(topName) ?? []) {
    const uri = uriForVerilogModule(module);
    if (uri && !isUserOrPrivateTestbenchUri(uri) && resource?.toString() !== uri.toString()) {
      return { module, uri };
    }
  }

  const folder = workspaceFolderForOrFirst(resource);
  if (!folder) {
    return undefined;
  }
  const candidates = await findWorkspaceFileCandidates({
    folder,
    include: '**/*.v',
    exclude: verilogProjectExcludeGlob,
    maxResults: 5000,
    predicate: (uri) => resource?.toString() !== uri.toString() && !isUserOrPrivateTestbenchUri(uri)
  });
  for (const { uri } of candidates) {
    const definition = await topModuleDefinitionFromUri(uri, topName);
    if (definition) {
      return definition;
    }
  }
  return undefined;
}

async function topModuleDefinitionFromUri(uri: vscode.Uri | undefined, topName: string): Promise<VerilogModuleDefinition | undefined> {
  if (!uri || uri.scheme !== 'file' || path.extname(uri.fsPath).toLowerCase() !== '.v'
      || isUserOrPrivateTestbenchUri(uri)) {
    return undefined;
  }
  const document = await verilogDocumentForUri(uri);
  if (!document) {
    return undefined;
  }
  const parsed = parseVerilog(document, coSettingsForUri(uri), false);
  const module = parsed.modules.find((candidate) => candidate.name === topName);
  return module ? { module, uri } : undefined;
}

function isUserOrPrivateTestbenchUri(uri: vscode.Uri): boolean {
  return isUserTestbenchUri(uri) || isCustomTestbenchPath(uri.fsPath) || isPrivateRuntimeTestbenchPath(uri.fsPath);
}

function uriForVerilogModule(module: VerilogModule): vscode.Uri | undefined {
  try {
    return vscode.Uri.parse(module.uri);
  } catch {
    // 索引里的 URI 异常时跳过该模块位置
    return undefined;
  }
}

async function fileSha256(uri: vscode.Uri | undefined): Promise<string | undefined> {
  if (!uri || uri.scheme !== 'file') {
    return undefined;
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return sha256Bytes(bytes);
  } catch {
    // 哈希只用于记录生成物版本，读取失败时留空
    return undefined;
  }
}
