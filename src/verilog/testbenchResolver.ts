// @index verilog-testbench-resolver — ISim testbench 发现、生成和 case 记录
import * as path from 'path';
import * as vscode from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CO_DIR, CO_ISIM_DIR } from '../constants';
import {
  getProfile,
  getSimTime,
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
import {
  AsmCase,
  copyAsmCaseArtifact,
  updateAsmCaseMetadata
} from '../asmCaseStore';
import { sha256Bytes } from '../asmCaseStoreCore';
import {
  automaticRuntimeTestbenchName,
  generatedRuntimeTestbenchText,
  isGeneratedRuntimeTestbench,
  p7AutoRuntimeTestbenchName,
  runtimeTestbenchFileName,
  verilogProjectExcludeGlob
} from '../verilogSimulationFiles';
import {
  normalizePathKey,
  samePath
} from '../pathUtils';
import {
  coSettingsForUri,
  toTextDocument,
  verilogDelayFromSimTime
} from './documentContext';
import { findWorkspaceFileCandidates } from '../workflowInputs';

export interface VerilogModuleDefinition {
  module: VerilogModule;
  uri: vscode.Uri;
}

export type TestbenchResolutionKind = 'active' | 'user' | 'generated' | 'p7-auto';

export interface TestbenchResolution {
  moduleName: string;
  kind: TestbenchResolutionKind;
  /** DUT top source retained when automatic testbench sources are excluded from the PRJ. */
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
  /** Internal automation lane: suppress UI/path details and let TCL control termination. */
  nonInteractive?: boolean;
}

export async function defaultUserTestbenchUri(resource: vscode.Uri, tbName: string, configuredTop: boolean): Promise<vscode.Uri> {
  const folder = workspaceFolderFor(resource);
  if (configuredTop && folder) {
    const testDir = vscode.Uri.file(path.join(folder.uri.fsPath, 'test'));
    await ensureDirectory(testDir);
    return vscode.Uri.file(path.join(testDir.fsPath, `${tbName}.v`));
  }
  return vscode.Uri.file(path.join(path.dirname(resource.fsPath), `${tbName}.v`));
}

/**
 * For P7 automated trace runs that inject an external interrupt, generate a dedicated testbench
 * (the official P7 interrupt testbench with the interrupt block active and target_pc baked in)
 * under .co/isim, without overwriting the student's own testbench.
 */
export async function ensureP7InterruptTestbench(
  services: AppServices,
  resource: vscode.Uri | undefined,
  interruptSchedule: number[] | undefined,
  p7Probe: P7ProbeMetadata | undefined,
  showMessages: boolean,
  options: TestbenchResolutionOptions = {}
): Promise<TestbenchResolution | undefined> {
  if ((!interruptSchedule || !interruptSchedule.length) && !p7Probe) {
    return undefined;
  }
  const topName = getTopModule(resource);
  const topDefinition = await findTopModuleDefinition(resource, topName);
  if (!topDefinition) {
    if (!options.nonInteractive) {
      services.output.appendLine(`未找到顶层模块 ${topName}，无法生成 P7 中断 testbench；改用默认 testbench（不注入外部中断）。`);
    }
    return undefined;
  }
  const folder = workspaceFolderFor(resource) ?? workspaceFolderForOrFirst(topDefinition.uri);
  const baseDir = folder?.uri.fsPath ?? path.dirname(topDefinition.uri.fsPath);
  const outDir = vscode.Uri.file(path.join(baseDir, CO_ISIM_DIR));
  await ensureDirectory(outDir);
  const tbUri = vscode.Uri.file(path.join(outDir.fsPath, `${p7AutoRuntimeTestbenchName}.v`));
  const written = await writeGeneratedRuntimeTestbench(tbUri, buildTestbench(topDefinition.module, p7AutoRuntimeTestbenchName, {
    profile: 'P7',
    interruptSchedule,
    p7Probe
  }), options);
  if (!written) {
    return undefined;
  }
  if (!options.nonInteractive) {
    if (p7Probe) {
      services.output.appendLine(`已生成 P7 probe testbench ${tbUri.fsPath}（scenarios=${p7Probe.scenarios.map((scenario) => `${scenario.id}:${scenario.kind}`).join(',')}）`);
    } else {
      services.output.appendLine(`已生成 P7 中断 testbench ${tbUri.fsPath}（target_pc=${(interruptSchedule ?? []).map((pc) => `0x${(pc >>> 0).toString(16)}`).join(',')}）`);
    }
  }
  if (showMessages && !options.nonInteractive) {
    vscode.window.showInformationMessage('已生成 P7 中断 testbench');
  }
  return {
    moduleName: p7AutoRuntimeTestbenchName,
    kind: 'p7-auto',
    designSourceUri: topDefinition.uri,
    generatedUri: tbUri,
    sha256: await fileSha256(tbUri)
  };
}

export async function ensureRunnableTestbench(
  services: AppServices,
  resource: vscode.Uri | undefined,
  showMessages: boolean,
  moduleRegistry?: MutableVerilogModuleProvider,
  options: TestbenchResolutionOptions = {}
): Promise<TestbenchResolution | undefined> {
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
    const written = await writeGeneratedRuntimeTestbench(
      tbUri,
      buildTestbench(topDefinition.module, automaticRuntimeTestbenchName, {
        finishDelay: false,
        profile: getProfile(topDefinition.uri)
      }),
      options
    );
    if (!written) {
      return undefined;
    }
    return {
      moduleName: automaticRuntimeTestbenchName,
      kind: 'generated',
      designSourceUri: topDefinition.uri,
      generatedUri: tbUri,
      sha256: await fileSha256(tbUri)
    };
  }

  const configuredTestbench = getTestbench(resource);
  const activeTestbench = await activeTestbenchModuleName(resource, configuredTestbench);
  if (activeTestbench) {
    return {
      moduleName: activeTestbench,
      kind: 'active',
      sourceUri: resource,
      sha256: resource ? await fileSha256(resource) : undefined
    };
  }

  const topName = getTopModule(resource);
  const topDefinition = await findTopModuleDefinition(resource, topName, moduleRegistry);
  if (!topDefinition) {
    if (getProfile(resource) === 'P1') {
      const activeTestbench = await ensureActiveModuleTestbench(services, resource, showMessages, moduleRegistry, options);
      if (activeTestbench) {
        return activeTestbench;
      }
    }
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

  const tbUri = await runtimeTestbenchUri(topDefinition.uri, configuredTestbench);
  const written = await writeGeneratedRuntimeTestbench(tbUri, buildTestbench(topDefinition.module, configuredTestbench, {
    finishDelay: options.nonInteractive ? false : verilogDelayFromSimTime(getSimTime(topDefinition.uri)),
    profile: getProfile(topDefinition.uri)
  }), options);
  if (!written) {
    return undefined;
  }
  if (!options.nonInteractive) {
    services.output.appendLine(`已生成 testbench ${tbUri.fsPath}`);
  }
  if (showMessages && !options.nonInteractive) {
    vscode.window.showInformationMessage(`已为 ISim 生成 ${path.basename(tbUri.fsPath)}`);
  }
  return { moduleName: configuredTestbench, kind: 'generated', generatedUri: tbUri, sha256: await fileSha256(tbUri) };
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
  return existing.resolution ?? { moduleName: testbenchName, kind: 'user' };
}

export async function findExistingTestbenchResolution(
  resource: vscode.Uri,
  tbName: string,
  moduleRegistry?: MutableVerilogModuleProvider,
  options: TestbenchResolutionOptions = {}
): Promise<ExistingTestbenchSearchResult> {
  const candidates = await testbenchCandidates(resource, tbName, moduleRegistry);
  if (!candidates.length) {
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
    await copyAsmCaseArtifact(asmCase, 'verilog', source, 'testbench.v', 'testbenchSnapshot');
    const sha256 = await fileSha256(source);
    metadata['dut.verilog.testbenchSource'] = source.fsPath;
    if (sha256) {
      metadata['dut.verilog.testbenchSha256'] = sha256;
    }
  } else if (resolution.sha256) {
    metadata['dut.verilog.testbenchSha256'] = resolution.sha256;
  }
  await updateAsmCaseMetadata(asmCase, metadata);
}

async function ensureActiveModuleTestbench(
  services: AppServices,
  resource: vscode.Uri | undefined,
  showMessages: boolean,
  moduleRegistry?: MutableVerilogModuleProvider,
  options: TestbenchResolutionOptions = {}
): Promise<TestbenchResolution | undefined> {
  const definition = await activeModuleDefinition(resource);
  if (!definition) {
    return undefined;
  }
  const tbName = `${definition.module.name}_tb`;
  const existing = await findExistingTestbenchResolution(definition.uri, tbName, moduleRegistry, options);
  if (existing.conflict) {
    return undefined;
  }
  if (existing.resolution) {
    return existing.resolution;
  }
  const tbUri = await runtimeTestbenchUri(definition.uri, tbName);
  const written = await writeGeneratedRuntimeTestbench(tbUri, buildTestbench(definition.module, tbName, {
    finishDelay: options.nonInteractive ? false : verilogDelayFromSimTime(getSimTime(definition.uri)),
    profile: getProfile(definition.uri)
  }), options);
  if (!written) {
    return undefined;
  }
  if (!options.nonInteractive) {
    services.output.appendLine(`已生成 P1 testbench ${tbUri.fsPath}`);
  }
  if (showMessages && !options.nonInteractive) {
    vscode.window.showInformationMessage(`已为 ISim 生成 ${path.basename(tbUri.fsPath)}`);
  }
  return { moduleName: tbName, kind: 'generated', generatedUri: tbUri, sha256: await fileSha256(tbUri) };
}

async function runtimeTestbenchUri(resource: vscode.Uri, testbenchName: string): Promise<vscode.Uri> {
  const folder = workspaceFolderForOrFirst(resource);
  const baseDir = folder?.uri.fsPath ?? path.dirname(resource.fsPath);
  const outDir = vscode.Uri.file(path.join(baseDir, CO_ISIM_DIR));
  await ensureDirectory(outDir);
  return vscode.Uri.file(path.join(outDir.fsPath, runtimeTestbenchFileName(testbenchName)));
}

async function privateRuntimeTestbenchUri(resource: vscode.Uri, moduleName: string): Promise<vscode.Uri> {
  const folder = workspaceFolderForOrFirst(resource);
  const baseDir = folder?.uri.fsPath ?? path.dirname(resource.fsPath);
  const outDir = vscode.Uri.file(path.join(baseDir, CO_ISIM_DIR));
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
    if (!uri || isCoPath(uri.fsPath)) {
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
): Promise<boolean> {
  const next = generatedRuntimeTestbenchText(testbenchText);
  if (await pathExists(uri.fsPath)) {
    const existing = await readTextFileSafe(uri);
    if (!isGeneratedRuntimeTestbench(existing)) {
      if (!options.nonInteractive) {
        vscode.window.showErrorMessage(`不会覆盖非插件生成的 testbench：${uri.fsPath}`);
      }
      return false;
    }
    if (existing === next) {
      return true;
    }
  }
  await writeTextFile(uri, next);
  return true;
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

async function activeTestbenchModuleName(resource: vscode.Uri | undefined, configuredTestbench: string): Promise<string | undefined> {
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
  const activeModule = activePosition ? moduleAtPosition(parsed.modules, activePosition) : undefined;
  if (activeModule && isTestbenchModule(activeModule, configuredTestbench)) {
    return activeModule.name;
  }
  return parsed.modules.find((module) => isTestbenchModule(module, configuredTestbench))?.name;
}

async function verilogDocumentForUri(uri: vscode.Uri): Promise<TextDocument | undefined> {
  const active = vscode.window.activeTextEditor?.document;
  if (active && active.uri.toString() === uri.toString()) {
    return toTextDocument(active);
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return TextDocument.create(uri.toString(), 'verilog', 1, Buffer.from(bytes).toString('utf8'));
  } catch {
    // 文件不可读时跳过该 Verilog 候选
    return undefined;
  }
}

function isTestbenchModule(module: { name: string; ports: unknown[] }, configuredTestbench: string): boolean {
  const lower = module.name.toLowerCase();
  return module.name === configuredTestbench || lower.includes('tb') || (module.ports.length === 0 && lower.endsWith('test'));
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
    if (uri && resource?.toString() !== uri.toString()) {
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
    predicate: (uri) => resource?.toString() !== uri.toString()
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
  if (!uri || uri.scheme !== 'file' || path.extname(uri.fsPath).toLowerCase() !== '.v') {
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

function isCoPath(file: string): boolean {
  return file.split(/[\\/]+/).some((part) => part.toLowerCase() === CO_DIR);
}
