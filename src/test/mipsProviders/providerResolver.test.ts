import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getMipsEngine: vi.fn(),
  getMarsJar: vi.fn(),
  runMarsFile: vi.fn(),
  resolveLegacyMarsLaunch: vi.fn(),
  captureSourceGraph: vi.fn(),
  readBoundedRegularFile: vi.fn()
}));

vi.mock('vscode', async () => {
  const { URI } = await import('vscode-uri');
  return {
    Uri: {
      file: (file: string) => URI.file(file)
    },
    workspace: {
      getWorkspaceFolder: vi.fn(() => undefined)
    }
  };
});

vi.mock('../../config', () => ({
  getProfile: mocks.getProfile,
  getMipsEngine: mocks.getMipsEngine,
  getMarsJar: mocks.getMarsJar
}));

vi.mock('../../mips', async () => {
  const { URI } = await import('vscode-uri');
  return {
    runMarsFile: mocks.runMarsFile,
    marsRunOutputDirectory: vi.fn(() => URI.file('E:/work/.co/out')),
    marsOutputFileName: vi.fn(() => 'test.mars.out')
  };
});

vi.mock('../../mips/replay/sourceBundle', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../mips/replay/sourceBundle')>(),
  captureSourceGraph: mocks.captureSourceGraph
}));

vi.mock('../../mips/replay/boundedFile', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../mips/replay/boundedFile')>(),
  readBoundedRegularFile: mocks.readBoundedRegularFile
}));

import * as vscode from 'vscode';
import type { AppServices } from '../../types';
import type { EngineDescriptor } from '../../mips/core/api';
import {
  type AssembleRequest,
  failedPreflight,
  type ExecuteRequest,
  LEGACY_MARS_CAPABILITIES,
  MipsAssemblerProvider,
  MipsExecutionProvider,
  okPreflight
} from '../../mips/providers/contracts';
import {
  BUILTIN_TS_ENGINE_ID,
  LEGACY_MARS_ENGINE_ID,
  resolveCourseEnginePlan
} from '../../mips/providers/courseEnginePolicy';
import { createLegacyProgramImage } from '../../mips/replay/programImage';
import {
  assembleWithPreflight,
  executeWithPreflight,
  registerDefaultProviders,
  resolveAssemblerProvider,
  resolveExecutionProvider,
  setProviderRegistry
} from '../../mips/providers/providerResolver';

const services = (): AppServices => ({ output: {} as never, statusBar: {} as never });
const sourceUri = () => vscode.Uri.file('E:/work/test.asm');
const privateSourceUri = () => vscode.Uri.file('E:/private/source-bundle/source/materialized/source-0000.asm');

function testProgramImage() {
  return createLegacyProgramImage(
    '00000000\n00000000\n00000000\n00000000\n1000ffff\n00000000\n',
    [{ id: 'source-0000', contentHash: 'b'.repeat(64) }]
  );
}

function executeRequest(overrides: Partial<ExecuteRequest> = {}): ExecuteRequest {
  const image = testProgramImage();
  return {
    image,
    executionBinding: {
      kind: 'source-reassembly',
      providerId: 'legacy-mars-configured',
      sourceUri: sourceUri(),
      imageFingerprint: image.fingerprint
    },
    maxSteps: 256,
    haltPc: 0x3010,
    ...overrides
  };
}

afterEach(() => setProviderRegistry(undefined));

