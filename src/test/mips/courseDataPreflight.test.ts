import * as fs from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runnerState = vi.hoisted(() => ({ root: '', profile: 'P6', marsJar: '' }));

vi.mock('vscode', async () => {
  const fsModule = await import('fs');
  const pathModule = await import('path');
  const { URI } = await import('vscode-uri');
  return {
    Uri: URI,
    workspace: {
      workspaceFolders: [],
      getWorkspaceFolder(uri: { fsPath: string }) {
        return runnerState.root && uri.fsPath.startsWith(runnerState.root)
          ? { uri: URI.file(runnerState.root), name: 'cpu', index: 0 }
          : undefined;
      },
      getConfiguration() {
        return { get: () => undefined, inspect: () => ({}) };
      },
      fs: {
        async createDirectory(uri: { fsPath: string }) {
          await fsModule.promises.mkdir(uri.fsPath, { recursive: true });
        },
        async writeFile(uri: { fsPath: string }, bytes: Uint8Array) {
          await fsModule.promises.mkdir(pathModule.dirname(uri.fsPath), { recursive: true });
          await fsModule.promises.writeFile(uri.fsPath, bytes);
        },
        async readFile(uri: { fsPath: string }) {
          return fsModule.promises.readFile(uri.fsPath);
        },
        async stat(uri: { fsPath: string }) {
          const stat = await fsModule.promises.stat(uri.fsPath);
          return { mtime: stat.mtimeMs, type: 1 };
        },
        async delete(uri: { fsPath: string }) {
          await fsModule.promises.rm(uri.fsPath, { recursive: true, force: true });
        }
      }
    },
    window: {
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      createTerminal: vi.fn()
    },
    commands: { registerCommand: vi.fn(() => ({ dispose: vi.fn() })) },
    ConfigurationTarget: { Workspace: 1, Global: 2 }
  };
});

vi.mock('../../config', () => ({
  ensureConcreteProfile: vi.fn(async () => runnerState.profile),
  getJava: vi.fn(() => 'java'),
  getMachineCode: vi.fn(() => 'code.txt'),
  getMarsJar: vi.fn(() => runnerState.marsJar),
  getMemoryConfiguration: vi.fn(() => runnerState.profile === 'P7' ? 'CompactLargeText' : 'FixedCompactLargeText'),
  getMipsExtraArgs: vi.fn(() => []),
  getProfile: vi.fn(() => runnerState.profile),
  useDelayedBranching: vi.fn(() => runnerState.profile === 'P5' || runnerState.profile === 'P6' || runnerState.profile === 'P7')
}));

vi.mock('../../process', () => ({
  commandLine: vi.fn((command: string, args: readonly string[]) => `${command} ${args.join(' ')}`),
  revealOutputChannel: vi.fn(),
  runTool: vi.fn()
}));

import * as vscode from 'vscode';
import { runMarsFile } from '../../mips';
import { runTool } from '../../process';
import { courseDataDumpChunkWordCount } from '../../courseTesting/courseDataInitialization';

const zeroChunk = '00000000\n'.repeat(courseDataDumpChunkWordCount);
const courseTextRange = '0x00003000-0x00006ffc';
const p7UserTextRange = '0x00003000-0x00004180';
const p7KernelTextRange = '0x00004180-0x00006ffc';
const roots: string[] = [];

