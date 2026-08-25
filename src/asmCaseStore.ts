import { CO_CASES_DIR } from './constants';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { getMemoryConfiguration, getProfile } from './config';
import { ensureDirectory, pathExists, readTextFile, workspaceFolderForOrFirst, writeTextFile } from './fsUtil';
import { normalizePathKey } from './pathUtils';
import { MarsRunOptions } from './mips';
import { AppServices } from './types';
import { resolveFileInput } from './workflowInputs';
import { assembleWithPreflight, preflightFailureMessage } from './mips/providers/providerResolver';
import { AssembleResult } from './mips/providers/contracts';
import {
  AsmCaseArtifactKind,
  AsmCaseManifest,
  AsmCaseP7Metadata,
  AsmCaseSource,
  asmCaseId,
  asmCaseManifestVersion,
  asmCasePaths,
  machineCodeWordCount,
  mergeAsmCaseArtifacts,
  sha256Bytes
} from './asmCaseStoreCore';
import { courseMachineCodeValidationError } from './courseTesting/machineCodeValidation';

export interface AsmCase {
  id: string;
  dir: vscode.Uri;
  manifestUri: vscode.Uri;
  asm: vscode.Uri;
  machineCode: vscode.Uri;
  sourceAsm: vscode.Uri;
  stdin?: vscode.Uri;
  manifest: AsmCaseManifest;
}

export interface CreateAsmCaseOptions {
  source?: AsmCaseSource;
  stdin?: vscode.Uri;
  resource?: vscode.Uri;
  createdAt?: Date;
  p7?: AsmCaseP7Metadata;
}

export async function resolveAsmCaseInput(title = '选择 MIPS ASM 文件'): Promise<vscode.Uri | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  return await resolveFileInput({
    title,
    active: { predicate: isAsmFile, saveDirty: true },
    folder: workspaceFolderForOrFirst(active),
    include: '**/*.{asm,s,mips}',
    exclude: asmCaseInputExcludeGlob,
    maxResults: 500,
    filters: {
      ASM: ['asm', 's', 'mips'],
      All: ['*']
    }
  });
}

export async function createAsmCaseFromAsm(
  asm: vscode.Uri,
  options: CreateAsmCaseOptions = {}
): Promise<AsmCase> {
  const asmBytes = await vscode.workspace.fs.readFile(asm);
  const asmHash = sha256Bytes(asmBytes);
  const root = caseWorkspaceRoot(options.resource ?? asm);
  const createdAt = options.createdAt ?? new Date();
  const paths = await nextAsmCasePaths(root, createdAt, asmHash);
  const caseDir = vscode.Uri.file(paths.caseDir);
  await ensureDirectory(caseDir);

  const caseAsm = vscode.Uri.file(paths.asm);
  await vscode.workspace.fs.writeFile(caseAsm, asmBytes);

  const p7 = normalizeP7Metadata(options.p7);
  const stdin = options.stdin ? await copyStdinSnapshot(options.stdin, paths.stdinDir) : undefined;

  const manifest: AsmCaseManifest = {
    version: asmCaseManifestVersion,
    caseId: path.basename(paths.caseDir),
    createdAt: createdAt.toISOString(),
    profile: getProfile(options.resource ?? asm),
    originalAsmPath: asm.fsPath,
    asmSnapshot: {
      path: caseAsm.fsPath,
      sha256: asmHash,
      bytes: asmBytes.byteLength
    },
    source: options.source ?? { kind: 'selected' },
    stdin: stdin?.snapshot,
    p7
  };
  const manifestUri = vscode.Uri.file(paths.manifest);
  await writeTextFile(manifestUri, JSON.stringify(manifest, null, 2) + '\n');

  return {
    id: manifest.caseId,
    dir: caseDir,
    manifestUri,
    asm: caseAsm,
    machineCode: vscode.Uri.file(paths.machineCode),
    sourceAsm: asm,
    stdin: stdin?.uri,
    manifest
  };
}