describe('provider resolver preflight boundary', () => {
  beforeEach(() => {
    setProviderRegistry(undefined);
    mocks.getProfile.mockReset();
    mocks.getMipsEngine.mockReset();
    mocks.getMarsJar.mockReset();
    mocks.runMarsFile.mockReset();
    mocks.resolveLegacyMarsLaunch.mockReset();
    mocks.captureSourceGraph.mockReset();
    mocks.readBoundedRegularFile.mockReset();
    mocks.getProfile.mockReturnValue('P6');
    mocks.getMipsEngine.mockReturnValue('auto');
    mocks.getMarsJar.mockReturnValue('E:/tools/Mars.jar');
    mocks.resolveLegacyMarsLaunch.mockImplementation(async (uri, mode) => ({
      diagnostics: [],
      launch: resolvedLaunch(uri.fsPath, mode)
    }));
    mocks.captureSourceGraph.mockResolvedValue({ rootMaterializedPath: privateSourceUri().fsPath });
    mocks.readBoundedRegularFile.mockResolvedValue(Buffer.from(
      '00000000\n00000000\n00000000\n00000000\n1000ffff\n00000000\n',
      'utf8'
    ));
  });

  it('selects a capable provider before dispatch and never invokes a rejected provider', async () => {
    const rejected = assemblerProvider('rejected', false);
    const selected = assemblerProvider('selected', true);
    setProviderRegistry({
      assemblerProviders: [rejected, selected],
      executionProviders: []
    });

    const result = await assembleWithPreflight(services(), {
      sourceUri: sourceUri(),
      target: { kind: 'userText' }
    });

    expect(rejected.preflight).toHaveBeenCalledOnce();
    expect(rejected.assemble).not.toHaveBeenCalled();
    expect(selected.preflight).toHaveBeenCalledOnce();
    expect(selected.assemble).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, preflight: { ok: true } });
  });

  it('does not fall back after a capable provider starts and returns a runtime failure', async () => {
    const selected = assemblerProvider('selected', true, false);
    const fallback = assemblerProvider('fallback', true);
    setProviderRegistry({
      assemblerProviders: [selected, fallback],
      executionProviders: []
    });

    const result = await assembleWithPreflight(services(), {
      sourceUri: sourceUri(),
      target: { kind: 'userText' }
    });

    expect(result.ok).toBe(false);
    expect(selected.assemble).toHaveBeenCalledOnce();
    expect(fallback.preflight).not.toHaveBeenCalled();
    expect(fallback.assemble).not.toHaveBeenCalled();
  });

  it('fails closed with the first stable diagnostic when no provider is capable', async () => {
    const first = assemblerProvider('first', false);
    const second = assemblerProvider('second', false);
    setProviderRegistry({
      assemblerProviders: [first, second],
      executionProviders: []
    });

    const result = await assembleWithPreflight(services(), {
      sourceUri: sourceUri(),
      target: { kind: 'userText' }
    });

    expect(result.result).toBeUndefined();
    expect(result.preflight.diagnostics[0].code).toBe('first.unsupported');
    expect(first.assemble).not.toHaveBeenCalled();
    expect(second.assemble).not.toHaveBeenCalled();
  });

  it('does not preflight-fallback after a standard phase-6 engine is selected', async () => {
    const builtin = assemblerProvider(BUILTIN_TS_ENGINE_ID, false);
    const legacy = assemblerProvider(LEGACY_MARS_ENGINE_ID, true);
    setProviderRegistry({
      assemblerProviders: [legacy, builtin],
      executionProviders: []
    });

    const result = await assembleWithPreflight(services(), {
      sourceUri: sourceUri(),
      target: { kind: 'userText' },
      requirements: { profile: 'P6' }
    });

    expect(result.ok).toBe(false);
    expect(result.preflight.descriptor.id).toBe(BUILTIN_TS_ENGINE_ID);
    expect(builtin.preflight).toHaveBeenCalledOnce();
    expect(builtin.assemble).not.toHaveBeenCalled();
    expect(legacy.preflight).not.toHaveBeenCalled();
    expect(legacy.assemble).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'gated auto',
      selection: resolveCourseEnginePlan('auto', 'P6'),
      expected: BUILTIN_TS_ENGINE_ID
    },
    {
      name: 'console auto',
      selection: resolveCourseEnginePlan('auto', 'P6', { deterministicConsole: true }),
      expected: BUILTIN_TS_ENGINE_ID
    },
    {
      name: 'explicit mars rollback',
      selection: resolveCourseEnginePlan('mars', 'P6'),
      expected: BUILTIN_TS_ENGINE_ID
    },
    {
      name: 'explicit builtin',
      selection: resolveCourseEnginePlan('builtin', 'P2'),
      expected: BUILTIN_TS_ENGINE_ID
    },
    {
      name: 'verify-both primary',
      selection: resolveCourseEnginePlan('verify-both', 'P7'),
      expected: BUILTIN_TS_ENGINE_ID
    }
  ])('uses one atomic assembler/executor engine for $name', async ({ selection, expected }) => {
    const builtinAssembler = assemblerProvider(BUILTIN_TS_ENGINE_ID, true);
    const legacyAssembler = assemblerProvider(LEGACY_MARS_ENGINE_ID, true);
    const builtinExecution = executionProvider(BUILTIN_TS_ENGINE_ID, true);
    const legacyExecution = executionProvider(LEGACY_MARS_ENGINE_ID, true);
    setProviderRegistry({
      assemblerProviders: [legacyAssembler, builtinAssembler],
      executionProviders: [legacyExecution, builtinExecution]
    });

    const [assembler, executor] = await Promise.all([
      resolveAssemblerProvider(services(), {
        sourceUri: sourceUri(),
        target: { kind: 'userText' },
        requirements: { profile: selection.profile }
      }, selection),
      resolveExecutionProvider(services(), executeRequest({
        profile: selection.profile
      }), selection)
    ]);

    expect(assembler.provider.descriptor.id).toBe(expected);
    expect(executor.provider.descriptor.id).toBe(expected);
    expect(assembler.selection).toBe(selection);
    expect(executor.selection).toBe(selection);
  });

  it('keeps default provider instances scoped to their AppServices owner', () => {
    const firstServices = services();
    const secondServices = services();

    expect(registerDefaultProviders(firstServices)).toBe(registerDefaultProviders(firstServices));
    expect(registerDefaultProviders(secondServices)).not.toBe(registerDefaultProviders(firstServices));
  });
});

