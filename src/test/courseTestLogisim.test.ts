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

vi.mock('vscode', async () => {
  const { URI } = await import('vscode-uri');
  return {
    Uri: URI,
    window: {},
    workspace: {
      getConfiguration: vi.fn(() => ({ inspect: vi.fn(() => undefined) }))
    }
  };
});

vi.mock('../config', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config')>(),
  getProfile: vi.fn(() => 'P3'),
  getMemoryConfiguration: vi.fn(() => 'Default')
}));

vi.mock('../asmCaseStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../asmCaseStore')>(),
  asmCaseSourceSnapshotIssue: vi.fn(async () => undefined),
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

vi.mock('../mips/providers/fixedMarsReference', () => ({
  verifyConfiguredFixedMarsReference: vi.fn()
}));

vi.mock('../courseTesting/fullStackShadowRunner', () => ({
  runFullStackShadow: vi.fn()
}));

import { p3LogisimRomCapacityError, runP3LogisimTraceCase } from '../courseTestLogisim';
import type { LogisimRomTarget } from '../language/logisim/rom';
import { verifyConfiguredFixedMarsReference } from '../mips/providers/fixedMarsReference';
import { runFullStackShadow } from '../courseTesting/fullStackShadowRunner';

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

  it.each(['mars', 'verify-both'] as const)(
    'keeps every generated P3 case on the private builtin stack despite an explicit %s override',
    async (engineMode) => {
      const fixture = automaticP3Fixture();
      const runOracle = vi.fn(async () => ({
        ok: false,
        result: {
          ok: false,
          status: { ok: false, exitCode: 1, stdout: 'private stdout', stderr: 'private stderr', timedOut: false },
          descriptor: { id: 'builtin-ts' }
        },
        preflight: { ok: true, diagnostics: [], descriptor: { id: 'builtin-ts' } }
      }));
      const pipeline = automaticP3Pipeline(fixture, runOracle);

      const result = await runP3LogisimTraceCase(
        fixture.services,
        { asm: fixture.asm as never, asmCase: fixture.asmCase as never },
        {
          source: { kind: 'generator' },
          engineMode,
          artifactOutputMode: 'case',
          pipeline: pipeline as never,
          logisim: fixture.logisim as never
        }
      );

      expect(result).toMatchObject({ status: 'error', stage: 'oracle' });
      expect(pipeline.prepareProgram).toHaveBeenCalledWith(
        expect.anything(),
        fixture.asmCase,
        expect.objectContaining({
          nonInteractive: true,
          enginePlan: expect.objectContaining({ mode: 'builtin', primaryEngineId: 'builtin-ts' })
        })
      );
      expect(runOracle).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ nonInteractive: true }),
        expect.objectContaining({ mode: 'builtin', primaryEngineId: 'builtin-ts' })
      );
      expect(verifyConfiguredFixedMarsReference).not.toHaveBeenCalled();
      expect(runFullStackShadow).not.toHaveBeenCalled();
      const visibleOutput = fixture.output.appendLine.mock.calls.flat().join('\n');
      expect(visibleOutput).not.toContain('private stdout');
      expect(visibleOutput).not.toContain('private stderr');
    }
  );

  it('preserves the P3 verify-both full-stack lane for a manual case', async () => {
    const fixture = automaticP3Fixture();
    const runOracle = vi.fn(async () => successfulOracleInvocation());
    const pipeline = automaticP3Pipeline(fixture, runOracle);
    vi.mocked(verifyConfiguredFixedMarsReference).mockResolvedValueOnce({
      ok: true,
      identity: { sha256: 'a'.repeat(64) }
    } as never);
    vi.mocked(runFullStackShadow).mockResolvedValueOnce({
      evidenceKind: 'full-stack',
      status: 'inconclusive',
      message: 'stop after quiet-context assertion',
      bundleDir: 'E:/workspace/shadow',
      resultFile: 'E:/workspace/shadow/full-stack-result.json',
      assembly: {
        matched: false,
        builtinWords: 2,
        legacyWords: 2,
        disposition: 'inconclusive',
        message: 'stop after quiet-context assertion'
      }
    } as never);

    const result = await runP3LogisimTraceCase(
      fixture.services,
      { asm: fixture.asm as never, asmCase: fixture.asmCase as never },
      {
        engineMode: 'verify-both',
        artifactOutputMode: 'case',
        pipeline: pipeline as never,
        logisim: fixture.logisim as never
      }
    );

    expect(result).toMatchObject({ status: 'error', stage: 'oracle' });
    expect(runOracle).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ nonInteractive: undefined }),
      expect.objectContaining({ mode: 'verify-both', primaryEngineId: 'builtin-ts' })
    );
    expect(runFullStackShadow).toHaveBeenCalledWith(
      expect.anything(),
      fixture.asmCase,
      expect.objectContaining({
        expectedLegacySha256: 'a'.repeat(64),
        nonInteractive: undefined
      })
    );
  });
});

