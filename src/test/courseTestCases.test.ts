import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => {
  const { URI } = await import('vscode-uri');
  return {
    Uri: {
      file: (file: string) => URI.file(file)
    }
  };
});

import * as vscode from 'vscode';
import { asmCaseSourceFromBatchSource, caseResultFields, failedCase } from '../courseTestCases';
import type { AsmCase } from '../asmCaseStore';

describe('course test case helpers', () => {
  it('maps batch sources to ASM case sources', () => {
    expect(asmCaseSourceFromBatchSource({ kind: 'selected' })).toEqual({ kind: 'selected' });
    expect(asmCaseSourceFromBatchSource({
      kind: 'generator',
      generator: 'gen.py',
      commandLine: 'python gen.py',
      cwd: 'E:/cases'
    })).toEqual({
      kind: 'generator',
      generator: 'gen.py',
      commandLine: 'python gen.py',
      cwd: 'E:/cases'
    });
    expect(asmCaseSourceFromBatchSource({
      kind: 'generator',
      generator: 'builtin:random-asm'
    })).toEqual({
      kind: 'builtin',
      generator: 'builtin:random-asm',
      commandLine: undefined,
      cwd: undefined
    });
  });

  it('extracts stable result fields from ASM cases', () => {
    const asmCase = fakeAsmCase();

    expect(caseResultFields(asmCase)).toEqual({
      caseId: 'case-1',
      caseManifest: asmCase.manifestUri.fsPath,
      asmSnapshot: asmCase.asm.fsPath
    });
  });

  it('builds failed course trace results with optional artifact fields', () => {
    const asm = vscode.Uri.file('E:/workspace/test.asm');
    const stdin = vscode.Uri.file('E:/workspace/test.in');
    const machineCode = vscode.Uri.file('E:/workspace/code.txt');
    const marsOut = vscode.Uri.file('E:/workspace/mars.out');
    const result = failedCase(
      { asm, stdin },
      'mars',
      'MARS failed',
      machineCode,
      marsOut,
      fakeAsmCase()
    );

    expect(result).toMatchObject({
      asm: asm.fsPath,
      stdin: stdin.fsPath,
      caseId: 'case-1',
      status: 'error',
      stage: 'mars',
      message: 'MARS failed',
      machineCode: machineCode.fsPath,
      marsOut: marsOut.fsPath
    });
  });
});

function fakeAsmCase(): AsmCase {
  return {
    id: 'case-1',
    dir: vscode.Uri.file('E:/workspace/.co/cases/case-1'),
    manifestUri: vscode.Uri.file('E:/workspace/.co/cases/case-1/case.json'),
    asm: vscode.Uri.file('E:/workspace/.co/cases/case-1/program.asm'),
    machineCode: vscode.Uri.file('E:/workspace/.co/cases/case-1/code.txt'),
    sourceAsm: vscode.Uri.file('E:/workspace/test.asm'),
    manifest: {} as never
  };
}