export async function createAsmCaseFromText(
  fileName: string,
  text: string,
  options: CreateAsmCaseOptions = {}
): Promise<AsmCase> {
  const bytes = Buffer.from(text, 'utf8');
  const asmHash = sha256Bytes(bytes);
  const root = caseWorkspaceRoot(options.resource);
  const createdAt = options.createdAt ?? new Date();
  const paths = await nextAsmCasePaths(root, createdAt, asmHash);
  const caseDir = vscode.Uri.file(paths.caseDir);
  await ensureDirectory(caseDir);

  const caseAsm = vscode.Uri.file(paths.asm);
  await vscode.workspace.fs.writeFile(caseAsm, bytes);
  const p7 = normalizeP7Metadata(options.p7);
  const stdin = options.stdin ? await copyStdinSnapshot(options.stdin, paths.stdinDir) : undefined;
  const manifest: AsmCaseManifest = {
    version: asmCaseManifestVersion,
    caseId: path.basename(paths.caseDir),
    createdAt: createdAt.toISOString(),
    profile: getProfile(options.resource),
    originalAsmPath: fileName,
    asmSnapshot: {
      path: caseAsm.fsPath,
      sha256: asmHash,
      bytes: bytes.byteLength
    },
    source: options.source ?? { kind: 'builtin' },
    stdin: stdin?.snapshot,
    p7
  };
  const manifestUri = vscode.Uri.file(paths.manifest);
  await writeTextFile(manifestUri, JSON.stringify(manifest, null, 2) + '\n');

  return {
    id: manifest.caseId,
    dir: caseDir,
    manifestUri,
    asm: caseAsm,
    machineCode: vscode.Uri.file(paths.machineCode),
    sourceAsm: caseAsm,
    stdin: stdin?.uri,
    manifest
  };
}

export async function prepareAsmCaseMachineCode(
  services: AppServices,
  asmCase: AsmCase,
  options: MarsRunOptions = {}
): Promise<AssembleResult | undefined> {
  const invocation = await assembleWithPreflight(services, {
    sourceUri: asmCase.sourceAsm,
    target: { kind: 'userText', outputFile: asmCase.machineCode },
    courseTrace: options.courseTrace,
    revealOutput: options.revealOutput
  });
  const dump = invocation.result ?? {
    ok: false,
    status: {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: preflightFailureMessage(invocation.preflight),
      timedOut: false
    },
    descriptor: invocation.preflight.descriptor
  };
  if (!dump.ok || !dump.outputFile) {
    return dump;
  }

  const bytes = await vscode.workspace.fs.readFile(asmCase.machineCode);
  const text = Buffer.from(bytes).toString('utf8');
  if (options.courseTrace) {
    const asmText = await readTextFile(asmCase.sourceAsm);
    const validationError = courseMachineCodeValidationError(
      getProfile(asmCase.sourceAsm),
      text,
      asmText,
      asmCase.manifest.source.kind === 'builtin'
    );
    if (validationError) {
      services.output.appendLine(validationError);
      return {
        ...dump,
        ok: false,
        status: {
          ...dump.status,
          ok: false,
          stderr: dump.status.stderr ? `${dump.status.stderr}\n${validationError}` : validationError
        }
      };
    }
  }
  asmCase.manifest = {
    ...asmCase.manifest,
    machineCode: {
      path: asmCase.machineCode.fsPath,
      sha256: sha256Bytes(bytes),
      bytes: bytes.byteLength,
      wordCount: machineCodeWordCount(text),
      haltPc: dump.courseHaltPc
    },
    mars: {
      commandLine: dump.status.commandLine ?? dump.descriptor.id,
      cwd: dump.status.cwd ?? path.dirname(asmCase.sourceAsm.fsPath),
      memoryConfiguration: getMemoryConfiguration(asmCase.sourceAsm)
    }
  };
  await writeAsmCaseManifest(asmCase);
  return dump;
}

export async function updateAsmCaseArtifacts(
  asmCase: AsmCase,
  kind: AsmCaseArtifactKind,
  artifacts: Record<string, string>
): Promise<void> {
  asmCase.manifest = mergeAsmCaseArtifacts(asmCase.manifest, kind, artifacts);
  await writeAsmCaseManifest(asmCase);
}

export async function writeAsmCaseArtifact(
  asmCase: AsmCase,
  kind: 'verilog' | 'logisim' | 'mars',
  fileName: string,
  content: string,
  artifactName = path.basename(fileName, path.extname(fileName))
): Promise<vscode.Uri> {
  const dir = artifactDirectory(asmCase, kind);
  await ensureDirectory(dir);
  const uri = vscode.Uri.file(path.join(dir.fsPath, path.basename(fileName)));
  await writeTextFile(uri, content);
  await updateAsmCaseArtifacts(asmCase, kind, { [artifactName]: uri.fsPath });
  return uri;
}

export function asmCaseArtifactUri(
  asmCase: AsmCase,
  kind: 'verilog' | 'logisim' | 'mars',
  fileName: string
): vscode.Uri {
  return vscode.Uri.file(path.join(artifactDirectory(asmCase, kind).fsPath, path.basename(fileName)));
}

