// @index verilog-project-context — explicit source-set membership shared by LSP and compiler inputs
import * as path from 'path';
import { URI } from 'vscode-uri';
import { normalizePathKey } from '../../pathUtils';

/** Named source sets. Entries are files or directory trees, relative to a workspace folder. */
export type VerilogProjects = Record<string, string[]>;

export function normalizeVerilogProjects(value: unknown): VerilogProjects {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([name, sources]) =>
    name.trim() && Array.isArray(sources) && sources.length > 0 &&
    sources.every((source) => typeof source === 'string' && source.trim() && !/[?*]/.test(source))
  ).map(([name, sources]) => [name, [...new Set((sources as string[]).map((source) => source.trim()))]]));
}

export class VerilogProjectContext {
  private readonly memberships = new Map<string, readonly string[]>();
  private readonly roots: Array<{ uri: string; key: string }>;
  private readonly sets: Array<{ id: string; root: string; sources: string[] }>;

  constructor(folderUris: readonly string[] = [], projects: VerilogProjects = {}) {
    this.roots = folderUris.map((uri) => ({ uri, key: uriPathKey(uri) })).sort((a, b) => b.key.length - a.key.length);
    this.sets = this.roots.flatMap((folder) => Object.entries(projects).map(([name, sources]) => ({
      id: `${folder.uri}#${name}`,
      root: folder.key,
      sources: sources.map((source) => normalizePathKey(path.resolve(URI.parse(folder.uri).fsPath, source)).replace(/\/$/, ''))
    })));
  }

  projectIds(uri: string): readonly string[] {
    const cached = this.memberships.get(uri);
    if (cached) return cached;
    const file = uriPathKey(uri);
    const folder = this.roots.find((root) => within(file, root.key));
    const sets = folder ? this.sets.filter((set) => set.root === folder.key) : this.sets;
    const ids = sets.length
      ? sets.filter((set) => set.sources.some((source) => within(file, source))).map((set) => set.id)
      : [folder?.uri ?? 'unconfigured'];
    // Files outside declared source sets are isolated, not silently joined to all projects.
    const result = ids.length ? ids : [`isolated:${uri}`];
    this.memberships.set(uri, result);
    return result;
  }

  sharesProject(left: string, right: string): boolean {
    const ids = new Set(this.projectIds(left));
    return this.projectIds(right).some((id) => ids.has(id));
  }

  /** A shared source has no unique compilation context; require a concrete caller. */
  hasUniqueProject(uri: string): boolean {
    return this.projectIds(uri).length === 1;
  }

  sourcePaths(uri: string): string[] | undefined {
    const ids = this.projectIds(uri);
    const selected = this.sets.filter((set) => ids.includes(set.id));
    return selected.length ? [...new Set(selected.flatMap((set) => set.sources))] : undefined;
  }
}

function uriPathKey(uri: string): string {
  if (path.isAbsolute(uri)) return normalizePathKey(uri).replace(/\/$/, '');
  const parsed = URI.parse(uri);
  return parsed.scheme === 'file'
    ? normalizePathKey(parsed.fsPath).replace(/\/$/, '')
    : uri;
}

function within(file: string, root: string): boolean {
  return file === root || file.startsWith(`${root}/`);
}