function automaticP3Fixture() {
  const asm = { fsPath: 'E:/workspace/test.asm' };
  const asmCase = {
    id: 'case-auto-p3',
    dir: { fsPath: 'E:/workspace/.co/cases/case-auto-p3' },
    manifestUri: { fsPath: 'E:/workspace/.co/cases/case-auto-p3/case.json' },
    asm: { fsPath: 'E:/workspace/.co/cases/case-auto-p3/program.asm' },
    sourceAsm: { fsPath: 'E:/workspace/.co/cases/case-auto-p3/source/main.asm' },
    machineCode: { fsPath: 'E:/workspace/.co/cases/case-auto-p3/code.txt' },
    manifest: { version: 1, source: { kind: 'generator', generator: 'builtin-random' } }
  };
  const logisim = {
    circuit: { fsPath: 'E:/workspace/cpu.circ' },
    circuitText: '<circuit />',
    traceCircuit: 'main',
    traceSpec: {},
    traceDiagnostic: 'ok',
    romTarget: { index: 0, addrWidth: 12 }
  };
  const output = { appendLine: vi.fn(), append: vi.fn() };
  p3PipelineState.readTextFile.mockImplementation(async (uri: { fsPath: string }) => (
    uri.fsPath.endsWith('main.asm')
      ? '.text\nbeq $0,$0,-1\nnop\n'
      : '1000ffff\n00000000\n'
  ));
  p3PipelineState.prepareMachineCode.mockReturnValue({
    text: '1000ffff\n00000000\n',
    haltPc: 0x3000,
    haltPcHex: '00003000',
    terminatedWordCount: 2
  });
  p3PipelineState.injectMachineCode.mockReturnValue({ text: '<circuit />' });
  p3PipelineState.setMainCircuit.mockReturnValue('<circuit main="main" />');
  p3PipelineState.writeArtifact.mockImplementation(async (_case, _kind, name: string) => ({
    fsPath: `E:/workspace/.co/cases/case-auto-p3/logisim/${name}`
  }));
  p3PipelineState.updateMetadata.mockResolvedValue(undefined);
  return {
    asm,
    asmCase,
    logisim,
    output,
    services: { output } as never
  };
}

function automaticP3Pipeline(
  fixture: ReturnType<typeof automaticP3Fixture>,
  runOracle: ReturnType<typeof vi.fn>
) {
  return {
    prepareProgram: vi.fn(async () => ({
      ok: true,
      outputFile: fixture.asmCase.machineCode,
      status: { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false },
      descriptor: { id: 'builtin-ts' },
      image: {},
      executionBinding: undefined
    })),
    validateProgram: vi.fn(() => []),
    copyArtifact: vi.fn(async () => undefined),
    updateArtifacts: vi.fn(async () => undefined),
    recordOracle: vi.fn(async () => undefined),
    runOracle
  };
}

function successfulOracleInvocation() {
  return {
    ok: true,
    result: {
      ok: true,
      outputFile: { fsPath: 'E:/workspace/.co/cases/case-auto-p3/oracle/oracle.out' },
      status: { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false },
      descriptor: { id: 'builtin-ts' },
      trace: {
        schemaRevision: 1,
        eventSchema: 'buaa-co-architectural-write-v1',
        events: [],
        rawText: '',
        rawTraceRevision: 1
      },
      stop: { kind: 'halt-loop', haltPc: 0x3000 }
    },
    preflight: { ok: true, diagnostics: [], descriptor: { id: 'builtin-ts' } }
  };
}