export async function copyAsmCaseArtifact(
  asmCase: AsmCase,
  kind: 'verilog' | 'logisim' | 'mars',
  source: vscode.Uri,
  fileName = path.basename(source.fsPath),
  artifactName = path.basename(fileName, path.extname(fileName))
): Promise<vscode.Uri> {
  const dir = artifactDirectory(asmCase, kind);
  await ensureDirectory(dir);
  const target = vscode.Uri.file(path.join(dir.fsPath, path.basename(fileName)));
  if (normalizePathKey(source.fsPath) !== normalizePathKey(target.fsPath)) {
    const bytes = await vscode.workspace.fs.readFile(source);
    await vscode.workspace.fs.writeFile(target, bytes);
  }
  await updateAsmCaseArtifacts(asmCase, kind, { [artifactName]: target.fsPath });
  return target;
}

export async function listAsmCaseManifests(resource?: vscode.Uri): Promise<Array<{ manifest: AsmCaseManifest; uri: vscode.Uri }>> {
  const root = caseWorkspaceRoot(resource);
  const casesDir = path.join(root, CO_CASES_DIR);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(casesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const manifests: Array<{ manifest: AsmCaseManifest; uri: vscode.Uri }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const uri = vscode.Uri.file(path.join(casesDir, entry.name, 'case.json'));
    try {
      const manifest = JSON.parse(await readTextFile(uri)) as AsmCaseManifest;
      if (manifest?.version === asmCaseManifestVersion && manifest.caseId) {
        manifests.push({ manifest, uri });
      }
    } catch {
      // Ignore incomplete or hand-edited case directories.
    }
  }
  return manifests.sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt));
}

export async function readAsmCaseManifestForAsm(asm: vscode.Uri): Promise<AsmCaseManifest | undefined> {
  if (path.basename(asm.fsPath).toLowerCase() !== 'program.asm') {
    return undefined;
  }
  const manifestPath = path.join(path.dirname(asm.fsPath), 'case.json');
  try {
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as AsmCaseManifest;
    return manifest?.version === asmCaseManifestVersion ? manifest : undefined;
  } catch {
    // 元数据文件不存在或格式异常时按普通 ASM 处理
    return undefined;
  }
}

export function isAsmFile(uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') {
    return false;
  }
  return ['.asm', '.s', '.mips'].includes(path.extname(uri.fsPath).toLowerCase());
}

const asmCaseInputExcludeGlob = '**/{node_modules,out,.git,.co/cases,.co/out,.co/isim,.co/logisim,.co/tmp}/**';

async function nextAsmCasePaths(root: string, createdAt: Date, asmHash: string): Promise<ReturnType<typeof asmCasePaths>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidateDate = attempt === 0 ? createdAt : new Date(createdAt.getTime() + attempt);
    const paths = asmCasePaths(root, asmCaseId(candidateDate, asmHash));
    if (!await pathExists(paths.caseDir)) {
      return paths;
    }
  }
  return asmCasePaths(root, asmCaseId(new Date(), `${asmHash}${randomBytes(4).toString('hex')}`));
}

function caseWorkspaceRoot(resource?: vscode.Uri): string {
  const folder = workspaceFolderForOrFirst(resource);
  if (folder) {
    return folder.uri.fsPath;
  }
  if (resource?.scheme === 'file') {
    return path.dirname(resource.fsPath);
  }
  return process.cwd();
}

async function copyStdinSnapshot(stdin: vscode.Uri, stdinDir: string): Promise<{
  uri: vscode.Uri;
  snapshot: NonNullable<AsmCaseManifest['stdin']>;
}> {
  const bytes = await vscode.workspace.fs.readFile(stdin);
  await ensureDirectory(vscode.Uri.file(stdinDir));
  const uri = vscode.Uri.file(path.join(stdinDir, path.basename(stdin.fsPath)));
  await vscode.workspace.fs.writeFile(uri, bytes);
  return {
    uri,
    snapshot: {
      originalPath: stdin.fsPath,
      path: uri.fsPath,
      sha256: sha256Bytes(bytes),
      bytes: bytes.byteLength
    }
  };
}

function normalizeP7Metadata(explicit: AsmCaseP7Metadata | undefined): AsmCaseP7Metadata | undefined {
  const merged: AsmCaseP7Metadata = {
    ...(explicit ?? {})
  };
  if (!merged.interruptSchedule?.length) {
    delete merged.interruptSchedule;
  }
  if (!merged.probe) {
    delete merged.probe;
  }
  return merged.interruptSchedule || merged.probe ? merged : undefined;
}

function artifactDirectory(asmCase: AsmCase, kind: 'verilog' | 'logisim' | 'mars'): vscode.Uri {
  return vscode.Uri.file(path.join(asmCase.dir.fsPath, kind));
}

async function writeAsmCaseManifest(asmCase: AsmCase): Promise<void> {
  await writeTextFile(asmCase.manifestUri, JSON.stringify(asmCase.manifest, null, 2) + '\n');
}
