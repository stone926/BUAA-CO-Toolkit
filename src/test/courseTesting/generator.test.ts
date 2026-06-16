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

  it('snapshots ASM files while ignoring generated tool directories', async () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, 'case.asm'), '.text\n');
    fs.mkdirSync(path.join(root, '.co', 'generated'), { recursive: true });
    fs.writeFileSync(path.join(root, '.co', 'generated', 'old-generated.asm'), '.text\n');
    fs.mkdirSync(path.join(root, '.co', 'cases', 'case-id'), { recursive: true });
    fs.writeFileSync(path.join(root, '.co', 'cases', 'case-id', 'program.asm'), '.text\n');
    fs.mkdirSync(path.join(root, '.co', 'isim'), { recursive: true });
    fs.writeFileSync(path.join(root, '.co', 'isim', 'runtime.asm'), '.text\n');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'case.s'), '.text\n');

    const files = (await snapshotAsmFiles(root)).map((entry) => path.relative(root, entry.file).replace(/\\/g, '/'));

    expect(files).toEqual(['.co/generated/old-generated.asm', 'case.asm', 'src/case.s']);
  });
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-generator-test-'));
  tempDirs.push(dir);
  return dir;
}
