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
import {
  BUILTIN_TS_ENGINE_ID,
  OFFICIAL_MARS_ENGINE_ID,
  resolveCourseEnginePlan
} from '../../mips/providers/courseEnginePolicy';

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
  it('keeps stable registration order but defaults a gated profile to builtin', async () => {
    const registry = registerDefaultProviders(services);
    expect(registry.executionProviders.map((provider) => provider.descriptor.id)).toEqual([
      'official-mars-configured',
      'builtin-ts'
    ]);
    const selected = await resolveExecutionProvider(services, request);
    expect(selected.provider.descriptor.id).toBe(BUILTIN_TS_ENGINE_ID);
    expect(selected.preflight.ok).toBe(true);
  });

  it('resolves builtin explicitly for shadow/verify-both', async () => {
    const selected = await resolveBuiltinExecutionProvider(services, request);
    expect(selected.provider.descriptor.id).toBe('builtin-ts');
    expect(selected.preflight.ok).toBe(true);
  });

  it('reports unsupported P2 images and course console without a fork fallback', async () => {
    const p2 = await resolveExecutionProvider(services, { ...request, profile: 'P2' });
    const console = await resolveExecutionProvider(services, {
      ...request,
      requirements: { profile: 'P5', deterministicConsole: true }
    });

    expect(p2.provider.descriptor.id).toBe(OFFICIAL_MARS_ENGINE_ID);
    expect(p2.preflight.ok).toBe(false);
    expect(console.provider.descriptor.id).toBe(BUILTIN_TS_ENGINE_ID);
    expect(console.preflight.ok).toBe(false);
  });

  it.each([
    ['builtin', BUILTIN_TS_ENGINE_ID],
    ['mars', BUILTIN_TS_ENGINE_ID],
    ['verify-both', BUILTIN_TS_ENGINE_ID]
  ] as const)('preserves explicit %s execution selection', async (mode, engineId) => {
    const plan = resolveCourseEnginePlan(mode, 'P5');
    const selected = await resolveExecutionProvider(services, request, plan);

    expect(selected.provider.descriptor.id).toBe(engineId);
    expect(selected.selection).toBe(plan);
  });
});
