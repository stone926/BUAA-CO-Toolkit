import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({ EventEmitter: class {
  event = () => ({ dispose() {} }); fire() {} dispose() {}
} }));
import { MarsTerminal } from '../../mips/host/marsTerminal';
const terminal = () => new MarsTerminal(async () => ({ ok: true, exitCode: 0, commandLine: '', cwd: '', stdout: '', stderr: '', timedOut: false }));

describe('MARS pseudoterminal bounded input', () => {
  it('caps empty pasted lines and settles a waiting reader on close', async () => {
    const pty = terminal();
    pty.handleInput('\n'.repeat(5000));
    for (let i = 0; i < 1024; i++) expect(await pty.readLine()).toBe('\n');
    let settled = false;
    const pending = pty.readLine().then(value => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    pty.close();
    expect(await pending).toBeUndefined();
  });
  it('bounds total queued bytes across lines', async () => {
    const pty = terminal();
    pty.handleInput('a'.repeat(600000) + '\n' + 'b'.repeat(600000) + '\n');
    const first = await pty.readLine();
    const second = await pty.readLine();
    expect(first).toHaveLength(600001);
    expect(Buffer.byteLength(first! + second!)).toBeLessThanOrEqual(1024 * 1024);
    pty.close();
  });
  it('preserves characters and allows backspace before completing a line', async () => {
    const pty = terminal();
    pty.handleInput('12😀\x7f3\r\n');
    expect(await pty.readLine()).toBe('123\n');
    pty.close();
  });
});