function assemblerProvider(
  id: string,
  capable: boolean,
  resultOk = true
): MipsAssemblerProvider & { preflight: ReturnType<typeof vi.fn>; assemble: ReturnType<typeof vi.fn> } {
  const descriptor = engineDescriptor(id);
  return {
    descriptor,
    capabilities: LEGACY_MARS_CAPABILITIES,
    preflight: vi.fn(() => capable
      ? okPreflight(descriptor)
      : failedPreflight(descriptor, [{ code: `${id}.unsupported`, message: 'unsupported' }])),
    assemble: vi.fn(async () => ({
      ok: resultOk,
      status: { ...successfulRunStatus(), ok: resultOk },
      descriptor
    }))
  };
}

function executionProvider(
  id: string,
  capable: boolean
): MipsExecutionProvider & { preflight: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> } {
  const descriptor = { ...engineDescriptor(id), kind: 'executor' as const };
  return {
    descriptor,
    capabilities: LEGACY_MARS_CAPABILITIES,
    preflight: vi.fn(() => capable
      ? okPreflight(descriptor)
      : failedPreflight(descriptor, [{ code: `${id}.unsupported`, message: 'unsupported' }])),
    execute: vi.fn(async () => ({
      ok: true,
      status: successfulRunStatus(),
      descriptor
    }))
  };
}

function engineDescriptor(id: string): EngineDescriptor {
  return {
    id,
    kind: 'assembler',
    build: 'test',
    semanticsRevision: 1,
    capabilitiesRevision: 1
  };
}

function successfulRunStatus(stdout = '') {
  return {
    ok: true,
    exitCode: 0,
    stdout,
    stderr: '',
    timedOut: false,
    commandLine: 'java -jar Mars.jar',
    cwd: 'E:/work'
  };
}

function resolvedLaunch(sourcePath: string, mode: 'run' | 'dumpText' | 'dumpKernel') {
  return {
    sourcePath,
    mode,
    profile: 'P6',
    configuredMars: 'E:/tools/Mars.jar',
    memoryConfiguration: 'FixedCompactLargeText',
    runtime: { kind: 'java' as const, command: 'java' },
    wallClockMs: 10_000,
    p7RiInstruction: false,
    delayedBranching: true,
    extraArgs: []
  };
}
