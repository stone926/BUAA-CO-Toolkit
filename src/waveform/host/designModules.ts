// @index waveform-design-modules — 设计模块查找：优先增量模块注册表，未收录的 testbench（.co/tb、生成的运行时 TB）按需读取并解析

import { readFile, readdir, stat } from 'fs/promises';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { CO_ISIM_DIR, CO_TB_DIR } from '../../constants';
import type { VerilogModule } from '../../language/verilog/model';
import { parseModules } from '../../language/verilog/moduleParser';
import type { VerilogModuleProvider } from '../../language/verilog/moduleProvider';
import type { ModuleLookup } from '../design/designHierarchy';

const maximumExtraSources = 64;
const maximumExtraSourceBytes = 2 * 1024 * 1024;

/**
 * Build a synchronous lookup over the registry plus explicitly parsed sources.
 * The registry deliberately skips `.co`, where user and runtime testbenches live.
 */
export async function createDesignModuleLookup(
  registry: VerilogModuleProvider | undefined,
  extraSources: readonly string[]
): Promise<ModuleLookup> {
  const extra = new Map<string, VerilogModule>();
  for (const file of extraSources.slice(0, maximumExtraSources)) {
    for (const module of await parseSourceModules(file)) {
      if (!extra.has(module.name)) {
        extra.set(module.name, module);
      }
    }
  }
  return (name) => extra.get(name) ?? registry?.getModule(name);
}

/** `.co/tb` testbenches and generated runtime testbenches of a workspace. */
export async function workspaceTestbenchSources(workspaceRoot: string): Promise<string[]> {
  const files: string[] = [];
  for (const directory of [CO_TB_DIR, CO_ISIM_DIR]) {
    const absolute = path.join(workspaceRoot, ...directory.split('/'));
    let entries: string[];
    try {
      entries = await readdir(absolute);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (/\.(v|sv)$/i.test(entry) && (directory === CO_TB_DIR || entry.startsWith('co_generated_'))) {
        files.push(path.join(absolute, entry));
      }
    }
  }
  return files;
}

async function parseSourceModules(file: string): Promise<VerilogModule[]> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > maximumExtraSourceBytes) {
      return [];
    }
    const text = await readFile(file, 'utf8');
    // Same URI spelling as the workspace module registry (vscode.Uri.file).
    const uri = URI.file(file).toString();
    return parseModules(TextDocument.create(uri, 'verilog', 0, text), text);
  } catch {
    return [];
  }
}
