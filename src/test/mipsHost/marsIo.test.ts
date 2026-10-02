import { describe, expect, it, vi } from 'vitest';
import { MarsHostIo } from '../../mips/host/marsIo';

describe('ordinary MARS host I/O', () => {
  it('preserves binary stdin and streams UTF-8 stdout across syscall boundaries', async () => {
    const write = vi.fn();
    const io = new MarsHostIo({ cwd: process.cwd(), stdin: Uint8Array.from([255, 0, 128, 65]),
      signal: new AbortController().signal, console: { write } });
    try {
      expect((await io.respond({ id: 0, service: 14, kind: 'read-file', fd: 0, length: 4 })).bytes).toEqual([255, 0, 128, 65]);
      for (const [id, byte] of [...Buffer.from('中')].entries()) {
        await io.respond({ id: id + 1, service: 15, kind: 'write-file', fd: 1, bytes: [byte] });
      }
      await io.finishOutput();
      expect(write.mock.calls.flat().join('')).toBe('中');
    } finally { await io.dispose(); }
  });
  it('preserves UTF-8 stdin bytes across partial file reads', async () => {
    const io = new MarsHostIo({ cwd: process.cwd(), stdin: '中A\n', signal: new AbortController().signal, console: { write() {} } });
    try {
      const bytes = [];
      for (let id = 0; id < 5; id++) {
        const result = await io.respond({ id, service: 14, kind: 'read-file', fd: 0, length: 1 });
        bytes.push(...result.bytes!);
      }
      expect(bytes).toEqual([...Buffer.from('中A\n')]);
    } finally { await io.dispose(); }
  });
  it('does not block for zero-byte reads and interrupts a pending interactive read', async () => {
    const controller = new AbortController();
    const readLine = vi.fn(() => new Promise<string | undefined>(() => undefined));
    const io = new MarsHostIo({ cwd: process.cwd(), signal: controller.signal, console: { write() {}, readLine } });
    expect(await io.respond({ id: 1, service: 14, kind: 'read-file', fd: 0, length: 0 })).toEqual({ id: 1, bytes: [] });
    expect(readLine).not.toHaveBeenCalled();
    const result = io.respond({ id: 2, service: 5, kind: 'read-int' });
    controller.abort();
    await expect(result).rejects.toThrow('cancelled');
    await io.dispose();
  });
  it('bounds emitted UTF-8 bytes before calling the output consumer', async () => {
    const write = vi.fn();
    const io = new MarsHostIo({ cwd: process.cwd(), maximumBytes: 3, signal: new AbortController().signal, console: { write } });
    await io.respond({ id: 1, service: 4, kind: 'write', text: '中' });
    await expect(io.respond({ id: 2, service: 4, kind: 'write', text: 'a' })).rejects.toThrow('上限');
    expect(write.mock.calls).toEqual([['中']]);
    await io.dispose();
  });
});
