import { describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';

vi.mock('vscode', () => ({
  Uri: URI,
  workspace: {
    getWorkspaceFolder: () => undefined,
    getConfiguration: () => ({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      inspect: () => ({}),
      update: vi.fn()
    })
  }
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  registerDefaultProviders,
  resolveAssemblerProvider,
  resolveBuiltinAssemblerProvider
} from '../../mips/providers/providerResolver';
import type { AppServices } from '../../types';
import type { AssembleRequest } from '../../mips/providers/contracts';
import {
  BUILTIN_TS_ENGINE_ID,
  CUSTOM_MARS_ENGINE_ID,
  resolveCourseEnginePlan
} from '../../mips/providers/courseEnginePolicy';

const services = {
  output: { appendLine: vi.fn() },
  statusBar: {}
} as unknown as AppServices;

describe('phase-5 assembler provider registration', () => {
  it('registers the internal and optional custom Mars assemblers', () => {
    const registry = registerDefaultProviders(services);
    expect(registry.assemblerProviders.map((provider) => provider.descriptor.id)).toEqual([
      BUILTIN_TS_ENGINE_ID,
      CUSTOM_MARS_ENGINE_ID
    ]);
  });

  it('resolves builtin-ts explicitly and by default for gated profiles', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-phase5-resolver-'));
    try {
      const sourceUri = URI.file(path.join(directory, 'main.asm'));
      await fs.promises.writeFile(sourceUri.fsPath, '.text\n    nop\n', 'utf8');
      const request: AssembleRequest = {
        sourceUri,
        target: { kind: 'userText' },
        requirements: { profile: 'P3', pseudoInstructions: true }
      };
      const selected = await resolveBuiltinAssemblerProvider(services, request);
      expect(selected.provider.descriptor.id).toBe(BUILTIN_TS_ENGINE_ID);
      expect(selected.preflight.ok).toBe(true);
      const resolved = await resolveAssemblerProvider(services, request);
      expect(resolved.provider.descriptor.id).toBe(BUILTIN_TS_ENGINE_ID);
      expect(resolved.preflight.ok).toBe(true);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('selects the custom Mars assembler only for an explicit internal Mars plan', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-phase5-resolver-'));
    try {
      const sourceUri = URI.file(path.join(directory, 'main.asm'));
      await fs.promises.writeFile(sourceUri.fsPath, '.text\n    nop\n', 'utf8');

      const resolved = await resolveAssemblerProvider(services, {
        sourceUri,
        target: { kind: 'userText' },
        requirements: { profile: 'P6' }
      }, resolveCourseEnginePlan('mars', 'P6'));

      expect(resolved.provider.descriptor.id).toBe(CUSTOM_MARS_ENGINE_ID);
      expect(resolved.selection.mode).toBe('mars');
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('maps every P2-P7 auto assembler request to builtin', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-phase5-resolver-'));
    try {
      const sourceUri = URI.file(path.join(directory, 'main.asm'));
      await fs.promises.writeFile(sourceUri.fsPath, '.text\n    nop\n', 'utf8');
      for (const profile of ['P3', 'P4', 'P5', 'P6', 'P7']) {
        const resolved = await resolveAssemblerProvider(services, {
          sourceUri,
          target: { kind: 'userText' },
          requirements: { profile }
        });
        expect(resolved.provider.descriptor.id, profile).toBe(BUILTIN_TS_ENGINE_ID);
      }
      const p2 = await resolveAssemblerProvider(services, {
        sourceUri,
        target: { kind: 'userText' },
        requirements: { profile: 'P2' }
      });
      expect(p2.provider.descriptor.id).toBe(BUILTIN_TS_ENGINE_ID);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
