import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildGeneratorInvocation,
  changedAsmFiles,
  isSupportedGeneratorFile,
  snapshotAsmFiles
} from '../../courseTesting/generator';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('course test generator helpers', () => {
  it('builds invocations for common generator file types', () => {
    const py = buildGeneratorInvocation('/work/gen.py', {
      python: 'python3',
      java: 'java',
      extraArgs: ['--seed', '1']
    });
    expect(py).toMatchObject({
      kind: 'python',
      command: 'python3',
      args: ['/work/gen.py', '--seed', '1'],
      cwd: '/work'
    });

    const jar = buildGeneratorInvocation('/work/gen.jar', {
      python: 'python',
      java: 'java17'
    });
    expect(jar).toMatchObject({
      kind: 'jar',
      command: 'java17',
      args: ['-jar', '/work/gen.jar']
    });
  });

  it('recognizes supported generator extensions', () => {
    expect(isSupportedGeneratorFile('mips_test_generator.py')).toBe(true);
    expect(isSupportedGeneratorFile('gen.ps1')).toBe(true);
    expect(isSupportedGeneratorFile('notes.md')).toBe(false);
  });

  it('detects new and modified ASM files from snapshots', () => {
    const changed = changedAsmFiles(
      [
        { file: '/work/old.asm', mtimeMs: 100 },
        { file: '/work/same.asm', mtimeMs: 200 }
      ],
      [
        { file: '/work/old.asm', mtimeMs: 120 },
        { file: '/work/same.asm', mtimeMs: 200 },
        { file: '/work/new.asm', mtimeMs: 300 }
      ]
    );

    expect(changed).toEqual(['/work/new.asm', '/work/old.asm']);
  });

  it('keeps the mtime tolerance and always reports new ASM files', () => {
    const changed = changedAsmFiles(
      [
        { file: '/work/tolerance.asm', mtimeMs: 100 },
        { file: '/work/modified.asm', mtimeMs: 100 }
      ],
      [
        { file: '/work/tolerance.asm', mtimeMs: 101 },
        { file: '/work/modified.asm', mtimeMs: 102 },
        { file: '/work/new-old-time.asm', mtimeMs: 1 }
      ]
    );

    expect(changed).toEqual(['/work/modified.asm', '/work/new-old-time.asm']);
  });

  it('detects same-mtime rewrites by file-system change time or size', () => {
    const changed = changedAsmFiles(
      [
        { file: '/work/same-size.asm', mtimeMs: 100, ctimeMs: 1000, size: 20 },
        { file: '/work/new-size.asm', mtimeMs: 100, ctimeMs: 1000, size: 20 }
      ],
      [
        { file: '/work/same-size.asm', mtimeMs: 100, ctimeMs: 1001, size: 20 },
        { file: '/work/new-size.asm', mtimeMs: 100, ctimeMs: 1000, size: 24 }
      ]
    );

    expect(changed).toEqual(['/work/new-size.asm', '/work/same-size.asm']);
  });

  it('detects a generator that replaces output with an older timestamp', () => {
    const changed = changedAsmFiles(
      [{ file: '/work/replaced.asm', mtimeMs: 200, ctimeMs: 200, size: 20 }],
      [{ file: '/work/replaced.asm', mtimeMs: 100, ctimeMs: 300, size: 20 }]
    );

    expect(changed).toEqual(['/work/replaced.asm']);
  });

  it('orders changed ASM files by newest mtime and then path before applying the limit', () => {
    const changed = changedAsmFiles(
      [],
      [
        { file: '/work/b.asm', mtimeMs: 200 },
        { file: '/work/a.asm', mtimeMs: 200 },
        { file: '/work/newest.asm', mtimeMs: 300 }
      ],
      2
    );

    expect(changed).toEqual(['/work/newest.asm', '/work/a.asm']);
  });

  it('snapshots ASM files while ignoring generated tool directories', async () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, 'case.asm'), '.text\n');
    fs.mkdirSync(path.join(root, '.co', 'generated'), { recursive: true });
    fs.writeFileSync(path.join(root, '.co', 'generated', 'old-generated.asm'), '.text\n');
    fs.mkdirSync(path.join(root, '.co', 'cases', 'case-id'), { recursive: true });
    fs.writeFileSync(path.join(root, '.co', 'cases', 'case-id', 'program.asm'), '.text\n');
    fs.mkdirSync(path.join(root, '.co', 'isim'), { recursive: true });
    fs.writeFileSync(path.join(root, '.co', 'isim', 'runtime.asm'), '.text\n');
    fs.mkdirSync(path.join(root, '.co', 'out'), { recursive: true });
    fs.writeFileSync(path.join(root, '.co', 'out', 'trace.asm'), '.text\n');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'case.s'), '.text\n');
    fs.mkdirSync(path.join(root, 'src', 'out'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'out', 'ignored.asm'), '.text\n');
    fs.mkdirSync(path.join(root, 'src', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'node_modules', 'ignored.asm'), '.text\n');

    const files = (await snapshotAsmFiles(root)).map((entry) => path.relative(root, entry.file).replace(/\\/g, '/'));

    expect(files).toEqual(['.co/generated/old-generated.asm', 'case.asm', 'src/case.s']);
  });

  it('honors the snapshot maxFiles limit after statting ASM files', async () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, 'a.asm'), '.text\n');
    fs.writeFileSync(path.join(root, 'b.asm'), '.text\n');
    fs.writeFileSync(path.join(root, 'c.asm'), '.text\n');

    const files = await snapshotAsmFiles(root, 2);

    expect(files).toHaveLength(2);
  });
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-generator-test-'));
  tempDirs.push(dir);
  return dir;
}
