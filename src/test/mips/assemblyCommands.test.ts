import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { Commands } from '../../constants';
import { dumpMipsFile, registerMipsAssemblyCommands } from '../../mipsCommands';
import { registerMips } from '../../mips';
import { assembleWithPreflight } from '../../mips/providers/providerResolver';

const mocks = vi.hoisted(() => ({
  ensureConcreteProfile: vi.fn(),
  getMachineCode: vi.fn(() => 'code.txt'),
  shouldRevealOutput: vi.fn(() => false),
  assembleWithPreflight: vi.fn()
}));

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('../helpers/vscodeMock').createVscodeMockState> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  return createVscodeModuleMock(vscodeState.state, vi.fn);
});

vi.mock('../../config', () => ({
  ensureConcreteProfile: mocks.ensureConcreteProfile,
  getMachineCode: mocks.getMachineCode,
  shouldRevealOutput: mocks.shouldRevealOutput
}));

vi.mock('../../mips/providers/providerResolver', () => ({
  assembleWithPreflight: mocks.assembleWithPreflight,
  preflightFailureMessage: vi.fn((preflight: { diagnostics?: Array<{ message: string }> }) =>
    (preflight.diagnostics ?? []).map((diagnostic) => diagnostic.message).join('\n'))
}));


function services() {
  return {
    output: { appendLine: vi.fn() },
    statusBar: {}
  } as never;
}

function registeredCommands(service = services()): Map<string, (...args: unknown[]) => unknown> {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
    commands.set(command, callback as (...args: unknown[]) => unknown);
    return { dispose: vi.fn() };
  });
  registerMipsAssemblyCommands({ subscriptions: [] } as never, service);
  return commands;
}

function registeredLegacyCommands(service = services()): Map<string, (...args: unknown[]) => unknown> {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
    commands.set(command, callback as (...args: unknown[]) => unknown);
    return { dispose: vi.fn() };
  });
  registerMips({ subscriptions: [] } as never, service);
  return commands;
}

