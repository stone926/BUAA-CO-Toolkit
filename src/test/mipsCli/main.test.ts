import { Readable, Writable } from 'stream';
import { describe, expect, it } from 'vitest';
import {
  mipsEngineCliMaximumLineBytes,
  runMipsEngineCli
} from '../../mips/cli/main';

function capture(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    }),
    text: () => Buffer.concat(chunks).toString('utf8')
  };
}

describe('MIPS JSONL CLI stream boundary', () => {
  it('treats an empty or blank-only stream as a usage error', async () => {
    for (const input of ['', '\n \r\n\t\n']) {
      const stdout = capture();
      const stderr = capture();
      await expect(runMipsEngineCli(
        Readable.from([input]), stdout.stream, stderr.stream
      )).resolves.toBe(2);
      expect(stdout.text()).toBe('');
      expect(stderr.text()).toContain('expected JSONL requests');
    }
  });

  it('discards an oversized line at the byte cap and continues with the next request', async () => {
    const stdout = capture();
    const stderr = capture();
    const valid = JSON.stringify({ protocolVersion: 1, requestId: 'after-large', operation: 'describe' });
    const chunks = [
      Buffer.alloc(mipsEngineCliMaximumLineBytes, 0x20),
      Buffer.from(`x\n${valid}\n`)
    ];

    await expect(runMipsEngineCli(
      Readable.from(chunks), stdout.stream, stderr.stream
    )).resolves.toBe(1);
    const responses = stdout.text().trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({ ok: false, error: { code: 'request-too-large' } });
    expect(responses[1]).toMatchObject({ requestId: 'after-large', ok: true });
  });

  it('rejects non-lossless UTF-8 instead of parsing replacement characters', async () => {
    const stdout = capture();
    const stderr = capture();
    const invalid = Buffer.concat([
      Buffer.from('{"protocolVersion":1,"requestId":"'),
      Buffer.from([0xff]),
      Buffer.from('","operation":"describe"}\n')
    ]);

    await expect(runMipsEngineCli(
      Readable.from([invalid]), stdout.stream, stderr.stream
    )).resolves.toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false,
      error: { code: 'invalid-utf8' }
    });
  });
});
