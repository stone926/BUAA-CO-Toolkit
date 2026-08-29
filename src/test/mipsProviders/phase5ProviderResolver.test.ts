import { afterEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';

const mocks = vi.hoisted(() => ({ engineMode: 'auto' }));

vi.mock('vscode', () => ({
  Uri: URI,
  workspace: {
    getWorkspaceFolder: () => undefined,
    getConfiguration: () => ({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      inspect: (key: string) => ({
        workspaceFolderValue: key === 'mips.engine' ? mocks.engineMode : undefined
      }),
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
  LEGACY_MARS_ENGINE_ID
} from '../../mips/providers/courseEnginePolicy';

const services = {
  output: { appendLine: vi.fn() },
  statusBar: {}
} as unknown as AppServices;

afterEach(() => { mocks.engineMode = 'auto'; });

describe('phase-5 assembler provider registration', () => {
  it('keeps legacy first and registers builtin-ts behind it', () => {
    const registry = registerDefaultProviders(services);
    expect(registry.assemblerProviders.map((provider) => provider.descriptor.id)).toEqual([
      'legacy-mars-configured',
      'builtin-ts'
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

  it('uses the resource-scoped mars setting as a one-setting legacy rollback', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-phase5-resolver-'));
    try {
      mocks.engineMode = 'mars';
      const sourceUri = URI.file(path.join(directory, 'main.asm'));
      await fs.promises.writeFile(sourceUri.fsPath, '.text\n    nop\n', 'utf8');

      const resolved = await resolveAssemblerProvider(services, {
        sourceUri,
        target: { kind: 'userText' },
        requirements: { profile: 'P6' }
      });

      expect(resolved.provider.descriptor.id).toBe(LEGACY_MARS_ENGINE_ID);
      expect(resolved.selection.mode).toBe('mars');
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('maps every P3-P7 auto assembler request to builtin and P2 to legacy', async () => {
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
      expect(p2.provider.descriptor.id).toBe(LEGACY_MARS_ENGINE_ID);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