describe('runMarsFile course DM initialization preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runnerState.profile = 'P6';
    runnerState.root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-mars-dm-runner-'));
    runnerState.marsJar = path.join(runnerState.root, 'Mars.jar');
    roots.push(runnerState.root);
    fs.writeFileSync(path.join(runnerState.root, 'case.asm'), '.text\nmain:\nbeq $0,$0,main\nnop\n');
    fs.writeFileSync(runnerState.marsJar, 'pinned-mars-a');
  });

  afterEach(() => {
    runnerState.root = '';
    runnerState.marsJar = '';
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('dumps all three 4 KiB blocks in the same assembly and cleans temporary files', async () => {
    let dataDumpPaths: string[] = [];
    vi.mocked(runTool).mockImplementation(async (_command, args) => {
      const dumps = dumpTriples(args);
      fs.writeFileSync(dumps.find((dump) => dump.range === courseTextRange)!.file, '1000ffff\n00000000\n');
      const dataDumps = dumps.filter((dump) => dump.range !== courseTextRange);
      dataDumpPaths = dataDumps.map((dump) => dump.file);
      for (const dump of dataDumps) {
        fs.writeFileSync(dump.file, zeroChunk);
      }
      return successResult();
    });

    const output = await runMarsFile(testServices(), vscode.Uri.file(path.join(runnerState.root, 'case.asm')), 'dumpText', {
      courseTrace: true,
      p7RiInstruction: false,
      showMessages: false,
      revealOutput: false
    });

    expect(output?.result.ok).toBe(true);
    expect(output?.courseHaltPc).toBe(0x3000);
    expect(output?.engineArtifact).toMatchObject({
      sha256: crypto.createHash('sha256').update('pinned-mars-a').digest('hex'),
      role: 'user-configured-mars',
      fileName: 'Mars.jar'
    });
    const args = vi.mocked(runTool).mock.calls[0][1];
    expect(dumpTriples(args).map((dump) => dump.range)).toEqual([
      courseTextRange,
      '0x00000000-0x00001000',
      '0x00001000-0x00002000',
      '0x00002000-0x00003000'
    ]);
    expect(path.normalize(args[args.length - 1]).toLowerCase())
      .toBe(path.normalize(path.join(runnerState.root, 'case.asm')).toLowerCase());
    expect(dataDumpPaths).toHaveLength(3);
    expect(dataDumpPaths.every((file) => !fs.existsSync(file))).toBe(true);
  });

  it('allows an unallocated data block represented by the pre-created empty file', async () => {
    vi.mocked(runTool).mockImplementation(async (_command, args) => {
      const dumps = dumpTriples(args);
      fs.writeFileSync(dumps.find((dump) => dump.range === courseTextRange)!.file, '1000ffff\n00000000\n');
      // Leave all three pre-created DM files empty, matching modified MARS for no .data writes.
      return successResult('This segment has not been written to, there is nothing to dump.');
    });

    const output = await runCourseDump();

    expect(output?.result.ok).toBe(true);
  });

  it('rejects output when the configured MARS artifact changes during the run', async () => {
    const expectedSha256 = crypto.createHash('sha256').update('pinned-mars-a').digest('hex');
    vi.mocked(runTool).mockImplementation(async (_command, args) => {
      const dumps = dumpTriples(args);
      fs.writeFileSync(dumps.find((dump) => dump.range === courseTextRange)!.file, '1000ffff\n00000000\n');
      for (const dump of dumps.filter((item) => item.range !== courseTextRange)) {
        fs.writeFileSync(dump.file, zeroChunk);
      }
      fs.writeFileSync(runnerState.marsJar, 'replaced-mars-b');
      return successResult();
    });

    const output = await runCourseDump();

    expect(output?.result.ok).toBe(false);
    expect(output?.result.stderr).toMatch(/artifact 在运行期间发生变化/);
    expect(output?.engineArtifact?.sha256).toBe(expectedSha256);
  });

  it('rejects the first nonzero initialized word and still cleans the dump directory', async () => {
    let tempDir = '';
    vi.mocked(runTool).mockImplementation(async (_command, args) => {
      const dumps = dumpTriples(args);
      fs.writeFileSync(dumps.find((dump) => dump.range === courseTextRange)!.file, '1000ffff\n00000000\n');
      const dataDumps = dumps.filter((dump) => dump.range !== courseTextRange);
      tempDir = path.dirname(dataDumps[0].file);
      fs.writeFileSync(dataDumps[0].file, zeroChunk);
      const middle = zeroChunk.split('\n');
      middle[64] = '12345678';
      fs.writeFileSync(dataDumps[1].file, middle.join('\n'));
      fs.writeFileSync(dataDumps[2].file, zeroChunk);
      return successResult();
    });

    const output = await runCourseDump();

    expect(output?.result.ok).toBe(false);
    expect(output?.result.stderr).toContain('0x00001100');
    expect(output?.result.stderr).toContain('0x12345678');
    expect(output?.result.stderr).toContain('硬件 DM 复位初态全为零');
    expect(fs.existsSync(tempDir)).toBe(false);
  });

  it('does not silently accept malformed or failed MARS dumps', async () => {
    vi.mocked(runTool).mockImplementationOnce(async (_command, args) => {
      const dumps = dumpTriples(args);
      fs.writeFileSync(dumps.find((dump) => dump.range === courseTextRange)!.file, '1000ffff\n00000000\n');
      fs.writeFileSync(dumps.find((dump) => dump.range === '0x00000000-0x00001000')!.file, '00000000\n');
      return successResult();
    });
    expect((await runCourseDump())?.result.stderr).toContain('dump 格式异常');

    vi.mocked(runTool).mockImplementationOnce(async (_command, args) => {
      const dumps = dumpTriples(args);
      fs.writeFileSync(dumps.find((dump) => dump.range === courseTextRange)!.file, '1000ffff\n00000000\n');
      return successResult('Error while attempting to save dump, file denied! Disk IO failed!');
    });
    expect((await runCourseDump())?.result.stderr).toContain('课程 DM 初始化 dump 失败');
  });

  it('cleans temporary dumps when the MARS invocation throws', async () => {
    let tempDir = '';
    vi.mocked(runTool).mockImplementationOnce(async (_command, args) => {
      tempDir = path.dirname(dumpTriples(args).find((dump) => dump.range !== courseTextRange)!.file);
      throw new Error('spawn failed');
    });

    const output = await runCourseDump();

    expect(output?.result.ok).toBe(false);
    expect(output?.result.stderr).toContain('课程 DM 初始化 dump 预检失败：spawn failed');
    expect(fs.existsSync(tempDir)).toBe(false);
  });

  it('rejects an exit-zero P7 kernel dump diagnostic instead of silently omitting the handler', async () => {
    mockP7KernelDump({
      stdout: 'Error while attempting to save dump, file denied! Disk IO failed!'
    });

    const output = await runCourseDump();

    expect(output?.result.ok).toBe(false);
    expect(output?.result.stderr).toContain('P7 内核机器码导出失败');
    expect(output?.result.stderr).toContain('Disk IO failed');
  });

  it('accepts only an explicitly empty P7 kernel segment when no dump file is produced', async () => {
    mockP7KernelDump({ stdout: '' });
    expect((await runCourseDump())?.result.stderr).toContain('未生成 kernel HexText');

    mockP7KernelDump({ stdout: 'This segment has not been written to, there is nothing to dump.' });
    expect((await runCourseDump())?.result.ok).toBe(true);
  });

  it('rejects malformed P7 kernel HexText and merges a valid contiguous handler image', async () => {
    mockP7KernelDump({ kernelText: 'not-hex\n' });
    expect((await runCourseDump())?.result.stderr).toContain('kernel HexText 包含非法行');

    mockP7KernelDump({ kernelText: '34010001\n' });
    const output = await runCourseDump();
    const merged = fs.readFileSync(path.join(runnerState.root, 'code.txt'), 'utf8').trim().split(/\r?\n/);

    expect(output?.result.ok).toBe(true);
    expect(merged).toHaveLength(((0x4180 - 0x3000) / 4) + 1);
    expect(merged[0]).toBe('1000ffff');
    expect(merged[1]).toBe('00000000');
    expect(merged[2]).toBe('00000000');
    expect(merged.at(-1)).toBe('34010001');
  });

  it('preserves ordinary dump exception behavior outside course preflight', async () => {
    vi.mocked(runTool).mockRejectedValueOnce(new Error('spawn failed'));

    await expect(runMarsFile(
      testServices(),
      vscode.Uri.file(path.join(runnerState.root, 'case.asm')),
      'dumpText',
      { p7RiInstruction: false, showMessages: false, revealOutput: false }
    )).rejects.toThrow('spawn failed');
  });
});

