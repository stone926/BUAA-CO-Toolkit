// @index mips-host — Shared custom instruction directory and file discovery
import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import * as path from 'path';

export const customInstructionRelativeDirectory = '.co/custom-instructions';
export const customInstructionWatchPattern = `${customInstructionRelativeDirectory}/**/*.{js,ts,[cC][lL][aA][sS][sS]}`;

export function customInstructionDirectory(root: string): string {
  return path.join(root, customInstructionRelativeDirectory);
}

export function isScriptInstructionFile(name: string): boolean {
  return /\.(?:js|ts)$/.test(name) && !name.endsWith('.d.ts');
}

export async function readCustomInstructionFiles(root: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(customInstructionDirectory(root), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function customMarsClassNames(files: readonly Dirent[]): string[] {
  const names = files.filter(file => file.isFile() && /\.class$/i.test(file.name)).map(file => file.name).sort();
  return names.some(name => !name.includes('$')) ? names : [];
}
