import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
  createAsmCaseFromAsm,
  prepareAsmCaseMachineCode,
  resolveAsmCaseInput
} from '../../asmCaseStore';
import { ensureSimulationAsmCase } from '../../verilog/simulationAsmCase';

const vscodeState = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('../helpers/vscodeMock').createVscodeMockState> | undefined
}));

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  vscodeState.state = createVscodeMockState();
  return createVscodeModuleMock(vscodeState.state, vi.fn);
});

vi.mock('../../config', () => ({
  getProfile: vi.fn(() => 'P4')
}));

vi.mock('../../asmCaseStore', () => ({
  createAsmCaseFromAsm: vi.fn(),
  prepareAsmCaseMachineCode: vi.fn(),
  resolveAsmCaseInput: vi.fn()
}));

function asmCase() {
  return {
    id: 'case-1',
    dir: vscode.Uri.file('E:/work/.co/cases/case-1'),
    manifestUri: vscode.Uri.file('E:/work/.co/cases/case-1/case.json'),
    asm: vscode.Uri.file('E:/work/.co/cases/case-1/program.asm'),
    sourceAsm: vscode.Uri.file('E:/work/.co/cases/case-1/source/program.asm'),
    machineCode: vscode.Uri.file('E:/work/.co/cases/case-1/code.txt'),
    manifest: { version: 2, profile: 'P4' }
  };
}

describe('Verilog simulation ASM preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveAsmCaseInput).mockResolvedValue(vscode.Uri.file('E:/work/main.asm'));
    vi.mocked(createAsmCaseFromAsm).mockResolvedValue(asmCase() as never);
  });

  it('reports provider-neutral assembly failures', async () => {
    vi.mocked(prepareAsmCaseMachineCode).mockResolvedValue({
      ok: false,
      status: { ok: false, exitCode: 1, stdout: '', stderr: 'bad', timedOut: false },
      descriptor: { id: 'builtin-ts' }
    } as never);

    const result = await ensureSimulationAsmCase(
      { output: {} as never, statusBar: {} as never },
      vscode.Uri.file('E:/work/cpu.v'),
      { showMessages: true }
    );

    expect(result).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      '汇编器生成机器码失败，无法继续 Verilog 仿真'
    );
    expect(vi.mocked(vscode.window.showErrorMessage).mock.calls.flat().join(' '))
      .not.toMatch(/MARS/i);
  });
});
