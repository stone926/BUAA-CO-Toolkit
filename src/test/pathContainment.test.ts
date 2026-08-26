import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertContainedDirectoryPath, ensureContainedDirectoryPath } from '../pathContainment';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('contained output directory creation', () => {
  it('creates a real child tree under the trusted root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-contained-output-'));
    roots.push(root);
    const target = path.join(root, '.co', 'cases', 'case-1');

    await ensureContainedDirectoryPath(root, target);
    await expect(assertContainedDirectoryPath(root, target)).resolves.toBeUndefined();
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it('rejects a case-output junction before any bytes escape the workspace', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'co-contained-workspace-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'co-contained-outside-'));
    roots.push(workspace, outside);
    fs.symlinkSync(outside, path.join(workspace, '.co'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(ensureContainedDirectoryPath(workspace, path.join(workspace, '.co', 'cases', 'case-1')))
      .rejects.toThrow(/symlink|junction|escapes/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
