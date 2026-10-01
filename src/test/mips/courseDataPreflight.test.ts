import * as fs from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestServices as testServices } from '../helpers/appServices';

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
      activeTextEditor: undefined,
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
  getMemoryConfiguration: vi.fn(() => 'Default'),
  getMipsExtraArgs: vi.fn(() => []),
  getProfile: vi.fn(() => runnerState.profile),
  getRunTimeout: vi.fn(() => 30_000),
  useDelayedBranching: vi.fn(() => runnerState.profile === 'P5' || runnerState.profile === 'P6' || runnerState.profile === 'P7')
}));

vi.mock('../../process', () => ({
  commandLine: vi.fn((command: string, args: readonly string[]) => `${command} ${args.join(' ')}`),
  revealOutputChannel: vi.fn(),
  runTool: vi.fn()
}));

import * as vscode from 'vscode';
import { registerMips, runMarsFile, courseUserTextDumpRange, p7KernelTextDumpRange } from '../../mips';
import { runTool } from '../../process';
import { ensureConcreteProfile } from '../../config';
import { maximumReplayTraceBytes } from '../../mips/replay/boundedFile';

describe('official MARS runner', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    runnerState.profile = 'P2';
    runnerState.root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-official-mars-runner-'));
    runnerState.marsJar = path.join(runnerState.root, 'Mars4_5.jar');
    await fs.promises.writeFile(path.join(runnerState.root, 'case.asm'), '.text\nnop\n');
    await fs.promises.writeFile(runnerState.marsJar, 'official-mars-fixture');
    vi.mocked(runTool).mockResolvedValue(successResult());
  });

  afterEach(async () => {
    const directory = path.resolve(runnerState.root);
    expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(directory)).toMatch(/^co-official-mars-runner-/);
    await fs.promises.rm(directory, { recursive: true, force: true });
    runnerState.root = '';
    runnerState.marsJar = '';
    vscode.window.activeTextEditor = undefined;
  });

  it('uses original .text HexText without course data dumps or appended instructions', async () => {
    const dumpFile = vscode.Uri.file(path.join(runnerState.root, '输出 空格.txt'));
    vi.mocked(runTool).mockImplementation(async (_command, args) => {
      expect(args).toContain('ae1');
      expect(args).toContain('se1');
      expect(args.slice(args.indexOf('dump'), args.indexOf('dump') + 3)).toEqual(['dump', '.text', 'HexText']);
      await fs.promises.writeFile(args[args.indexOf('HexText') + 1], '34080001\n00000000\n');
      return successResult();
    });
    const output = await runMarsFile(testServices(), sourceUri(), 'dumpText', {
      dumpOutputFile: dumpFile, nonInteractive: true
    });
    expect(output?.result.ok).toBe(true);
    expect(await fs.promises.readFile(dumpFile.fsPath, 'utf8')).toBe('34080001\n00000000\n');
    expect(output?.courseHaltPc).toBeUndefined();
    expect(output?.engineArtifact?.sha256).toBe(crypto.createHash('sha256').update('official-mars-fixture').digest('hex'));
    expect(vi.mocked(runTool).mock.calls).toHaveLength(1);
  });

  it('preserves existing code when MARS returns success without a fresh dump', async () => {
    const dumpFile = vscode.Uri.file(path.join(runnerState.root, 'code.txt'));
    await fs.promises.writeFile(dumpFile.fsPath, 'old-code');
    const output = await runMarsFile(testServices(), sourceUri(), 'dumpText', {
      dumpOutputFile: dumpFile, nonInteractive: true
    });
    expect(output?.result.ok).toBe(false);
    expect(output?.result.stderr).toMatch(/导出失败/);
    expect(await fs.promises.readFile(dumpFile.fsPath, 'utf8')).toBe('old-code');
  });

  it('passes stdin, timeout, cancellation, and stream ceilings to the ordinary process', async () => {
    const owner = testServices();
    const signal = new AbortController().signal;
    vi.mocked(runTool).mockResolvedValue(successResult('42\n'));
    const output = await runMarsFile(owner, sourceUri(), 'run', {
      stdin: '42\n', signal, nonInteractive: true
    });
    const processOptions = vi.mocked(runTool).mock.calls[0][2];
    expect(processOptions).toMatchObject({ stdin: '42\n', signal, timeoutMs: 30000,
      maxStdoutBytes: maximumReplayTraceBytes, maxStderrBytes: maximumReplayTraceBytes });
    expect(output?.result.ok).toBe(true);
    expect(await fs.promises.readFile(output!.outputFile!.fsPath, 'utf8')).toBe('42\n');
    expect(owner.output.appendLine).not.toHaveBeenCalled();
  });

  it.each([
    { courseTrace: true }, { traceOutput: true }, { p7RiInstruction: true },
    { interruptSchedule: [0x3010] }, { p7InstructionClassDir: 'custom' }
  ])('rejects unsupported course requests %o before output/registry/process writes', async (options) => {
    const output = await runMarsFile(testServices(), sourceUri(), 'run', { ...options, nonInteractive: true });
    expect(output?.result.ok).toBe(false);
    expect(output?.result.stderr).toMatch(/builtin/);
    expect(runTool).not.toHaveBeenCalled();
    expect((await fs.promises.readdir(runnerState.root)).sort()).toEqual(['Mars4_5.jar', 'case.asm']);
  });

  it('rejects unsupported requests even when supplied with a saved launch', async () => {
    const output = await runMarsFile(testServices(), sourceUri(), 'run', {
      traceOutput: true, nonInteractive: true,
      resolvedLaunch: {
        profile: 'P2', configuredMars: runnerState.marsJar, memoryConfiguration: 'Default',
        runtime: { kind: 'java', command: 'java' }, wallClockMs: 30000,
        sourcePath: sourceUri().fsPath, mode: 'run', p7RiInstruction: false,
        delayedBranching: false, extraArgs: []
      }
    });
    expect(output?.result.ok).toBe(false);
    expect(runTool).not.toHaveBeenCalled();
    expect((await fs.promises.readdir(runnerState.root)).sort()).toEqual(['Mars4_5.jar', 'case.asm']);
  });

  it.each(['auto', 'P0', 'P1', 'P7'])('runs ordinary ASM without a Profile prompt under %s', async (profile) => {
    runnerState.profile = profile;
    const output = await runMarsFile(testServices(), sourceUri(), 'run', { stdin: '42\n', nonInteractive: true });
    expect(output?.result.ok).toBe(true);
    expect(ensureConcreteProfile).not.toHaveBeenCalled();
    expect(vi.mocked(runTool).mock.calls[0][2]?.stdin).toBe('42\n');
  });

  it.each(['auto', 'P0', 'P1', 'P7'])('runs terminal preflight without requiring a Profile under %s', async (profile) => {
    runnerState.profile = profile;
    const terminal = { show: vi.fn(), sendText: vi.fn() };
    vi.mocked(vscode.window.createTerminal).mockReturnValue(terminal as unknown as vscode.Terminal);
    vscode.window.activeTextEditor = { document: {
      languageId: 'mipsasm', isUntitled: false, isDirty: false, uri: sourceUri()
    } } as vscode.TextEditor;
    registerMips({ subscriptions: [] } as unknown as vscode.ExtensionContext, testServices());
    const callback = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === 'co.mips.runInTerminal')?.[1];
    expect(callback).toBeDefined();
    await callback!();
    expect(ensureConcreteProfile).not.toHaveBeenCalled();
    expect(vscode.window.createTerminal).toHaveBeenCalled();
    expect(terminal.sendText).toHaveBeenCalledWith(expect.stringContaining('case.asm'), true);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it.each(['Invalid Command Argument: no-such-option', 'Invalid memory configuration: BadConfig',
    'Invalid/unaligned address or invalid range: 1-5'])('rejects CLI failure despite exit zero: %s', async (message) => {
    vi.mocked(runTool).mockResolvedValue({ ...successResult(), stderr: message });
    const output = await runMarsFile(testServices(), sourceUri(), 'run', { nonInteractive: true });
    expect(output?.result.ok).toBe(false);
    expect(output?.result.stderr).toMatch(/参数解析失败/);
  });

  it('allows console output that happens to look like a CLI diagnostic', async () => {
    vi.mocked(runTool).mockResolvedValue(successResult('Invalid Command Argument: example'));
    const output = await runMarsFile(testServices(), sourceUri(), 'run', { nonInteractive: true });
    expect(output?.result.ok).toBe(true);
    expect(vi.mocked(runTool).mock.calls[0][1]).toContain('me');
  });

  it('retains inclusive course address helpers only for archive callers', () => {
    expect(courseUserTextDumpRange('P7')).toBe('0x00003000-0x00004180');
    expect(courseUserTextDumpRange('P6')).toBe('0x00003000-0x00007000');
    expect(p7KernelTextDumpRange()).toBe('0x00004180-0x00007000');
  });
});

function sourceUri(): vscode.Uri {
  return vscode.Uri.file(path.join(runnerState.root, 'case.asm'));
}

function successResult(stdout = '') {
  return { ok: true, exitCode: 0, commandLine: 'java fixture', cwd: runnerState.root,
    stdout, stderr: '', timedOut: false };
}
