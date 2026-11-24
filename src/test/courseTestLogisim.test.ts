import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';

const p3PipelineState = vi.hoisted(() => ({
  directCopyArtifact: vi.fn(),
  injectMachineCode: vi.fn(),
  prepareMachineCode: vi.fn(),
  readTextFile: vi.fn(),
  setMainCircuit: vi.fn(),
  updateMetadata: vi.fn(),
  updateArtifacts: vi.fn(),
  writeTextFile: vi.fn(),
  writeArtifact: vi.fn()
}));

const logisimTempFiles = vi.hoisted(() => ({
  rm: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined)
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
  updateAsmCaseArtifacts: p3PipelineState.updateArtifacts,
  updateAsmCaseMetadata: p3PipelineState.updateMetadata,
  writeAsmCaseArtifact: p3PipelineState.writeArtifact
}));

vi.mock('../courseTesting/logisimTrace', () => ({
  formatLogisimTraceEvents: vi.fn(() => 'canonical trace'),
  parseLogisimTraceOutput: vi.fn(() => ({ rows: [{}], events: [{}] })),
  p3LogisimMaxWords: 4096,
  prepareP3LogisimMachineCode: p3PipelineState.prepareMachineCode,
  setLogisimMainCircuit: p3PipelineState.setMainCircuit,
  validateP3LogisimFetchTrace: vi.fn(() => ({ warnings: [] }))
}));

vi.mock('fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs/promises')>(),
  ...logisimTempFiles
}));
vi.mock('../pathContainment', () => ({ ensureContainedDirectoryPath: vi.fn(async () => undefined) }));

vi.mock('../courseTesting/logisimReset', () => ({
  prepareP3LogisimReset: (text: string, traceSpec: unknown) => ({ text, traceSpec, applied: false })
}));

vi.mock('../fsUtil', () => ({
  ensureDirectory: vi.fn(async () => undefined),
  readTextFile: p3PipelineState.readTextFile,
  writeTextFile: p3PipelineState.writeTextFile,
  workspaceFolderFor: vi.fn(() => undefined)
}));

