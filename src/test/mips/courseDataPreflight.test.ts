import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import { createTestServices } from '../helpers/appServices';

const state = vi.hoisted(() => ({ root: '', timeout: 30000, delayed: false }));
vi.mock('vscode', () => ({
  Uri: URI,
  workspace: { getWorkspaceFolder: () => ({ uri: URI.file(state.root) }) },
  window: { showInformationMessage: vi.fn(), showErrorMessage: vi.fn() }
}));
vi.mock('../../config', () => ({
  getMachineCode: () => 'code.txt', getMemoryConfiguration: () => 'Default',
  getRunTimeout: () => state.timeout, useDelayedBranching: () => state.delayed, shouldRevealOutput: () => false
}));
vi.mock('../../process', () => ({ revealOutputChannel: vi.fn(), runTool: vi.fn() }));
import { runMarsFile } from '../../mips';
import { runTool } from '../../process';

describe('internal MARS command runner', () => {
  beforeEach(async () => {
    state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-internal-mars-'));
    state.timeout = 30000; state.delayed = false; vi.clearAllMocks();
  });
  afterEach(async () => {
    expect(path.dirname(path.resolve(state.root))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(state.root)).toMatch(/^co-internal-mars-/);
    await fs.rm(state.root, { recursive: true, force: true });
  });
  async function source(text: string) {
    const uri = URI.file(path.join(state.root, '程序 空格.asm'));
    await fs.writeFile(uri.fsPath, text); return uri;
  }
  it('assembles includes/macros and executes console services without Java or a jar', async () => {
    await fs.writeFile(path.join(state.root, '宏 文件.asm'), '.macro print(%n)\nli $a0,%n\nli $v0,1\nsyscall\n.end_macro\n');
    const uri = await source('.include "宏 文件.asm"\n.text\nprint(42)\nli $v0,10\nsyscall\n');
    const output = await runMarsFile(createTestServices(), uri, 'run', { nonInteractive: true });
    expect(output?.result).toMatchObject({ ok: true, stdout: '42', exitCode: 0 });
    expect(await fs.readFile(output!.outputFile!.fsPath, 'utf8')).toBe('42');
    expect(runTool).not.toHaveBeenCalled();
  });
  it('exports exact ordinary text and preserves previous output on assembly errors', async () => {
    const uri = await source('.text\nli $a0,42\nli $v0,1\nsyscall\n');
    const options = { nonInteractive: true, dumpOutputFile: URI.file(path.join(state.root, '输出.txt')) };
    const result = await runMarsFile(createTestServices(), uri, 'dumpText', options);
    expect(result?.result.ok).toBe(true);
    const bytes = await fs.readFile(options.dumpOutputFile.fsPath, 'utf8');
    expect(bytes.trim().split(/\r?\n/)).toEqual(['2404002a', '24020001', '0000000c']);
    await fs.writeFile(uri.fsPath, '.text\nbad_instruction\n');
    expect((await runMarsFile(createTestServices(), uri, 'dumpText', options))?.result.ok).toBe(false);
    expect(await fs.readFile(options.dumpOutputFile.fsPath, 'utf8')).toBe(bytes);
  });
  it('consumes stdin and reports invalid numeric input', async () => {
    const uri = await source('.text\nli $v0,5\nsyscall\nmove $a0,$v0\nli $v0,1\nsyscall\n');
    expect((await runMarsFile(createTestServices(), uri, 'run', { nonInteractive: true, stdin: '-73\n' }))?.result)
      .toMatchObject({ ok: true, stdout: '-73' });
    expect((await runMarsFile(createTestServices(), uri, 'run', { nonInteractive: true, stdin: 'bad\n' }))?.result.ok).toBe(false);
  });
  it.each([{ courseTrace: true }, { traceOutput: true }, { p7RiInstruction: true }, { interruptSchedule: [0x3010] }])(
    'rejects course oracle options in ordinary console mode: %o', async (options) => {
      const uri = await source('.text\nsyscall\n');
      const output = await runMarsFile(createTestServices(), uri, 'run', { ...options, nonInteractive: true });
      expect(output?.result).toMatchObject({ ok: false, stdout: '' });
      expect(output?.result.stderr).toContain('P7 syscall');
      expect(runTool).not.toHaveBeenCalled();
      expect(await fs.readdir(state.root)).toEqual(['程序 空格.asm']);
    });
  it('times out an infinite loop and handles a pre-cancelled run', async () => {
    const uri = await source('.text\nloop: j loop\nnop\n');
    state.timeout = 30;
    const output = await runMarsFile(createTestServices(), uri, 'run', { nonInteractive: true, maxSteps: 100000000 });
    expect(output?.result).toMatchObject({ ok: false, timedOut: true, stopReason: 'timeout' });
    const controller = new AbortController(); controller.abort();
    expect((await runMarsFile(createTestServices(), uri, 'run', { nonInteractive: true, signal: controller.signal }))?.result)
      .toMatchObject({ ok: false, stopReason: 'cancelled' });
  });
});
