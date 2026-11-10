// @index course-testing — 工作区历史通过用例的跨会话留存与增量清理
import * as fs from 'fs';
import * as path from 'path';
import { normalizePathKey } from '../pathUtils';
import { assertContainedDirectoryPath } from '../pathContainment';
import { discardPassingAsmCase, readPassingAsmCase } from './continuousCaseRetention';

interface PassingCase {
  manifestPath: string;
  createdAt: string;
}

/** One targeted history scan at test startup; subsequent batches read only their own manifests. */
export class WorkspaceCaseRetention {
  private readonly passing = new Map<string, PassingCase>();

  constructor(private readonly casesDirectory: string, private readonly retainedPassingCases: number) {
    if (!Number.isInteger(retainedPassingCases) || retainedPassingCases < 0) {
      throw new Error('Invalid passing-case retention limit');
    }
  }

  async initialize(): Promise<void> {
    const root = path.dirname(path.dirname(this.casesDirectory));
    try {
      await fs.promises.lstat(this.casesDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await assertContainedDirectoryPath(root, this.casesDirectory);
    const directory = await fs.promises.opendir(this.casesDirectory);
    for await (const entry of directory) {
      if (!entry.isDirectory()) continue;
      await this.observe([path.join(this.casesDirectory, entry.name, 'case.json')]);
    }
  }

  async observe(manifestPaths: readonly string[]): Promise<void> {
    for (const manifestPath of new Set(manifestPaths)) {
      if (normalizePathKey(path.dirname(path.dirname(path.resolve(manifestPath))))
        !== normalizePathKey(path.resolve(this.casesDirectory))) continue;
      const key = normalizePathKey(path.resolve(manifestPath));
      const passing = await readPassingAsmCase(manifestPath);
      if (passing) this.passing.set(key, passing);
      else this.passing.delete(key);
    }
  }

  async prune(): Promise<{ removed: string[]; refused: number }> {
    const newest = [...this.passing.values()].sort((left, right) =>
      Date.parse(right.createdAt) - Date.parse(left.createdAt)
      || normalizePathKey(right.manifestPath).localeCompare(normalizePathKey(left.manifestPath)));
    const removed: string[] = [];
    let refused = 0;
    // A refused old case never displaces one of the latest ten from protection.
    for (const victim of newest.slice(this.retainedPassingCases)) {
      try {
        if (await discardPassingAsmCase(victim.manifestPath)) {
          this.passing.delete(normalizePathKey(victim.manifestPath));
          removed.push(victim.manifestPath);
        } else {
          refused++;
          await this.observe([victim.manifestPath]);
        }
      } catch {
        refused++;
      }
    }
    return { removed, refused };
  }
}
