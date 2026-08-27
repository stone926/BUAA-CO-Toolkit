// @index mips-replay — 跨平台原子文件替换：POSIX rename；Windows 备份+rename+回滚

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Atomic replacement helper shared by builtin provider artifacts and shadow
 * bundles. On Windows `rename` cannot replace an existing destination, so the
 * complete old file is first renamed to a recoverable backup and restored if
 * the new file cannot be published. A crash between the two renames can leave
 * a `.bak-*` file next to the target; it is complete and never mistaken for a
 * valid manifest/artifact.
 */
export async function writeFileAtomicReplace(file: string, bytes: Buffer): Promise<void> {
  await fs.promises.mkdir(pathFor(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.promises.writeFile(temporary, bytes, { flag: 'wx' });
    try {
      await fs.promises.rename(temporary, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || (code !== 'EEXIST' && code !== 'EPERM')) {
        throw error;
      }
    }
    const backup = `${file}.bak-${process.pid}-${crypto.randomUUID()}`;
    let hasBackup = false;
    try {
      await fs.promises.rename(file, backup);
      hasBackup = true;
      await fs.promises.rename(temporary, file);
    } catch (error) {
      if (hasBackup) {
        await fs.promises.rename(backup, file).catch(() => undefined);
      }
      throw error;
    } finally {
      await fs.promises.rm(backup, { force: true }).catch(() => undefined);
    }
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function pathFor(file: string): string {
  return path.dirname(file);
}
