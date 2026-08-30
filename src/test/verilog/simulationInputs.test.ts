import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import { getMachineCode } from '../../config';
import { ensureDirectory } from '../../fsUtil';
import { copyMachineCodeToSimDirectory } from '../../verilog/simulationInputs';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('../helpers/vscodeMock').createVscodeMockState> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  return createVscodeModuleMock(vscodeState.state, vi.fn);
});

vi.mock('../../config', () => ({
  getMachineCode: vi.fn()
}));

vi.mock('../../fsUtil', () => ({
  ensureDirectory: vi.fn(async () => undefined),
  isFile: vi.fn(),
  workspaceFolderForOrFirst: vi.fn()
}));

describe('simulation machine-code inputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMachineCode).mockReturnValue('program.hex');
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(new Uint8Array([0x32, 0x61, 0x0a]));
  });

  it('preserves the configured filename and also writes the generated-testbench code.txt alias', async () => {
    const source = URI.file('E:/course case/source.hex');
    const outDir = URI.file('E:/课程 workspace/.co/isim');

    await copyMachineCodeToSimDirectory(source, outDir, URI.file('E:/课程 workspace/mips.v'));

    expect(vscode.workspace.fs.readFile).toHaveBeenCalledOnce();
    expect(ensureDirectory).toHaveBeenCalledTimes(2);
    expect(writtenBasenames()).toEqual(['code.txt', 'program.hex']);
  });

  it('still refreshes code.txt when the source already is the configured target', async () => {
    const outDir = URI.file('E:/work/.co/isim');
    const source = URI.file('E:/work/.co/isim/program.hex');

    await copyMachineCodeToSimDirectory(source, outDir);

    expect(vscode.workspace.fs.readFile).toHaveBeenCalledOnce();
    expect(writtenBasenames()).toEqual(['code.txt']);
  });

  it('does not duplicate writes when code.txt is the configured filename', async () => {
    vi.mocked(getMachineCode).mockReturnValue('code.txt');

    await copyMachineCodeToSimDirectory(
      URI.file('E:/case/code.txt'),
      URI.file('E:/work/.co/isim')
    );

    expect(writtenBasenames()).toEqual(['code.txt']);
  });
});

function writtenBasenames(): string[] {
  return vi.mocked(vscode.workspace.fs.writeFile).mock.calls
    .map(([uri]) => uri.path.split('/').at(-1) ?? '')
    .sort();
}
