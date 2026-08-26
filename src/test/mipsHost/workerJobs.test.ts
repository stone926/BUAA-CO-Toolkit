import { describe, expect, it, vi } from 'vitest';
import {
  executeProductionWorkerJob,
  mipsWorkerMaximumBatch,
  mipsWorkerSliceSize
} from '../../mips/host/workerJobs';

const scope = { profile: 'P7', enabledLayers: ['required'] };

describe('production MIPS worker jobs', () => {
  it('streams decoded results in bounded slices', async () => {
    const batches: unknown[][] = [];
    const yieldControl = vi.fn(async () => undefined);
    const words = new Array(mipsWorkerSliceSize + 1).fill('0x00000000');

    const result = await executeProductionWorkerJob('isa-decode-batch', { words, scope }, {
      signal: new AbortController().signal,
      emitProgress: (batch) => { batches.push(batch); },
      yieldControl
    });

    expect(result).toEqual({ processed: words.length, sliceSize: mipsWorkerSliceSize });
    expect(batches.map((batch) => batch.length)).toEqual([mipsWorkerSliceSize, 1]);
    expect(batches[0][0]).toMatchObject({ exactMnemonic: 'nop', canonicalMnemonic: 'nop' });
    expect(yieldControl).toHaveBeenCalledTimes(1);
  });

  it('observes cancellation at the next slice boundary', async () => {
    const controller = new AbortController();
    const batches: unknown[][] = [];

    await expect(executeProductionWorkerJob('isa-decode-batch', {
      words: new Array(mipsWorkerSliceSize * 3).fill('0x00000000'),
      scope
    }, {
      signal: controller.signal,
      emitProgress: (batch) => { batches.push(batch); },
      yieldControl: async () => controller.abort()
    })).rejects.toThrow('cancelled');

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(mipsWorkerSliceSize);
  });

  it('encodes real instructions and rejects malformed payloads before work', async () => {
    const batches: unknown[][] = [];
    const context = {
      signal: new AbortController().signal,
      emitProgress: (batch: unknown[]) => { batches.push(batch); }
    };
    const result = await executeProductionWorkerJob('isa-encode-batch', {
      entries: [{ mnemonic: 'add', operands: { rd: 9, rs: 10, rt: 11 } }]
    }, context);
    expect(result).toEqual({ processed: 1, sliceSize: mipsWorkerSliceSize });
    expect(batches[0][0]).toEqual({ mnemonic: 'add', word: '0x014b4820' });

    await expect(executeProductionWorkerJob('isa-decode-batch', {
      words: new Array(mipsWorkerMaximumBatch + 1).fill('0x00000000'),
      scope
    }, context)).rejects.toThrow(/1\.\.65536/);
    await expect(executeProductionWorkerJob('unknown', {}, context)).rejects.toThrow(/unknown job kind/);
  });
});
