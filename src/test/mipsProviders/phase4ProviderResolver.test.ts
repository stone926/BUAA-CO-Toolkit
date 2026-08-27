import { describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';

vi.mock('vscode', () => ({ Uri: URI }));

import {
  registerDefaultProviders,
  resolveBuiltinExecutionProvider,
  resolveExecutionProvider
} from '../../mips/providers/providerResolver';
import { buildProgramImage } from '../../mips/core/programImage';
import { sourceUnitFingerprint } from '../../mips/core/programImage';
import type { AppServices } from '../../types';
import type { ExecuteRequest } from '../../mips/providers/contracts';

const services = {
  output: { appendLine: vi.fn() },
  statusBar: {}
} as unknown as AppServices;

const image = buildProgramImage({
  entryPc: 0x3000,
  segments: [{ name: 'text', baseAddress: 0x3000, words: [0x3408002a, 0x1000ffff, 0x00000000] }],
  inputGraph: [sourceUnitFingerprint({ id: 'root.asm', text: 'x' })]
});

const request: ExecuteRequest = {
  profile: 'P5',
  image,
  trace: { kind: 'architectural-writes', courseCorrect: true },
  maxSteps: 64,
  haltPc: 0x3004,
  courseTrace: true
};

describe('phase-4 provider resolver registration', () => {
  it('keeps legacy MARS as the default execution provider', async () => {
    const registry = registerDefaultProviders(services);
    expect(registry.executionProviders.map((provider) => provider.descriptor.id)).toEqual([
      'legacy-mars-configured',
      'builtin-ts'
    ]);
    // Without the provider-owned source binding, legacy preflight correctly
    // fails and the resolver chooses the only capable executor. No execution
    // ever starts after a failed legacy preflight.
    const selected = await resolveExecutionProvider(services, request);
    expect(selected.preflight.descriptor.id).toBe('builtin-ts');
  });

  it('resolves builtin explicitly for shadow/verify-both', async () => {
    const selected = await resolveBuiltinExecutionProvider(services, request);
    expect(selected.provider.descriptor.id).toBe('builtin-ts');
    expect(selected.preflight.ok).toBe(true);
  });
});
