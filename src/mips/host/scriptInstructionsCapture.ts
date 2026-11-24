// @index mips-host — Targeted bounded native ESM/TypeScript snapshot capture without evaluation
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vm from 'vm';
import * as nodeModule from 'module';
import { customInstructionDirectory, isScriptInstructionFile, readCustomInstructionFiles } from './customInstructionFiles';
import {
  ScriptInstructionBundle, ScriptInstructionFile, scriptInstructionBundleDigest, scriptInstructionHash,
  scriptInstructionLimits, scriptInstructionRuntimeVersion, scriptInstructionSdkModule, scriptInstructionSdkVersion,
  freezeScriptInstructionBundle
} from './scriptInstructionBundle';

export function requireScriptRuntime(): void {
  if (typeof vm.SourceTextModule !== 'function') throw new Error('Custom instructions require native Node VM modules; update VS Code and restart the extension.');
  if (typeof (nodeModule as unknown as { stripTypeScriptTypes?: unknown }).stripTypeScriptTypes !== 'function') {
    throw new Error('Custom TypeScript instructions require native Node stripTypeScriptTypes (VS Code 1.101 or newer). Update VS Code; no separate Node or tsc installation is needed.');
  }
}
export async function captureScriptInstructionBundle(workspaceRoot: string, previous?: ScriptInstructionBundle): Promise<ScriptInstructionBundle | undefined> {
  const root = customInstructionDirectory(path.resolve(workspaceRoot));
  const names = await readCustomInstructionFiles(workspaceRoot);
  const entries = names.filter(entry => entry.isFile() && isScriptInstructionFile(entry.name)).map(entry => entry.name).sort();
  if (!entries.length) return undefined;
  requireScriptRuntime();
  const realRoot = await fs.realpath(root);
  const files = new Map<string, ScriptInstructionFile>();
  let totalBytes = 0;
  const previousFiles = new Map(previous?.nodeVersion === process.versions.node ? previous.files.map(file => [file.path, file]) : []);
  async function visit(relative: string): Promise<void> {
    if (files.has(relative)) return;
    if (files.size >= scriptInstructionLimits.files) throw new Error(`Custom instructions exceed ${scriptInstructionLimits.files} source files`);
    const absolute = path.join(root, ...relative.split('/'));
    const real = await fs.realpath(absolute);
    const within = path.relative(realRoot, real);
    if (within.startsWith('..') || path.isAbsolute(within)) throw new Error(`Custom instruction import escapes its directory: ${relative}`);
    const info = await fs.stat(real);
    if (!info.isFile() || info.size > scriptInstructionLimits.fileBytes) throw new Error(`Custom instruction source is not a bounded file: ${relative}`);
    const source = await fs.readFile(real, 'utf8');
    if (Buffer.byteLength(source) > scriptInstructionLimits.fileBytes || (totalBytes += Buffer.byteLength(source)) > scriptInstructionLimits.bytes) throw new Error('Custom instruction sources exceed size limit');
    let javascript = source;
    const cached = previousFiles.get(relative);
    if (cached?.source === source) javascript = cached.javascript;
    else if (relative.endsWith('.ts')) {
      const strip = (nodeModule as unknown as { stripTypeScriptTypes(code: string, options: { mode: 'strip'; sourceUrl: string }): string }).stripTypeScriptTypes;
      try { javascript = strip(source, { mode: 'strip', sourceUrl: relative }); }
      catch (error) { throw new Error(`${relative}: native TypeScript stripping failed: ${String(error)}. Use erasable TypeScript syntax (interfaces, types, annotations); enums/namespaces/parameter properties need rewriting.`); }
    }
    let module: vm.SourceTextModule;
    try { module = new vm.SourceTextModule(javascript, { identifier: relative }); }
    catch (error) { throw new Error(`${relative}: ${String(error)}`); }
    files.set(relative, { path: relative, source, javascript, digest: scriptInstructionHash(JSON.stringify([source, javascript])) });
    for (const specifier of module.dependencySpecifiers) {
      if (specifier === scriptInstructionSdkModule) continue;
      await visit(resolveScriptImport(relative, specifier));
    }
  }
  for (const entry of entries) await visit(entry);
  const content: Omit<ScriptInstructionBundle, 'digest'> = { version: 1, runtimeVersion: scriptInstructionRuntimeVersion, sdkVersion: scriptInstructionSdkVersion, nodeVersion: process.versions.node, entries,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')) };
  return freezeScriptInstructionBundle({ ...content, digest: scriptInstructionBundleDigest(content) });
}
export function resolveScriptImport(from: string, specifier: string): string {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new Error(`Custom instruction imports must be relative or '${scriptInstructionSdkModule}': ${specifier}`);
  if (specifier.includes('\\') || specifier.includes(':') || specifier.includes('?') || specifier.includes('#')) throw new Error(`Invalid custom instruction import: ${specifier}`);
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (relative.startsWith('../') || relative === '..' || !isScriptInstructionFile(relative)) throw new Error(`Custom instruction imports require an explicit .js/.ts path within their directory: ${specifier}`);
  return relative;
}