vi.mock('../language/logisim/rom', async (importOriginal) => ({
  ...await importOriginal<typeof import('../language/logisim/rom')>(),
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

  it('does not archive the injected circuit or duplicate code before a DUT run', async () => {
    const circuit = { fsPath: 'E:/workspace/cpu.circ' };
    const asmCase = {
      id: 'case-1',
      dir: { fsPath: 'E:/workspace/.co/cases/case-1' },
      manifestUri: { fsPath: 'E:/workspace/.co/cases/case-1/case.json' },
      asm: { fsPath: 'E:/workspace/.co/cases/case-1/program.asm' },
      sourceAsm: { fsPath: 'E:/workspace/.co/cases/case-1/source/main.asm' },
      machineCode: { fsPath: 'E:/workspace/.co/cases/case-1/code.txt' },
      manifest: { source: { kind: 'selected', asmFiles: [] } }
    };
    const copyArtifact = vi.fn(async () => undefined);
    const runOracle = vi.fn(async () => ({
      ok: false,
      preflight: { ok: false, diagnostics: [{ code: 'test.stop', message: 'stop after artifacts' }], descriptor: { id: 'builtin-ts' } }
    }));
    const pipeline = {
      prepareProgram: vi.fn(async () => ({
        ok: true,
        outputFile: asmCase.machineCode,
        image: {}
      })),
      validateProgram: vi.fn(() => []),
      copyArtifact,
      runOracle
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
    p3PipelineState.updateMetadata.mockResolvedValue(undefined);

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
    expect(result).toMatchObject({ status: 'error', stage: 'oracle' });
    const writtenNames = p3PipelineState.writeArtifact.mock.calls.map((call) => call[2]);
    expect(writtenNames).toEqual(['logisim-trace-diagnostic.txt', 'logisim-trace-spec.json']);
    expect(writtenNames).not.toContain('logisim-code.txt');
    expect(writtenNames).not.toContain('circuit-template.circ');
    expect(copyArtifact).not.toHaveBeenCalledWith(asmCase, 'logisim', circuit, 'circuit-template.circ', 'circuitTemplate');
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

  it('uses the default auto engine for a manual P3 run without legacy settings', async () => {
    const fixture = automaticP3Fixture();
    const runOracle = vi.fn(async () => ({
      ok: false,
      preflight: { ok: false, diagnostics: [{ code: 'builtin.error', message: 'stop after engine assertion' }], descriptor: { id: 'builtin-ts' } }
    }));
    const pipeline = automaticP3Pipeline(fixture, runOracle);
    const result = await runP3LogisimTraceCase(
      fixture.services,
      { asm: fixture.asm as never, asmCase: fixture.asmCase as never },
      {
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
      expect.objectContaining({ mode: 'auto', primaryEngineId: 'builtin-ts' })
    );
    expect(runFullStackShadow).not.toHaveBeenCalled();
    expect(verifyConfiguredFixedMarsReference).not.toHaveBeenCalled();
  });

  it('cleans a passing temporary circuit and archives the same circuit for DUT failures', async () => {
    const fixture = automaticP3Fixture();
    const pipeline = automaticP3Pipeline(fixture, vi.fn(async () => successfulOracleInvocation()));
    const passedCircuit = await runP3LogisimTraceCase(
      fixture.services,
      { asm: fixture.asm as never, asmCase: fixture.asmCase as never },
      {
        source: { kind: 'generator' },
        artifactOutputMode: 'case',
        pipeline: {
          ...pipeline,
          compareTraces: vi.fn(() => ({
            matched: true,
            summary: { oracleEvents: 1, dutEvents: 1, matchedEvents: 1, diffEvents: 0 },
            firstDiffIndex: -1
          })),
          runLogisimDut: vi.fn(async (_services, _setup, circuit) => ({
            result: { ok: true, exitCode: 0 }, stdout: 'row', stderr: '', rowsSeen: 1, haltedByPc: true
          }))
        } as never,
        logisim: fixture.logisim as never
      }
    );

    expect(passedCircuit).toMatchObject({ status: 'passed' });
    expect(passedCircuit).not.toHaveProperty('logisimCircuit');
    expect(passedCircuit).toMatchObject({ dutRawOut: expect.stringContaining('test.logisim.out') });
    expect(passedCircuit.dutOut).toContain('test.sim.out');
    expect(logisimTempFiles.writeFile).toHaveBeenCalledOnce();
    expect(logisimTempFiles.rm).toHaveBeenCalledOnce();
    expect(p3PipelineState.updateArtifacts).not.toHaveBeenCalledWith(
      fixture.asmCase,
      'logisim',
      expect.objectContaining({ preparedCircuit: expect.any(String) })
    );

    vi.clearAllMocks();
    const failedFixture = automaticP3Fixture();
    const failedPipeline = automaticP3Pipeline(failedFixture, vi.fn(async () => successfulOracleInvocation()));
    failedPipeline.runLogisimDut = vi.fn(async () => ({
      result: { ok: false, exitCode: 1 }, stdout: 'partial rows', stderr: 'Logisim failed', rowsSeen: 1, haltedByPc: false
    })) as never;
    const failed = await runP3LogisimTraceCase(
      failedFixture.services,
      { asm: failedFixture.asm as never, asmCase: failedFixture.asmCase as never },
      {
        source: { kind: 'generator' },
        artifactOutputMode: 'case',
        pipeline: failedPipeline as never,
        logisim: failedFixture.logisim as never
      }
    );

    const tempPath = URI.file((logisimTempFiles.writeFile.mock.calls[0] as unknown as [string])[0]);
    expect(tempPath.path).toMatch(/\/logisim\/cpu-[0-9a-f]{8}\.circ$/i);
    expect(failed).toMatchObject({ status: 'error', logisimCircuit: tempPath.fsPath, dutRawOut: expect.any(String) });
    expect(p3PipelineState.updateArtifacts).toHaveBeenCalledWith(failedFixture.asmCase, 'logisim', { preparedCircuit: tempPath.fsPath });
    expect(logisimTempFiles.rm).not.toHaveBeenCalled();
  });

  it('cleans cancelled circuits without archiving a prepared circuit or partial case output', async () => {
    const fixture = automaticP3Fixture();
    const pipeline = automaticP3Pipeline(fixture, vi.fn(async () => successfulOracleInvocation()));
    pipeline.runLogisimDut = vi.fn(async () => ({
      result: { ok: false, stopped: true, stopReason: 'cancelled' },
      stdout: 'partial rows', stderr: '', rowsSeen: 1, haltedByPc: false
    })) as never;

    const result = await runP3LogisimTraceCase(
      fixture.services,
      { asm: fixture.asm as never, asmCase: fixture.asmCase as never },
      {
        source: { kind: 'generator' },
        artifactOutputMode: 'case',
        pipeline: pipeline as never,
        logisim: fixture.logisim as never
      }
    );

    expect(result).toMatchObject({ status: 'error', cancelled: true });
    expect(result).not.toHaveProperty('dutRawOut');
    expect(result).not.toHaveProperty('logisimCircuit');
    expect(p3PipelineState.updateArtifacts).not.toHaveBeenCalledWith(
      fixture.asmCase,
      'logisim',
      expect.objectContaining({ preparedCircuit: expect.any(String) })
    );
    expect(logisimTempFiles.rm).toHaveBeenCalledOnce();
  });

  it('removes a partially written temporary circuit when file creation fails', async () => {
    const fixture = automaticP3Fixture();
    const pipeline = automaticP3Pipeline(fixture, vi.fn(async () => successfulOracleInvocation()));
    logisimTempFiles.writeFile.mockRejectedValueOnce(new Error('partial write'));

    const result = await runP3LogisimTraceCase(
      fixture.services,
      { asm: fixture.asm as never, asmCase: fixture.asmCase as never },
      {
        source: { kind: 'generator' },
        artifactOutputMode: 'case',
        pipeline: pipeline as never,
        logisim: fixture.logisim as never
      }
    );

    expect(result).toMatchObject({ status: 'error', stage: 'dut' });
    expect(logisimTempFiles.rm).toHaveBeenCalledOnce();
    expect(pipeline.runLogisimDut).not.toHaveBeenCalled();
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
    runLogisimDut: vi.fn(),
    compareTraces: vi.fn(),
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
