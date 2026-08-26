// @index path-containment — 安全创建/校验可信根目录下的输出目录树，拒绝 symlink/junction escape
import * as fs from 'fs';
import * as path from 'path';

/**
 * Create a directory tree one component at a time below an already trusted root.
 * Every existing or newly created component must be a real directory whose
 * realpath remains below that root.
 */
export async function ensureContainedDirectoryPath(
  trustedRoot: string,
  targetDirectory: string,
  options: { allowRoot?: boolean } = {}
): Promise<void> {
  const { lexicalRoot, lexicalTarget, relative, realRoot } = await containmentInputs(
    trustedRoot,
    targetDirectory,
    options.allowRoot === true
  );
  if (!relative) return;
  let cursor = lexicalRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      await fs.promises.mkdir(cursor, { recursive: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await assertRealContainedDirectory(realRoot, cursor);
  }
  await assertRealContainedDirectory(realRoot, lexicalTarget);
}

/** Validate an existing output directory immediately before/after publication. */
export async function assertContainedDirectoryPath(
  trustedRoot: string,
  targetDirectory: string,
  options: { allowRoot?: boolean } = {}
): Promise<void> {
  const { lexicalRoot, relative, realRoot } = await containmentInputs(
    trustedRoot,
    targetDirectory,
    options.allowRoot === true
  );
  let cursor = lexicalRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    await assertRealContainedDirectory(realRoot, cursor);
  }
}

async function containmentInputs(trustedRoot: string, targetDirectory: string, allowRoot: boolean) {
  const lexicalRoot = path.resolve(trustedRoot);
  const lexicalTarget = path.resolve(targetDirectory);
  const relative = path.relative(lexicalRoot, lexicalTarget);
  if ((!relative && !allowRoot) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('output directory must remain below its trusted containment root');
  }
  const rootStat = await fs.promises.stat(lexicalRoot);
  if (!rootStat.isDirectory()) throw new Error('output containment root is not a directory');
  const realRoot = await fs.promises.realpath(lexicalRoot);
  return { lexicalRoot, lexicalTarget, relative, realRoot };
}

async function assertRealContainedDirectory(realRoot: string, directory: string): Promise<void> {
  const stat = await fs.promises.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`output path contains a symlink/junction or non-directory: ${directory}`);
  }
  const real = await fs.promises.realpath(directory);
  const relative = path.relative(realRoot, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`output directory escapes its trusted containment root: ${directory}`);
  }
}
