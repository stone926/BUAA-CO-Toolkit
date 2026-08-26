import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readBoundedRegularFile } from '../../mips/replay/boundedFile';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('bounded replay bundle reads', () => {
  it('rejects the declared size before using it as an allocation size', async () => {
    const file = fixture(Buffer.from('safe'));
    await expect(readBoundedRegularFile(file, {
      maximumBytes: 1024,
      expectedBytes: 2048,
      label: 'snapshot'
    })).rejects.toThrow(/declared size 2048 exceeds the hard limit 1024/);
  });

  it('stats the open handle and rejects an oversized file before reading it', async () => {
    const file = fixture(Buffer.alloc(1025));
    await expect(readBoundedRegularFile(file, {
      maximumBytes: 1024,
      label: 'snapshot'
    })).rejects.toThrow(/size 1025 exceeds the hard limit 1024/);
  });

  it('requires the open file size to equal an authenticated snapshot declaration', async () => {
    const file = fixture(Buffer.from('four'));
    await expect(readBoundedRegularFile(file, {
      maximumBytes: 1024,
      expectedBytes: 3,
      label: 'snapshot'
    })).rejects.toThrow(/size mismatch: expected 3, got 4/);
  });
});

function fixture(bytes: Buffer): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-bounded-read-'));
  roots.push(root);
  const file = path.join(root, 'input.bin');
  fs.writeFileSync(file, bytes);
  return file;
}
