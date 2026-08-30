// @index verilog-simulation-asm-case — Verilog 仿真共享的 ASM case 选择与机器码准备
import * as vscode from 'vscode';
import type { AsmCase } from '../asmCaseStore';
import {
  createAsmCaseFromAsm,
  prepareAsmCaseMachineCode,
  resolveAsmCaseInput
} from '../asmCaseStore';
import { getProfile } from '../config';
import { ASM_NEEDED_VERILOG_PROFILES } from '../constants';
import type { AppServices } from '../types';

export function requiresSimulationAsmCase(resource: vscode.Uri | undefined): boolean {
  return ASM_NEEDED_VERILOG_PROFILES.has(getProfile(resource));
}

export async function ensureSimulationAsmCase(
  services: AppServices,
  resource: vscode.Uri | undefined,
  options: {
    showMessages: boolean;
    signal?: AbortSignal;
    nonInteractive?: boolean;
  }
): Promise<AsmCase | undefined> {
  if (!requiresSimulationAsmCase(resource) || options.nonInteractive) {
    return undefined;
  }
  const asm = await resolveAsmCaseInput('选择用于 Verilog 仿真的 MIPS ASM 文件');
  if (!asm) {
    if (options.showMessages) {
      vscode.window.showWarningMessage('已取消：P4-P7 Verilog 仿真需要选择 ASM 以生成可追溯机器码');
    }
    return undefined;
  }
  const asmCase = await createAsmCaseFromAsm(asm, {
    resource,
    source: { kind: 'selected' }
  });
  const dump = await prepareAsmCaseMachineCode(services, asmCase, {
    showMessages: false,
    signal: options.signal
  });
  if (!dump?.ok || !dump.outputFile) {
    if (options.showMessages) {
      vscode.window.showErrorMessage('MARS 导出机器码失败，无法继续 Verilog 仿真');
    }
    return undefined;
  }
  services.output.appendLine(`ASM case: ${asmCase.manifestUri.fsPath}`);
  return asmCase;
}
