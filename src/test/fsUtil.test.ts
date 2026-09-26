import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import * as vscode from 'vscode';
import { writeTextFileIfAbsent, writeTextFileIfChanged } from '../fsUtil';

const vscodeState = vi.hoisted(() => ({
  module: undefined as ReturnType<typeof import('./helpers/vscodeMock').createVscodeModuleMock> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('./helpers/vscodeMock');
  vscodeState.module = createVscodeModuleMock(createVscodeMockState(), vi.fn);
  return vscodeState.module;
});

describe('writeTextFileIfChanged', () => {
  const target = URI.file('E:/work/.co/iverilog/co_iverilog_watchdog.v');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps an identical generated file untouched', async () => {
    vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
      type: vscode.FileType.File,
      size: 3,
      ctime: 1,
      mtime: 1
    });
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('abc'));

    await expect(writeTextFileIfChanged(target, 'abc')).resolves.toBe(false);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('does not read an existing file whose size cannot match', async () => {
    vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
      type: vscode.FileType.File,
      size: 10_000_000,
      ctime: 1,
      mtime: 1
    });

    await expect(writeTextFileIfChanged(target, 'abc')).resolves.toBe(true);
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(target, Buffer.from('abc'));
  });

  it('refuses to overwrite a predictable generated path through a symbolic link', async () => {
    vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
      type: vscode.FileType.File | vscode.FileType.SymbolicLink,
      size: 3,
      ctime: 1,
      mtime: 1
    });

    await expect(writeTextFileIfChanged(target, 'abc')).rejects.toThrow(/symbolic link/);
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });
});

describe('writeTextFileIfAbsent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a missing local file but never replaces an existing one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-write-absent-'));
    try {
      const target = URI.file(path.join(dir, 'alu_tb.v'));

      await expect(writeTextFileIfAbsent(target, 'first')).resolves.toBe(true);
      await expect(writeTextFileIfAbsent(target, 'second')).resolves.toBe(false);

      expect(fs.readFileSync(target.fsPath, 'utf8')).toBe('first');
      expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks virtual files before writing through the VS Code file system', async () => {
    const target = URI.parse('memfs:/work/.co/tb/alu_tb.v');
    vi.mocked(vscode.workspace.fs.stat).mockResolvedValueOnce({ type: vscode.FileType.File, size: 1, ctime: 1, mtime: 1 });
    await expect(writeTextFileIfAbsent(target, 'x')).resolves.toBe(false);

    vi.mocked(vscode.workspace.fs.stat).mockRejectedValueOnce(new Error('missing'));
    await expect(writeTextFileIfAbsent(target, 'x')).resolves.toBe(true);

    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(target, Buffer.from('x'));
  });
});
