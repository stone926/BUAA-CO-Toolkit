import { describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';

vi.mock('vscode', () => ({
  Uri: URI,
  workspace: {
    getWorkspaceFolder: () => undefined,
    getConfiguration: () => ({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      inspect: () => ({ workspaceValue: undefined }),
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

const services = {
  output: { appendLine: vi.fn() },
  statusBar: {}
} as unknown as AppServices;

describe('phase-5 assembler provider registration', () => {
  it('keeps legacy first and registers builtin-ts behind it', () => {
    const registry = registerDefaultProviders(services);
    expect(registry.assemblerProviders.map((provider) => provider.descriptor.id)).toEqual([
      'legacy-mars-configured',
      'builtin-ts'
    ]);
  });

  it('resolves builtin-ts explicitly', async () => {
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
      expect(selected.provider.descriptor.id).toBe('builtin-ts');
      expect(selected.preflight.ok).toBe(true);
      // Default resolution still tries legacy first; with Java absent legacy fails
      // and the resolver moves on rather than silently starting a process.
      const resolved = await resolveAssemblerProvider(services, request);
      expect(['legacy-mars-configured', 'builtin-ts']).toContain(resolved.provider.descriptor.id);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
