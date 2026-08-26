import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getMarsJar: vi.fn(),
  runMarsFile: vi.fn(),
  resolveLegacyMarsLaunch: vi.fn()
}));

vi.mock('vscode', async () => {
  const { URI } = await import('vscode-uri');
  return {
    Uri: {
      file: (file: string) => URI.file(file)
    }
  };
});

vi.mock('../../config', () => ({
  getProfile: mocks.getProfile,
  getMarsJar: mocks.getMarsJar
}));

vi.mock('../../mips', () => ({
  runMarsFile: mocks.runMarsFile
}));

vi.mock('../../mips/providers/legacyMarsLaunch', () => ({
  resolveLegacyMarsLaunch: mocks.resolveLegacyMarsLaunch
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
  okPreflight
} from '../../mips/providers/contracts';
import { LegacyMarsProvider } from '../../mips/providers/legacyMarsProvider';
import {
  assembleWithPreflight,
  executeWithPreflight,
  registerDefaultProviders,
  setProviderRegistry
} from '../../mips/providers/providerResolver';

const services = (): AppServices => ({ output: {} as never, statusBar: {} as never });
const sourceUri = () => vscode.Uri.file('E:/work/test.asm');

afterEach(() => setProviderRegistry(undefined));

describe('provider resolver preflight boundary', () => {
  beforeEach(() => {
    setProviderRegistry(undefined);
    mocks.getProfile.mockReset();
    mocks.getMarsJar.mockReset();
    mocks.runMarsFile.mockReset();
    mocks.resolveLegacyMarsLaunch.mockReset();
    mocks.getProfile.mockReturnValue('P6');
    mocks.getMarsJar.mockReturnValue('E:/tools/Mars.jar');
    mocks.resolveLegacyMarsLaunch.mockImplementation(async (uri, mode) => ({
      diagnostics: [],
      launch: resolvedLaunch(uri.fsPath, mode)
    }));
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

  it('keeps default provider instances scoped to their AppServices owner', () => {
    const firstServices = services();
    const secondServices = services();

    expect(registerDefaultProviders(firstServices)).toBe(registerDefaultProviders(firstServices));
    expect(registerDefaultProviders(secondServices)).not.toBe(registerDefaultProviders(firstServices));
  });
});

describe('LegacyMarsProvider capability and dispatch contract', () => {
  beforeEach(() => {
    setProviderRegistry(undefined);
    mocks.getProfile.mockReset();
    mocks.getMarsJar.mockReset();
    mocks.runMarsFile.mockReset();
    mocks.resolveLegacyMarsLaunch.mockReset();
    mocks.getProfile.mockReturnValue('P6');
    mocks.getMarsJar.mockReturnValue('E:/tools/Mars.jar');
    mocks.resolveLegacyMarsLaunch.mockImplementation(async (uri, mode) => ({
      diagnostics: [],
      launch: resolvedLaunch(uri.fsPath, mode)
    }));
  });

  it('reports stable profile and tool diagnostics before running MARS', async () => {
    mocks.getProfile.mockReturnValue('P1');
    mocks.getMarsJar.mockReturnValue('');
    mocks.resolveLegacyMarsLaunch.mockResolvedValueOnce({
      diagnostics: [
        { code: 'legacy-mars.profile-unsupported', message: 'unsupported profile' },
        { code: 'legacy-mars.jar-not-configured', message: 'jar missing' }
      ]
    });
    const provider = new LegacyMarsProvider(services());
    setProviderRegistry({ assemblerProviders: [provider], executionProviders: [provider] });

    const result = await assembleWithPreflight(services(), {
      sourceUri: sourceUri(),
      target: { kind: 'userText' }
    });

    expect(result.preflight.diagnostics.map((item) => item.code)).toEqual([
      'legacy-mars.profile-unsupported',
      'legacy-mars.jar-not-configured'
    ]);
    expect(mocks.runMarsFile).not.toHaveBeenCalled();
  });

  it('rejects ProgramImage and incomplete course execution before side effects', async () => {
    mocks.resolveLegacyMarsLaunch.mockResolvedValueOnce({
      diagnostics: [
        { code: 'legacy-mars.max-steps-required', message: 'maxSteps missing' },
        { code: 'legacy-mars.halt-pc-required', message: 'haltPc missing' }
      ]
    });
    const provider = new LegacyMarsProvider(services());
    setProviderRegistry({ assemblerProviders: [provider], executionProviders: [provider] });

    const result = await executeWithPreflight(services(), {
      sourceUri: sourceUri(),
      imageRef: { kind: 'program-image', image: {} as never },
      courseTrace: true
    });

    expect(result.preflight.diagnostics.map((item) => item.code)).toEqual([
      'legacy-mars.program-image-unsupported',
      'legacy-mars.max-steps-required',
      'legacy-mars.halt-pc-required'
    ]);
    expect(mocks.runMarsFile).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range halt PC before running MARS', async () => {
    mocks.resolveLegacyMarsLaunch.mockResolvedValueOnce({
      diagnostics: [{ code: 'legacy-mars.halt-pc-required', message: 'haltPc invalid' }]
    });
    const provider = new LegacyMarsProvider(services());
    setProviderRegistry({ assemblerProviders: [provider], executionProviders: [provider] });

    const result = await executeWithPreflight(services(), {
      sourceUri: sourceUri(),
      imageRef: {
        kind: 'mars-dump',
        machineCodeUri: vscode.Uri.file('E:/work/code.txt'),
        haltPc: 0x1_0000_0000
      },
      courseTrace: true,
      maxSteps: 32
    });

    expect(result.preflight.diagnostics.map((item) => item.code)).toEqual([
      'legacy-mars.halt-pc-required'
    ]);
    expect(mocks.runMarsFile).not.toHaveBeenCalled();
  });

  it('forwards cancellation and validated image halt metadata to legacy execution', async () => {
    const owner = services();
    const provider = new LegacyMarsProvider(owner);
    setProviderRegistry({ assemblerProviders: [provider], executionProviders: [provider] });
    const outputFile = vscode.Uri.file('E:/work/oracle.out');
    mocks.runMarsFile.mockResolvedValue({
      result: successfulRunStatus(),
      outputFile,
      engineArtifact: {
        sha256: 'a'.repeat(64),
        role: 'user-configured-mars',
        fileName: 'Mars.jar'
      }
    });
    const controller = new AbortController();

    const result = await executeWithPreflight(owner, {
      sourceUri: sourceUri(),
      imageRef: {
        kind: 'mars-dump',
        machineCodeUri: vscode.Uri.file('E:/work/code.txt'),
        haltPc: 0x3010
      },
      courseTrace: true,
      maxSteps: 256,
      traceOutput: true,
      traceLevel: 2
    }, { signal: controller.signal });

    expect(result.ok).toBe(true);
    expect(result.result?.engineArtifact?.sha256).toBe('a'.repeat(64));
    expect(mocks.runMarsFile).toHaveBeenCalledWith(
      owner,
      expect.anything(),
      'run',
      expect.objectContaining({
        haltPc: 0x3010,
        maxSteps: 256,
        signal: controller.signal
      })
    );
  });

  it('preserves an aborted process reason through the legacy provider status', async () => {
    const owner = services();
    const provider = new LegacyMarsProvider(owner);
    setProviderRegistry({ assemblerProviders: [provider], executionProviders: [provider] });
    mocks.runMarsFile.mockResolvedValue({
      result: {
        ...successfulRunStatus(),
        ok: false,
        stopped: true,
        stopReason: 'aborted'
      }
    });

    const result = await executeWithPreflight(owner, {
      sourceUri: sourceUri(),
      imageRef: {
        kind: 'mars-dump',
        machineCodeUri: vscode.Uri.file('E:/work/code.txt'),
        haltPc: 0x3010
      },
      courseTrace: true,
      maxSteps: 256
    });

    expect(result.ok).toBe(false);
    expect(result.result?.status).toMatchObject({ stopped: true, stopReason: 'aborted' });
  });

  it('rejects semantic request mutation after preflight without invoking MARS', async () => {
    const provider = new LegacyMarsProvider(services());
    const request: ExecuteRequest = {
      sourceUri: sourceUri(),
      imageRef: {
        kind: 'mars-dump',
        machineCodeUri: vscode.Uri.file('E:/work/code.txt'),
        haltPc: 0x3010
      },
      courseTrace: true,
      traceOutput: true,
      traceLevel: 2,
      maxSteps: 256,
      interruptSchedule: [0x3020]
    };

    expect((await provider.preflight(request)).ok).toBe(true);
    request.maxSteps = 512;
    request.interruptSchedule!.push(0x3030);
    const result = await provider.execute(request);

    expect(result.ok).toBe(false);
    expect(result.status.stderr).toContain('legacy-mars.request-changed-after-preflight');
    expect(mocks.runMarsFile).not.toHaveBeenCalled();
  });

  it('rejects mutation in the resolved launch continuation gap', async () => {
    const provider = new LegacyMarsProvider(services());
    const request: ExecuteRequest = {
      sourceUri: sourceUri(),
      imageRef: {
        kind: 'mars-dump',
        machineCodeUri: vscode.Uri.file('E:/work/code.txt'),
        haltPc: 0x3010
      },
      stdin: 'before',
      maxSteps: 256,
      interruptSchedule: [0x3020]
    };
    expect((await provider.preflight(request)).ok).toBe(true);

    const pending = provider.execute(request);
    request.stdin = 'after';
    request.interruptSchedule!.push(0x3030);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.status.stderr).toContain('legacy-mars.request-changed-after-preflight');
    expect(mocks.runMarsFile).not.toHaveBeenCalled();
  });

  it('uses only the frozen execute snapshot after dispatch starts', async () => {
    const provider = new LegacyMarsProvider(services());
    const request: ExecuteRequest = {
      sourceUri: sourceUri(),
      imageRef: {
        kind: 'mars-dump',
        machineCodeUri: vscode.Uri.file('E:/work/code.txt'),
        haltPc: 0x3010
      },
      stdin: 'captured',
      stdinSource: vscode.Uri.file('E:/work/input.txt'),
      maxSteps: 256,
      interruptSchedule: [0x3020]
    };
    expect((await provider.preflight(request)).ok).toBe(true);
    let finish!: () => void;
    mocks.runMarsFile.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ result: successfulRunStatus() });
    }));

    const pending = provider.execute(request);
    await vi.waitFor(() => expect(mocks.runMarsFile).toHaveBeenCalledOnce());
    request.sourceUri = vscode.Uri.file('E:/attacker/replaced.asm');
    request.stdin = 'replaced';
    request.stdinSource = vscode.Uri.file('E:/attacker/input.txt');
    request.interruptSchedule!.push(0x3030);

    const [, invokedSource, , invokedOptions] = mocks.runMarsFile.mock.calls[0];
    expect(invokedSource.fsPath).toBe(sourceUri().fsPath);
    expect(invokedOptions).toMatchObject({
      stdin: 'captured',
      stdinSource: expect.objectContaining({ fsPath: vscode.Uri.file('E:/work/input.txt').fsPath }),
      interruptSchedule: [0x3020],
      maxSteps: 256
    });
    expect(Object.isFrozen(invokedOptions)).toBe(true);
    expect(Object.isFrozen(invokedOptions.interruptSchedule)).toBe(true);
    finish();
    expect((await pending).ok).toBe(true);
  });

  it('rejects semantic request mutation while asynchronous preflight is resolving', async () => {
    const provider = new LegacyMarsProvider(services());
    const request: ExecuteRequest = {
      sourceUri: sourceUri(),
      imageRef: {
        kind: 'mars-dump',
        machineCodeUri: vscode.Uri.file('E:/work/code.txt'),
        haltPc: 0x3010
      },
      courseTrace: false,
      traceOutput: false,
      maxSteps: 256
    };
    let release!: (value: { diagnostics: []; launch: ReturnType<typeof resolvedLaunch> }) => void;
    mocks.resolveLegacyMarsLaunch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));

    const pending = provider.preflight(request);
    await vi.waitFor(() => expect(mocks.resolveLegacyMarsLaunch).toHaveBeenCalledOnce());
    request.courseTrace = true;
    request.traceOutput = true;
    release({ diagnostics: [], launch: resolvedLaunch(request.sourceUri.fsPath, 'run') });
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'legacy-mars.request-changed-during-preflight'
    );
    expect(mocks.runMarsFile).not.toHaveBeenCalled();
  });

  it('forwards cancellation and target mode to legacy assembly', async () => {
    const owner = services();
    const provider = new LegacyMarsProvider(owner);
    setProviderRegistry({ assemblerProviders: [provider], executionProviders: [provider] });
    const outputFile = vscode.Uri.file('E:/work/kernel.txt');
    mocks.runMarsFile.mockResolvedValue({
      result: successfulRunStatus(),
      outputFile,
      courseHaltPc: 0x3008
    });
    const controller = new AbortController();

    const result = await assembleWithPreflight(owner, {
      sourceUri: sourceUri(),
      target: { kind: 'kernelText', outputFile },
      courseTrace: true
    }, { signal: controller.signal });

    expect(result.ok).toBe(true);
    expect(mocks.runMarsFile).toHaveBeenCalledWith(
      owner,
      expect.anything(),
      'dumpKernel',
      expect.objectContaining({
        dumpOutputFile: expect.objectContaining({ fsPath: outputFile.fsPath }),
        signal: controller.signal
      })
    );
  });

  it('rejects assemble mutation in the resolved launch continuation gap', async () => {
    const provider = new LegacyMarsProvider(services());
    const request: AssembleRequest = {
      sourceUri: sourceUri(),
      target: {
        kind: 'kernelText',
        outputFile: vscode.Uri.file('E:/work/kernel.txt')
      },
      courseTrace: true,
      p7RiInstruction: true
    };
    expect((await provider.preflight(request)).ok).toBe(true);

    const pending = provider.assemble(request);
    request.target = {
      kind: 'userText',
      outputFile: vscode.Uri.file('E:/attacker/replaced.txt')
    };
    request.courseTrace = false;
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.status.stderr).toContain('legacy-mars.request-changed-after-preflight');
    expect(mocks.runMarsFile).not.toHaveBeenCalled();
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

function engineDescriptor(id: string): EngineDescriptor {
  return {
    id,
    kind: 'assembler',
    build: 'test',
    semanticsRevision: 1,
    capabilitiesRevision: 1
  };
}

function successfulRunStatus() {
  return {
    ok: true,
    exitCode: 0,
    stdout: '',
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