async function runCourseDump() {
  return runMarsFile(testServices(), vscode.Uri.file(path.join(runnerState.root, 'case.asm')), 'dumpText', {
    courseTrace: true,
    p7RiInstruction: false,
    showMessages: false,
    revealOutput: false
  });
}

function mockP7KernelDump(options: { stdout?: string; kernelText?: string }): void {
  runnerState.profile = 'P7';
  vi.mocked(runTool).mockImplementation(async (_command, args) => {
    const dumps = dumpTriples(args);
    const userText = dumps.find((dump) => dump.range === p7UserTextRange);
    if (userText) {
      fs.writeFileSync(userText.file, '1000ffff\n00000000\n');
      return successResult();
    }
    const kernelText = dumps.find((dump) => dump.range === p7KernelTextRange);
    if (kernelText && options.kernelText !== undefined) {
      fs.writeFileSync(kernelText.file, options.kernelText);
    }
    return successResult(options.stdout ?? '');
  });
}

function dumpTriples(args: readonly string[]): Array<{ range: string; format: string; file: string }> {
  const dumps: Array<{ range: string; format: string; file: string }> = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === 'dump') {
      dumps.push({ range: args[index + 1], format: args[index + 2], file: args[index + 3] });
      index += 3;
    }
  }
  return dumps;
}

function successResult(stdout = '') {
  return {
    ok: true,
    exitCode: 0,
    commandLine: 'java -jar Mars.jar',
    cwd: runnerState.root,
    stdout,
    stderr: '',
    timedOut: false
  };
}

function testServices() {
  return {
    output: {
      appendLine: vi.fn(), append: vi.fn(), show: vi.fn(), clear: vi.fn(), hide: vi.fn(), dispose: vi.fn(), name: 'test'
    } as never,
    statusBar: {} as never
  };
}
