import { beforeEach, describe, expect, it, vi } from 'vitest';

const p3PipelineState = vi.hoisted(() => ({
  directCopyArtifact: vi.fn(),
  injectMachineCode: vi.fn(),
  prepareMachineCode: vi.fn(),
  readTextFile: vi.fn(),
  setMainCircuit: vi.fn(),
  updateMetadata: vi.fn(),
  writeArtifact: vi.fn()
}));

vi.mock('vscode', () => ({
  window: {},
  workspace: {
    getConfiguration: vi.fn(() => ({ inspect: vi.fn(() => undefined) }))
  }
}));

vi.mock('../asmCaseStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../asmCaseStore')>(),
  copyAsmCaseArtifact: p3PipelineState.directCopyArtifact,
  updateAsmCaseMetadata: p3PipelineState.updateMetadata,
  writeAsmCaseArtifact: p3PipelineState.writeArtifact
}));

vi.mock('../courseTesting/logisimTrace', () => ({
  p3LogisimMaxWords: 4096,
  prepareP3LogisimMachineCode: p3PipelineState.prepareMachineCode,
  setLogisimMainCircuit: p3PipelineState.setMainCircuit
}));

vi.mock('../fsUtil', () => ({
  readTextFile: p3PipelineState.readTextFile,
  workspaceFolderFor: vi.fn(() => undefined)
}));

vi.mock('../language/logisim/rom', () => ({
  injectMachineCodeIntoLogisimRom: p3PipelineState.injectMachineCode
}));

import { p3LogisimRomCapacityError, runP3LogisimTraceCase } from '../courseTestLogisim';
import type { LogisimRomTarget } from '../language/logisim/rom';

