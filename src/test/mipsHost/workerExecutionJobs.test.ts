import { describe, expect, it, vi } from 'vitest';
import { executeProductionWorkerJob } from '../../mips/host/workerJobs';

function context() {
  return {
    signal: new AbortController().signal,
    emitProgress: vi.fn(async () => undefined),
    yieldControl: async () => undefined
  };
}

describe('phase-4 worker execution jobs', () => {
  it('runs machine-execute through the same bounded service as the CLI', async () => {
    const result = await executeProductionWorkerJob('machine-execute', {
      profile: 'P5',
      enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
      segments: [{
        name: 'text',
        baseAddress: '0x00003000',
        words: ['0x3408002a', '0x1000ffff', '0x00000000']
      }],
      entryPc: '0x00003000',
      maxSteps: 64,
      haltPc: '0x00003004',
      collectTrace: true,
      collectCoverage: true
    }, context());
    expect(result.status).toBe('halted');
    expect(result.trace).toContain('@00003000: $8 <= 0000002A');
    expect(result.finalStateDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('runs device-cycle-vector through the worker boundary', async () => {
    const result = await executeProductionWorkerJob('device-cycle-vector', [
      { kind: 'reset' },
      { kind: 'write', device: 'timer0', register: 'ctrl', value: '0x00000001' },
      { kind: 'tick', cycles: 1 }
    ], context());
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
    expect(result[2].timer0.state).toBe('idle');
    expect(result[2].timer0.ctrl).toBe('0x00000001');
  });
});
