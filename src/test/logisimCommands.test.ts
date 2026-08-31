import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { Commands } from '../constants';
import { registerLogisim } from '../logisim';
import {
  copyAsmCaseArtifact,
  createAsmCaseFromAsm,
  prepareAsmCaseMachineCode,
  resolveAsmCaseInput,
  updateAsmCaseArtifacts,
  writeAsmCaseArtifact
} from '../asmCaseStore';
import { readTextFile } from '../fsUtil';
import { injectMachineCodeIntoLogisimRom } from '../language/logisim/rom';
import { pickOneFile } from '../workflowInputs';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('./helpers/vscodeMock').createVscodeMockState> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('./helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  return createVscodeModuleMock(vscodeState.state, vi.fn);
});

vi.mock('../config', () => ({
  getJava: vi.fn(() => 'java'),
  getLogisimJar: vi.fn(() => 'D:/logisim/logisim.jar')
}));

vi.mock('../fsUtil', () => ({
  dirname: vi.fn(() => 'E:/work'),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(async () => undefined)
}));

vi.mock('../language/logisim/rom', () => ({
  findLogisimRomTargets: vi.fn(() => [{ index: 0, label: 'IM', dataWidth: 32, hasContents: false }]),
  injectMachineCodeIntoLogisimRom: vi.fn(() => ({ text: '<project>updated</project>', wordCount: 2 })),
  parseMachineCodeWords: vi.fn(),
  formatLogisimMemoryContents: vi.fn()
}));

vi.mock('../process', () => ({
  launchTool: vi.fn()
}));

vi.mock('../workflowInputs', () => ({
  pickOneFile: vi.fn(),
  resolveActiveOrPickedTextFile: vi.fn()
}));

vi.mock('../asmCaseStore', () => ({
  asmCaseSourceSnapshotIssue: vi.fn(async () => undefined),
  copyAsmCaseArtifact: vi.fn(async () => vscode.Uri.file('E:/work/.co/cases/case-1/logisim/circuit-template.circ')),
  createAsmCaseFromAsm: vi.fn(),
  prepareAsmCaseMachineCode: vi.fn(),
  resolveAsmCaseInput: vi.fn(),
  updateAsmCaseArtifacts: vi.fn(async () => undefined),
  writeAsmCaseArtifact: vi.fn()
}));

function services() {
  return { output: {} as never, statusBar: {} as never };
}

function commandMap(): Map<string, (...args: unknown[]) => unknown> {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
    commands.set(command, callback as (...args: unknown[]) => unknown);
    return { dispose: vi.fn() };
  });
  return commands;
}

function asmCase() {
  return {
    id: 'case-1',
    dir: vscode.Uri.file('E:/work/.co/cases/case-1'),
    manifestUri: vscode.Uri.file('E:/work/.co/cases/case-1/case.json'),
    asm: vscode.Uri.file('E:/work/.co/cases/case-1/program.asm'),
    sourceAsm: vscode.Uri.file('E:/work/main.asm'),
    machineCode: vscode.Uri.file('E:/work/.co/cases/case-1/code.txt'),
    manifest: {
      version: 1,
      caseId: 'case-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      source: { kind: 'selected' },
      asm: { path: 'E:/work/main.asm', sha256: 'asm' }
    }
  };
}

describe('Logisim command workflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveAsmCaseInput).mockResolvedValue(vscode.Uri.file('E:/work/main.asm'));
    vi.mocked(createAsmCaseFromAsm).mockResolvedValue(asmCase() as never);
    vi.mocked(prepareAsmCaseMachineCode).mockResolvedValue({
      ok: true,
      status: { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false },
      outputFile: vscode.Uri.file('E:/work/.co/cases/case-1/code.txt'),
      descriptor: { id: 'builtin-ts' }
    } as never);
    vi.mocked(readTextFile).mockResolvedValue('v2.0 raw\n00000000\n');
    vi.mocked(writeAsmCaseArtifact).mockResolvedValue(vscode.Uri.file('E:/work/.co/cases/case-1/logisim/out.circ') as never);
  });

  it('stops ROM generation when machine-code dump fails', async () => {
    const commands = commandMap();
    vi.mocked(prepareAsmCaseMachineCode).mockResolvedValueOnce({
      ok: false,
      status: { ok: false, exitCode: 1, stdout: '', stderr: 'bad', timedOut: false },
      descriptor: { id: 'builtin-ts' }
    } as never);
    registerLogisim({ subscriptions: [] } as never, services());

    await commands.get(Commands.Logisim.GenerateRom)!();

    expect(writeAsmCaseArtifact).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('汇编器生成机器码失败，无法生成 Logisim ROM');
  });

  it('injects machine code into a selected circuit and records the prepared circuit artifact', async () => {
    const commands = commandMap();
    const circuit = vscode.Uri.file('E:/work/cpu.circ');
    vi.mocked(pickOneFile).mockResolvedValue(circuit);
    registerLogisim({ subscriptions: [] } as never, services());

    await commands.get(Commands.Logisim.InjectRomIntoCircuit)!();

    expect(injectMachineCodeIntoLogisimRom).toHaveBeenCalledWith('v2.0 raw\n00000000\n', 'v2.0 raw\n00000000\n', 0);
    expect(writeAsmCaseArtifact).toHaveBeenCalledWith(expect.anything(), 'logisim', 'cpu.main.circ', '<project>updated</project>', 'injectedCircuit');
    expect(copyAsmCaseArtifact).toHaveBeenCalledWith(
      expect.anything(),
      'logisim',
      circuit,
      'circuit-template.circ',
      'circuitTemplate'
    );
    expect(vscode.window.showTextDocument).toHaveBeenCalled();
  });

  it('reports ROM injection assembly failures without naming MARS', async () => {
    const commands = commandMap();
    vi.mocked(pickOneFile).mockResolvedValue(vscode.Uri.file('E:/work/cpu.circ'));
    vi.mocked(prepareAsmCaseMachineCode).mockResolvedValueOnce({
      ok: false,
      status: { ok: false, exitCode: 1, stdout: '', stderr: 'bad', timedOut: false },
      descriptor: { id: 'builtin-ts' }
    } as never);
    registerLogisim({ subscriptions: [] } as never, services());

    await commands.get(Commands.Logisim.InjectRomIntoCircuit)!();

    expect(injectMachineCodeIntoLogisimRom).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      '汇编器生成机器码失败，无法注入 Logisim ROM'
    );
    expect(vi.mocked(vscode.window.showErrorMessage).mock.calls.flat().join(' '))
      .not.toMatch(/MARS/i);
  });
});
