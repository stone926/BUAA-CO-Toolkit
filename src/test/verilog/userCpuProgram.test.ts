import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { buildProgramImage } from '../../mips/core/programImage';
import { resolveCourseEnginePlan } from '../../mips/providers/courseEnginePolicy';
import { prepareUserCpuProgram, prepareUserCpuProgramForTestbench } from '../../verilog/userCpuProgram';
import { createVscodeMockState } from '../helpers/vscodeMock';
import { createTestServices } from '../helpers/appServices';

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  writeTextFile: vi.fn(),
  assembleWithPreflight: vi.fn(),
  verilogDocumentForUri: vi.fn()
}));

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof createVscodeMockState> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  const path = await import('path');
  vscodeState.state = createVscodeMockState();
  const mock = createVscodeModuleMock(vscodeState.state, vi.fn);
  Object.defineProperty(mock.Uri, 'joinPath', {
    value: (base: { fsPath: string }, ...segments: string[]) => mock.Uri.file(path.join(base.fsPath, ...segments))
  });
  return mock;
});

vi.mock('../../config', () => ({ getProfile: mocks.getProfile }));
vi.mock('../../fsUtil', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../fsUtil')>()),
  writeTextFile: mocks.writeTextFile
}));
vi.mock('../../mips/providers/providerResolver', () => ({
  assembleWithPreflight: mocks.assembleWithPreflight,
  preflightFailureMessage: vi.fn(() => '')
}));
vi.mock('../../verilog/documentContext', () => ({ verilogDocumentForUri: mocks.verilogDocumentForUri }));

const root = path.join(process.cwd(), '.test-user-cpu-program');
const outDir = vscode.Uri.file(path.join(root, '.co', 'iverilog'));
const asmUri = vscode.Uri.file(path.join(root, 'program.asm'));

function testbenchUri(relative = '.co/tb/cpu_tb.v'): vscode.Uri {
  return vscode.Uri.file(path.join(root, relative));
}

function programImage(profile: 'P4' | 'P5' | 'P6' | 'P7') {
  return buildProgramImage({
    entryPc: 0x3000,
    segments: [
      { name: 'text', baseAddress: 0x3000, words: [0x2402_0001] },
      ...(profile === 'P7' ? [{ name: 'ktext', baseAddress: 0x4180, words: [0x4200_0018] }] : [])
    ],
    inputGraph: [{ id: 'root', contentHash: '1'.repeat(64) }]
  });
}

function latestWrittenText(): string {
  return mocks.writeTextFile.mock.calls.at(-1)?.[1] as string;
}

