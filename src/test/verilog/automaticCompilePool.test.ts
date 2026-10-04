import { describe, expect, it } from 'vitest';
import { acquireAutomaticCompileDirectory } from '../../verilog/automaticCompilePool';

describe('automatic shared compilation leases', () => {
  it('shares equal testbenches and keeps different active testbenches separate', async () => {
    const first = (await acquireAutomaticCompileDirectory('E:/pool/equal', 'same'))!;
    const second = (await acquireAutomaticCompileDirectory('E:/pool/equal', 'same'))!;
    const other = (await acquireAutomaticCompileDirectory('E:/pool/equal', 'other'))!;
    expect(first.directory).toBe(second.directory);
    expect(first.directory).not.toBe(other.directory);
    first.release();
    first.release();
    second.release();
    other.release();
  });

  it('waits for VVP readers before replacing an equal-TB compiler artifact', async () => {
    const reader = (await acquireAutomaticCompileDirectory('E:/pool/readers', 'same'))!;
    const compiler = (await acquireAutomaticCompileDirectory('E:/pool/readers', 'same'))!;
    reader.startReading();
    let ready = false;
    const wait = compiler.waitForReaders().then(acquired => { ready = acquired; });
    await Promise.resolve();
    expect(ready).toBe(false);
    reader.release();
    await wait;
    expect(ready).toBe(true);
    compiler.release();
  });

  it('cancels a ninth distinct testbench without releasing or replacing any active directory', async () => {
    const leases = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      acquireAutomaticCompileDirectory('E:/pool/bounded', `testbench-${index}`)));
    const controller = new AbortController();
    const ninth = acquireAutomaticCompileDirectory('E:/pool/bounded', 'ninth', controller.signal);
    controller.abort();
    await expect(ninth).resolves.toBeUndefined();
    const matching = (await acquireAutomaticCompileDirectory('E:/pool/bounded', 'testbench-3'))!;
    expect(matching.directory).toBe(leases[3]!.directory);
    matching.release();
    leases.forEach(lease => lease!.release());
    const later = (await acquireAutomaticCompileDirectory('E:/pool/bounded', 'later'))!;
    expect(leases.some(lease => lease!.directory === later.directory)).toBe(true);
    later.release();
  });

  it('cancels an old-reader wait without blocking the reader or next compiler', async () => {
    const reader = (await acquireAutomaticCompileDirectory('E:/pool/cancel-readers', 'same'))!;
    const compiler = (await acquireAutomaticCompileDirectory('E:/pool/cancel-readers', 'same'))!;
    reader.startReading();
    const controller = new AbortController();
    const wait = compiler.waitForReaders(controller.signal);
    controller.abort();
    await expect(wait).resolves.toBe(false);
    compiler.release();
    reader.release();
    const next = (await acquireAutomaticCompileDirectory('E:/pool/cancel-readers', 'same'))!;
    await expect(next.waitForReaders()).resolves.toBe(true);
    next.release();
  });

  it('keeps a woken acquisition attached to its pool while idle workspace pools are trimmed', async () => {
    const root = 'E:/pool/wake-trim';
    const leases = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      acquireAutomaticCompileDirectory(root, `original-${index}`)));
    const otherWorkspaces = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      acquireAutomaticCompileDirectory(`E:/pool/trim-other-${index}`, 'active')));
    const waiting = acquireAutomaticCompileDirectory(root, 'waiting');
    leases.forEach(lease => lease!.release());
    // Resume waitForWake, then trim from an unrelated lease before the pending
    // acquisition's continuation consumes its directory.
    await Promise.resolve();
    otherWorkspaces[0]!.release();
    const matching = (await acquireAutomaticCompileDirectory(root, 'original-7'))!;
    expect(matching.directory).toBe(leases[7]!.directory);
    matching.release();
    (await waiting)!.release();
    otherWorkspaces.forEach(lease => lease!.release());
  });
});
