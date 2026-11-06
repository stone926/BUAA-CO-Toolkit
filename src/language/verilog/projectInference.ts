// @index verilog-project-inference — directory boundaries and dependency closures for independent designs
import * as path from 'path';
import { URI } from 'vscode-uri';
import { normalizePathKey } from '../../pathUtils';
import type { VerilogInclude, VerilogModule } from './model';
import type { VerilogProjects } from './projectContext';

export interface VerilogProjectSource {
  uri: string;
  modules: readonly VerilogModule[];
  includes: readonly Pick<VerilogInclude, 'path'>[];
}

/** Pure, deterministic inference over an existing index; never reads the filesystem. */
export function inferVerilogProjects(folderUris: readonly string[], sources: readonly VerilogProjectSource[]): VerilogProjects {
  const result: VerilogProjects = Object.create(null);
  const folders = folderUris.map(filePath).sort((a, b) => b.length - a.length);
  for (const root of folders) {
    const files = sources.map((source) => ({ ...source, file: filePath(source.uri) }))
      .filter((source) => folders.find((folder) => within(source.file, folder)) === root &&
        !path.posix.relative(root, source.file).split('/').includes('.co'))
      .sort((a, b) => a.file.localeCompare(b.file));
    if (!files.length) continue;
    const byPath = new Map(files.map((source) => [source.file, source]));
    const definitions = new Map<string, Set<string>>();
    for (const source of files) for (const module of source.modules) {
      const candidates = definitions.get(module.name) ?? new Set<string>();
      candidates.add(source.file);
      definitions.set(module.name, candidates);
    }

    // A repeated module in different directory trees is evidence of variants.
    // Same-directory duplicates remain in one project and retain diagnostics.
    const boundaries = new Set<string>();
    for (const candidates of definitions.values()) {
      splitDirectories([...new Set([...candidates].map((file) => path.posix.dirname(file)))], boundaries);
    }
    const orderedBoundaries = [...boundaries].sort((a, b) => b.length - a.length);
    const groups = new Map<string, Set<string>>();
    for (const source of files) {
      const owner = orderedBoundaries.find((boundary) => within(source.file, boundary)) ?? root;
      const group = groups.get(owner) ?? new Set<string>();
      group.add(source.file);
      groups.set(owner, group);
    }

    for (const [owner, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      // Snapshot initial local definitions before traversal. A local variant
      // wins over other projects; globally ambiguous dependencies stay ambiguous.
      const localNames = new Set([...group].flatMap((file) => byPath.get(file)!.modules.map((module) => module.name)));
      const queue = [...group];
      const add = (file: string): void => {
        if (byPath.has(file) && !group.has(file)) { group.add(file); queue.push(file); }
      };
      for (let index = 0; index < queue.length; index++) {
        const source = byPath.get(queue[index])!;
        for (const include of source.includes) {
          const relative = filePath(path.resolve(path.dirname(source.file), include.path));
          const workspace = filePath(path.resolve(root, include.path));
          add(byPath.has(relative) ? relative : workspace);
        }
        for (const module of source.modules) for (const instance of module.instances) {
          if (localNames.has(instance.moduleName)) continue;
          for (const candidate of definitions.get(instance.moduleName) ?? []) add(candidate);
        }
      }
      const label = (folders.length > 1 ? `${path.posix.basename(root)}/` : '') +
        (path.posix.relative(root, owner) || 'workspace');
      let name = label;
      for (let suffix = 2; Object.prototype.hasOwnProperty.call(result, name); suffix++) name = `${label}-${suffix}`;
      result[name] = [...group].sort().map((file) => {
        const uri = byPath.get(file)!.uri;
        return path.isAbsolute(uri) ? uri : URI.parse(uri).fsPath;
      });
    }
  }
  return result;
}

function splitDirectories(directories: string[], boundaries: Set<string>): void {
  if (directories.length < 2) return;
  let common = directories[0];
  while (!directories.every((directory) => within(directory, common))) common = path.posix.dirname(common);
  const branches = new Map<string, string[]>();
  for (const directory of directories) {
    const first = path.posix.relative(common, directory).split('/')[0];
    if (!first) continue;
    const branch = `${common.replace(/\/$/, '')}/${first}`;
    boundaries.add(branch);
    const children = branches.get(branch) ?? [];
    children.push(directory);
    branches.set(branch, children);
  }
  for (const children of branches.values()) splitDirectories(children, boundaries);
}

function filePath(value: string): string {
  const file = path.isAbsolute(value) ? value : URI.parse(value).fsPath;
  return normalizePathKey(path.resolve(file));
}

function within(file: string, directory: string): boolean {
  return file === directory || file.startsWith(`${directory.replace(/\/$/, '')}/`);
}