describe('program preparation for generated CPU testbenches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verilogDocumentForUri.mockReset();
    vi.mocked(vscode.window.showOpenDialog).mockReset();
    mocks.writeTextFile.mockReset();
    mocks.assembleWithPreflight.mockReset();
    mocks.getProfile.mockReset();
    vi.mocked(vscode.window.showQuickPick).mockReset();
    vscodeState.state!.activeTextEditor = undefined;
    vscodeState.state!.workspaceFolders.splice(0);
    vscodeState.state!.workspaceFolders.push({ uri: vscode.Uri.file(root), name: 'test' });
    mocks.getProfile.mockReturnValue('P4');
    mocks.verilogDocumentForUri.mockImplementation(async (uri: vscode.Uri) => {
      const profile = uri.fsPath.endsWith('P7.v') ? 'P7' : 'P4';
      return { getText: () => `// CO_USER_CPU_TESTBENCH ${profile}\nmodule cpu_tb; endmodule` };
    });
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([asmUri]);
    mocks.writeTextFile.mockResolvedValue(undefined);
    mocks.assembleWithPreflight.mockImplementation(async (_services, _request, _context, plan) => ({
      result: { ok: true, image: programImage(plan.profile), status: { stderr: '' } }
    }));
  });

  it.each(['single candidate', 'active ASM'] as const)('requires explicit selection with %s and uses the chosen file', async (scenario) => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([asmUri]);
    if (scenario === 'active ASM') {
      vscodeState.state!.activeTextEditor = {
        document: { uri: asmUri, languageId: 'mipsasm', isDirty: false, save: vi.fn(async () => true) }
      };
    }
    const chosen = vscode.Uri.file(path.join(root, '..', '另一个目录', 'chosen program.asm'));
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce([chosen]);
    await expect(prepareUserCpuProgram(createTestServices(), testbenchUri(), outDir)).resolves.toMatchObject({ kind: 'ready' });
    expect(vscode.window.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultUri: expect.objectContaining({ path: vscode.Uri.file(root).path }),
      filters: { ASM: ['asm', 's', 'mips'] },
      canSelectMany: false
    }));
    expect(mocks.assembleWithPreflight).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ sourceUri: chosen }), expect.anything(), expect.anything()
    );
  });

  it('asks again on each new run even with the same CPU testbench', async () => {
    await prepareUserCpuProgram(createTestServices(), testbenchUri(), outDir, undefined, {});
    await prepareUserCpuProgram(createTestServices(), testbenchUri(), outDir, undefined, {});
    expect(vscode.window.showOpenDialog).toHaveBeenCalledTimes(2);
  });

  it('selects ASM before a missing CPU testbench exists and reuses it after creation', async () => {
    const session = {};
    await expect(prepareUserCpuProgramForTestbench(createTestServices(), testbenchUri(), 'P4', outDir, undefined, session))
      .resolves.toMatchObject({ kind: 'ready' });
    expect(mocks.verilogDocumentForUri).not.toHaveBeenCalled();
    await expect(prepareUserCpuProgram(createTestServices(), testbenchUri(), outDir, undefined, session))
      .resolves.toMatchObject({ kind: 'ready' });
    expect(vi.mocked(vscode.window.showOpenDialog)).toHaveBeenCalledTimes(1);
    expect(mocks.assembleWithPreflight).toHaveBeenCalledTimes(1);
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it.each(['P4', 'P7'] as const)(
    'assembles %s with the builtin plan and renders course halt/kernel positions through real image helpers',
    async (profile) => {
      const tb = testbenchUri(`.co/tb/${profile}.v`);
      mocks.getProfile.mockReturnValue(profile);

      await expect(prepareUserCpuProgram(createTestServices(), tb, outDir)).resolves.toMatchObject({ kind: 'ready' });

      const plan = mocks.assembleWithPreflight.mock.calls[0][3];
      expect(plan).toEqual(resolveCourseEnginePlan('builtin', profile));
      expect(mocks.assembleWithPreflight).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sourceUri: asmUri,
          target: expect.objectContaining({ kind: 'userText' }),
          revealOutput: false,
          requirements: expect.objectContaining({ profile })
        }),
        expect.objectContaining({ signal: undefined }),
        expect.objectContaining({ mode: 'builtin', primaryEngineId: 'builtin-ts' })
      );

      const words = latestWrittenText().trim().split(/\r?\n/);
      expect(words).toHaveLength(4096);
      expect(words[0]).toBe('24020001');
      expect(words[1]).toBe('1000ffff');
      expect(words[2]).toBe('00000000');
      if (profile === 'P7') {
        expect(words[(0x4180 - 0x3000) / 4]).toBe('42000018');
        expect(words[(0x4180 - 0x3000) / 4 - 1]).toBe('00000000');
      }
    }
  );

  it('stops without writes when the ASM picker is cancelled', async () => {
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce(undefined);

    await expect(prepareUserCpuProgram(createTestServices(), testbenchUri(), outDir)).resolves.toEqual({ kind: 'stopped' });

    expect(mocks.assembleWithPreflight).not.toHaveBeenCalled();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it('stops before writing simulation input when assembly fails', async () => {
    mocks.assembleWithPreflight.mockResolvedValueOnce({
      result: { ok: false, status: { stderr: 'bad assembly' } }
    });
    const service = createTestServices();

    await expect(prepareUserCpuProgram(service, testbenchUri(), outDir)).resolves.toEqual({ kind: 'stopped' });

    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    expect(service.output.appendLine).toHaveBeenCalledWith(expect.stringContaining('bad assembly'));
  });

  it('restores the same session program after another run overwrites the staging file', async () => {
    const cpuTb = testbenchUri();
    const session = {};

    await expect(prepareUserCpuProgram(createTestServices(), cpuTb, outDir, undefined, session)).resolves.toMatchObject({ kind: 'ready' });
    const selectedProgram = latestWrittenText();
    await mocks.writeTextFile(vscode.Uri.joinPath(outDir, 'co_user_program.txt'), 'overwritten input');
    expect(latestWrittenText()).not.toBe(selectedProgram);

    await expect(prepareUserCpuProgram(createTestServices(), cpuTb, outDir, undefined, session)).resolves.toMatchObject({ kind: 'ready' });

    expect(latestWrittenText()).toBe(selectedProgram);
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(vi.mocked(vscode.window.showOpenDialog)).toHaveBeenCalledTimes(1);
    expect(mocks.assembleWithPreflight).toHaveBeenCalledTimes(1);
  });

  it.each([
    { description: 'a custom testbench outside .co/tb', relative: 'src/cpu_tb.v', text: '// CO_USER_CPU_TESTBENCH P4\nmodule cpu_tb; endmodule' },
    { description: 'an unmarked file under .co/tb', relative: '.co/tb/custom.v', text: 'module custom_tb; endmodule' },
    { description: 'a non-CPU generated stimulus testbench', relative: '.co/tb/alu_tb.v', text: '// ordinary stimulus scaffold\nmodule alu_tb; endmodule' }
  ])('does not open a picker for $description', async ({ relative, text }) => {
    mocks.verilogDocumentForUri.mockResolvedValueOnce({ getText: () => text });

    await expect(prepareUserCpuProgram(createTestServices(), testbenchUri(relative), outDir)).resolves.toEqual({ kind: 'unmanaged' });

    expect(vi.mocked(vscode.window.showOpenDialog)).not.toHaveBeenCalled();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it('stops before prompting or writing when the workspace profile differs from the TB marker', async () => {
    mocks.getProfile.mockReturnValue('P5');

    await expect(prepareUserCpuProgram(createTestServices(), testbenchUri(), outDir)).resolves.toEqual({ kind: 'stopped' });

    expect(vi.mocked(vscode.window.showOpenDialog)).not.toHaveBeenCalled();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it('does not prompt or write if cancellation is already requested', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(prepareUserCpuProgram(createTestServices(), testbenchUri(), outDir, controller.signal))
      .resolves.toEqual({ kind: 'stopped' });

    expect(vi.mocked(vscode.window.showOpenDialog)).not.toHaveBeenCalled();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });
});