describe('MIPS assembly command routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeState.state!.activeTextEditor = undefined;
    mocks.ensureConcreteProfile.mockResolvedValue('P3');
    mocks.assembleWithPreflight.mockImplementation(async (_services, request, _context, plan) => ({
      ok: true,
      preflight: {
        ok: true,
        diagnostics: [],
        descriptor: { id: plan.primaryEngineId }
      },
      result: {
        ok: true,
        outputFile: request.target.outputFile,
        status: { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false },
        descriptor: { id: plan.primaryEngineId },
        image: {
          formatVersion: 1,
          fingerprint: '0'.repeat(64),
          entryPc: 0x3000,
          segments: [
            { name: 'text', baseAddress: 0x3000, words: [0x34080001] },
            ...(plan.profile === 'P7'
              ? [{ name: 'ktext', baseAddress: 0x4180, words: [0x42000018] }]
              : [])
          ],
          symbols: [],
          sourceMap: [],
          inputGraph: [{ id: 'root', contentHash: '1'.repeat(64) }]
        }
      }
    }));
  });

  it.each(['P3', 'P4', 'P5', 'P6', 'P7'] as const)(
    'forces the builtin assembler for %s text dumps',
    async (profile) => {
      mocks.ensureConcreteProfile.mockResolvedValue(profile);
      const source = vscode.Uri.file(`E:/work/${profile.toLowerCase()}.asm`);

      await expect(dumpMipsFile(services(), source, 'userText')).resolves.toBe(true);

      expect(assembleWithPreflight).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sourceUri: source,
          target: expect.objectContaining({ kind: 'userText' }),
          requirements: expect.objectContaining({ profile })
        }),
        undefined,
        expect.objectContaining({
          mode: 'builtin',
          profile,
          primaryEngineId: 'builtin-ts'
        })
      );
    }
  );

  it('keeps P2 text dumps on the legacy MARS provider', async () => {
    mocks.ensureConcreteProfile.mockResolvedValue('P2');
    const source = vscode.Uri.file('E:/work/p2.asm');

    await expect(dumpMipsFile(services(), source, 'userText')).resolves.toBe(true);

    expect(assembleWithPreflight).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceUri: source,
        target: expect.objectContaining({ kind: 'userText' }),
        requirements: expect.objectContaining({ profile: 'P2' })
      }),
      undefined,
      expect.objectContaining({
        mode: 'mars',
        profile: 'P2',
        primaryEngineId: 'legacy-mars-configured'
      })
    );
  });

  it('uses the builtin kernel-text target for P7', async () => {
    mocks.ensureConcreteProfile.mockResolvedValue('P7');
    const source = vscode.Uri.file('E:/work/handler.asm');

    await expect(dumpMipsFile(services(), source, 'kernelText')).resolves.toBe(true);

    const request = mocks.assembleWithPreflight.mock.calls[0][1];
    const plan = mocks.assembleWithPreflight.mock.calls[0][3];
    expect(request.target.kind).toBe('kernelText');
    expect(request.target.outputFile.fsPath).toMatch(/handler\.kernel\.txt$/i);
    expect(plan).toMatchObject({
      mode: 'builtin',
      profile: 'P7',
      primaryEngineId: 'builtin-ts'
    });
  });

  it('writes a P6 ordinary dump with a provider-neutral halt loop', async () => {
    mocks.ensureConcreteProfile.mockResolvedValue('P6');

    await expect(dumpMipsFile(services(), vscode.Uri.file('E:/work/p6.asm'), 'userText'))
      .resolves.toBe(true);

    const write = vi.mocked(vscode.workspace.fs.writeFile).mock.calls.at(-1);
    expect(write).toBeDefined();
    expect(Buffer.from(write![1]).toString('utf8')).toBe(
      '34080001\n1000ffff\n00000000\n'
    );
  });

  it('writes the P7 ordinary halt before the absolute kernel segment', async () => {
    mocks.ensureConcreteProfile.mockResolvedValue('P7');

    await expect(dumpMipsFile(services(), vscode.Uri.file('E:/work/p7.asm'), 'userText'))
      .resolves.toBe(true);

    const write = vi.mocked(vscode.workspace.fs.writeFile).mock.calls.at(-1);
    const lines = Buffer.from(write![1]).toString('utf8').trimEnd().split('\n');
    const handlerIndex = (0x4180 - 0x3000) / 4;
    expect(lines.slice(0, 3)).toEqual(['34080001', '1000ffff', '00000000']);
    expect(lines[handlerIndex - 1]).toBe('00000000');
    expect(lines[handlerIndex]).toBe('42000018');
  });

  it('reports assembler failures without naming a specific provider', async () => {
    mocks.ensureConcreteProfile.mockResolvedValue('P4');
    mocks.assembleWithPreflight.mockResolvedValueOnce({
      ok: false,
      preflight: {
        ok: false,
        diagnostics: [{ code: 'assembler.failed', message: 'bad source' }],
        descriptor: { id: 'builtin-ts' }
      }
    });

    await expect(dumpMipsFile(services(), vscode.Uri.file('E:/work/bad.asm'), 'userText'))
      .resolves.toBe(false);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      '文本段导出失败，请查看插件输出面板'
    );
    expect(vi.mocked(vscode.window.showErrorMessage).mock.calls.flat().join(' '))
      .not.toMatch(/MARS/i);
  });

  it('registers only assembler dump commands', () => {
    const commands = registeredCommands();
    expect([...commands.keys()]).toEqual([
      Commands.Mips.DumpText,
      Commands.Mips.DumpKernelText
    ]);
  });

  it('keeps only console and interactive commands on the legacy MARS registrar', () => {
    expect([...registeredLegacyCommands().keys()]).toEqual([
      Commands.Mips.DisablePseudoWarnings,
      Commands.Mips.RunCurrentFile,
      Commands.Mips.RunAndCapture,
      Commands.Mips.RunWithStdinFile,
      Commands.Mips.RunInTerminal
    ]);
  });
});
