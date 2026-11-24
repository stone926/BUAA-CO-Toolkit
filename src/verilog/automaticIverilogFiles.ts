// @index verilog-automatic-iverilog-files — 自动测试独占的 VVP 工作目录与回收
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { assertContainedDirectoryPath } from '../pathContainment';

export async function createAutomaticIverilogRunDirectory(): Promise<{
  directory: string;
  dispose(): Promise<void>;
}> {
  const parent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'co-vvp-'));
  const created = await fs.lstat(directory);
  return {
    directory,
    async dispose() {
      try {
        await assertContainedDirectoryPath(parent, directory);
        const current = await fs.lstat(directory);
        if (current.dev === created.dev && current.ino === created.ino && current.birthtimeMs === created.birthtimeMs) {
          await fs.rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
        }
      } catch {
        // Cleanup must not replace the simulation result or remove a substituted path.
      }
    }
  };
}

/** The cache retains fingerprints of the dependency closure after compilation. */
export async function discardAutomaticIverilogDependencies(workspaceRoot: string, file: string): Promise<void> {
  try {
    await assertContainedDirectoryPath(workspaceRoot, path.dirname(file));
    await fs.unlink(file);
  } catch {
    // A missing or externally locked dependency listing cannot invalidate VVP.
  }
}
