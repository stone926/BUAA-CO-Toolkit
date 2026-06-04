import * as fs from 'fs';
import * as path from 'path';

export interface GeneratorInvocationOptions {
  python: string;
  java: string;
  node?: string;
  powershell?: string;
  cwd?: string;
  extraArgs?: readonly string[];
}

export interface GeneratorInvocation {
  kind: 'python' | 'node' | 'jar' | 'powershell' | 'direct';
  command: string;
  args: string[];
  cwd: string;
}

export interface AsmSnapshotEntry {
  file: string;
  mtimeMs: number;
}

const generatorExtensions = new Set(['.py', '.js', '.mjs', '.cjs', '.jar', '.bat', '.cmd', '.exe', '.ps1']);
const asmExtensions = new Set(['.asm', '.s', '.mips']);
const ignoredDirectories = new Set(['.git', '.co', 'node_modules', 'out', '.vscode-test']);

export function isSupportedGeneratorFile(file: string): boolean {
  return generatorExtensions.has(path.extname(file).toLowerCase());
}

export function buildGeneratorInvocation(
  generatorFile: string,
  options: GeneratorInvocationOptions
): GeneratorInvocation | undefined {
  const extension = path.extname(generatorFile).toLowerCase();
  const cwd = options.cwd ?? path.dirname(generatorFile);
  const extraArgs = [...(options.extraArgs ?? [])];

  if (extension === '.py') {
    return {
      kind: 'python',
      command: options.python,
      args: [generatorFile, ...extraArgs],
      cwd
    };
  }
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return {
      kind: 'node',
      command: options.node ?? 'node',
      args: [generatorFile, ...extraArgs],
      cwd
    };
  }
  if (extension === '.jar') {
    return {
      kind: 'jar',
      command: options.java,
      args: ['-jar', generatorFile, ...extraArgs],
      cwd
    };
  }
  if (extension === '.ps1') {
    return {
      kind: 'powershell',
      command: options.powershell ?? (process.platform === 'win32' ? 'powershell' : 'pwsh'),
      args: ['-ExecutionPolicy', 'Bypass', '-File', generatorFile, ...extraArgs],
      cwd
    };
  }
  if (extension === '.bat' || extension === '.cmd' || extension === '.exe') {
    return {
      kind: 'direct',
      command: generatorFile,
      args: extraArgs,
      cwd
    };
  }
  return undefined;
}

export function snapshotAsmFiles(root: string, maxFiles = 5000): AsmSnapshotEntry[] {
  const results: AsmSnapshotEntry[] = [];
  walk(root, results, maxFiles);
  return results.sort((left, right) => left.file.localeCompare(right.file));
}

export function changedAsmFiles(
  before: readonly AsmSnapshotEntry[],
  after: readonly AsmSnapshotEntry[],
  limit = 100
): string[] {
  const beforeMap = new Map(before.map((entry) => [snapshotKey(entry.file), entry.mtimeMs]));
  return after
    .filter((entry) => {
      const previousMtime = beforeMap.get(snapshotKey(entry.file));
      return previousMtime === undefined || entry.mtimeMs > previousMtime + 1;
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file))
    .slice(0, limit)
    .map((entry) => entry.file);
}

function walk(directory: string, results: AsmSnapshotEntry[], maxFiles: number): void {
  if (results.length >= maxFiles || ignoredDirectories.has(path.basename(directory))) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxFiles) {
      return;
    }
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(file, results, maxFiles);
      continue;
    }
    if (!entry.isFile() || !asmExtensions.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    try {
      results.push({
        file,
        mtimeMs: fs.statSync(file).mtimeMs
      });
    } catch {
      // Ignore files that disappear while the generator is running.
    }
  }
}

function snapshotKey(file: string): string {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
