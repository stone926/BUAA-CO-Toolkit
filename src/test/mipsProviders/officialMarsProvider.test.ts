import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
const mocks = vi.hoisted(() => ({ launch: vi.fn(), run: vi.fn() }));
vi.mock('vscode', () => ({ Uri: URI }));
vi.mock('../../mips', () => ({ runMarsFile: mocks.run }));
vi.mock('../../mips/providers/legacyMarsLaunch', () => ({ resolveLegacyMarsLaunch: mocks.launch }));
import { OfficialMarsProvider } from '../../mips/providers/officialMarsProvider';
import type { AppServices } from '../../types';
import type { AssembleRequest, ExecuteRequest } from '../../mips/providers/contracts';

const services = { output: {} } as AppServices;
const request = (): AssembleRequest => ({ sourceUri: URI.file('E:/课程 空格/main.asm'),
  target: { kind: 'userText', outputFile: URI.file('E:/课程 空格/code.txt') }, requirements: { profile: 'P2' } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.launch.mockResolvedValue({ diagnostics: [], launch: { profile: 'P2', memoryConfiguration: 'Default' } });
  mocks.run.mockResolvedValue({ result: { ok: true, stdout: '', stderr: '', exitCode: 0, timedOut: false },
    outputFile: URI.file('E:/课程 空格/code.txt') });
});

describe('official MARS provider boundary', () => {
  it('exports P2 through the standard dump runner with the resolved launch', async () => {
    const provider = new OfficialMarsProvider(services);
    const input = request();
    const signal = new AbortController().signal;
    const result = await provider.assemble(input, { signal });
    expect(result).toMatchObject({ ok: true, descriptor: { id: 'official-mars-configured' } });
    expect(mocks.run).toHaveBeenCalledWith(services, input.sourceUri, 'dumpText',
      expect.objectContaining({ dumpOutputFile: input.target.outputFile, signal,
        resolvedLaunch: { profile: 'P2', memoryConfiguration: 'Default' } }));
    expect(result.image).toBeUndefined();
  });

  it('rejects course images, kernel export and RI extensions before launching Java', async () => {
    const provider = new OfficialMarsProvider(services);
    for (const input of [ { ...request(), courseTrace: true },
      { ...request(), p7RiInstruction: true },
      { ...request(), target: { kind: 'kernelText' as const } } ]) {
      expect((await provider.assemble(input)).ok).toBe(false);
    }
    expect((await provider.preflight({ image: {} } as ExecuteRequest)).ok).toBe(false);
    expect((await provider.execute({ image: {} } as ExecuteRequest)).ok).toBe(false);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('rejects a source profile that disagrees with the P2 request', async () => {
    mocks.launch.mockResolvedValue({ diagnostics: [], launch: { profile: 'P6' } });
    const result = await new OfficialMarsProvider(services).assemble(request());
    expect(result.status.stderr).toContain('profile-mismatch');
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