describe('course test Logisim helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports the course IFU capacity limit first', () => {
    const target = { index: 0, addrWidth: 20 } as LogisimRomTarget;

    expect(p3LogisimRomCapacityError(target, 5000)).toBe('P3 Logisim 机器码共有 5000 words，超过教程 IFU 4096 words 容量');
  });

  it('reports selected ROM address capacity limits', () => {
    const target = { index: 0, addrWidth: 4 } as LogisimRomTarget;

    expect(p3LogisimRomCapacityError(target, 17)).toBe('所选 Logisim ROM 地址宽度为 4，容量 16 words，小于本用例 17 words');
  });

  it('accepts unknown or large ROM capacities', () => {
    expect(p3LogisimRomCapacityError({ index: 0 } as LogisimRomTarget, 128)).toBeUndefined();
    expect(p3LogisimRomCapacityError({ index: 0, addrWidth: 31 } as LogisimRomTarget, 4096)).toBeUndefined();
  });

  it('returns a neutral DUT-stage result for an unsupported stdin case', async () => {
    const result = await runP3LogisimTraceCase(
      { output: { appendLine: vi.fn() } } as never,
      {
        asm: { fsPath: 'E:/workspace/test.asm' } as never,
        stdin: { fsPath: 'E:/workspace/test.in' } as never
      }
    );

    expect(result).toMatchObject({
      asm: 'E:/workspace/test.asm',
      stdin: 'E:/workspace/test.in',
      status: 'error',
      stage: 'dut'
    });
    expect(result).not.toHaveProperty('logisimOut');
    expect(result).not.toHaveProperty('simOut');
  });

  it('captures the P3 case profile from the ASM instead of a cross-root circuit', async () => {
    const asm = { fsPath: 'E:/asm-root/test.asm' };
    const circuit = { fsPath: 'F:/circuit-root/cpu.circ' };
    const asmCase = {
      id: 'case-profile',
      dir: { fsPath: 'E:/asm-root/.co/cases/case-profile' },
      manifestUri: { fsPath: 'E:/asm-root/.co/cases/case-profile/case.json' },
      asm: { fsPath: 'E:/asm-root/.co/cases/case-profile/program.asm' },
      sourceAsm: { fsPath: 'E:/asm-root/.co/cases/case-profile/source/main.asm' },
      machineCode: { fsPath: 'E:/asm-root/.co/cases/case-profile/code.txt' },
      manifest: {}
    };
    const createCase = vi.fn(async () => asmCase);
    const pipeline = {
      createCase,
      prepareProgram: vi.fn(async () => undefined)
    };
    p3PipelineState.writeArtifact.mockResolvedValue({ fsPath: 'diagnostic.txt' });

    const result = await runP3LogisimTraceCase(
      { output: { appendLine: vi.fn() } } as never,
      { asm: asm as never },
      {
        pipeline: pipeline as never,
        logisim: {
          circuit,
          circuitText: '<circuit />',
          traceCircuit: 'main',
          traceSpec: {},
          traceDiagnostic: 'ok',
          romTarget: { index: 0, addrWidth: 12 }
        } as never
      }
    );

    expect(result).toMatchObject({ status: 'error', stage: 'assemble' });
    expect(createCase).toHaveBeenCalledWith(asm, expect.objectContaining({
      resource: asm,
      enginePlan: expect.objectContaining({ profile: 'P3' })
    }));
  });

  it('copies the P3 circuit template through the injected pipeline', async () => {
    const expected = new Error('pipeline copy reached');
    const unexpected = new Error('direct artifact path reached');
    const circuit = { fsPath: 'E:/workspace/cpu.circ' };
    const asmCase = {
      id: 'case-1',
      dir: { fsPath: 'E:/workspace/.co/cases/case-1' },
      manifestUri: { fsPath: 'E:/workspace/.co/cases/case-1/case.json' },
      asm: { fsPath: 'E:/workspace/.co/cases/case-1/program.asm' },
      sourceAsm: { fsPath: 'E:/workspace/.co/cases/case-1/source/main.asm' },
      machineCode: { fsPath: 'E:/workspace/.co/cases/case-1/code.txt' },
      manifest: {}
    };
    const copyArtifact = vi.fn(async () => { throw expected; });
    const pipeline = {
      prepareProgram: vi.fn(async () => ({
        ok: true,
        outputFile: asmCase.machineCode,
        image: {}
      })),
      copyArtifact
    };
    p3PipelineState.readTextFile.mockResolvedValue('1000ffff\n00000000\n');
    p3PipelineState.prepareMachineCode.mockReturnValue({
      text: '1000ffff\n00000000\n',
      haltPc: 0x3000,
      haltPcHex: '00003000',
      terminatedWordCount: 2
    });
    p3PipelineState.injectMachineCode.mockReturnValue({ text: '<circuit />' });
    p3PipelineState.setMainCircuit.mockReturnValue('<circuit main="main" />');
    p3PipelineState.writeArtifact.mockImplementation(async (_case, _kind, name: string) => ({
      fsPath: `E:/workspace/.co/cases/case-1/logisim/${name}`
    }));
    p3PipelineState.directCopyArtifact.mockResolvedValue(undefined);
    p3PipelineState.updateMetadata.mockRejectedValue(unexpected);

    const result = await runP3LogisimTraceCase(
      { output: { appendLine: vi.fn() } } as never,
      { asm: { fsPath: 'E:/workspace/test.asm' } as never, asmCase: asmCase as never },
      {
        pipeline: pipeline as never,
        logisim: {
          circuit,
          circuitText: '<circuit />',
          traceCircuit: 'main',
          traceSpec: {},
          traceDiagnostic: 'ok',
          romTarget: { index: 0, addrWidth: 12 }
        } as never
      }
    );
    expect(result).toMatchObject({ status: 'error', stage: 'dut', message: expected.message });
    expect(copyArtifact).toHaveBeenCalledWith(
      asmCase,
      'logisim',
      circuit,
      'circuit-template.circ',
      'circuitTemplate'
    );
    expect(p3PipelineState.directCopyArtifact).not.toHaveBeenCalled();
  });
});
