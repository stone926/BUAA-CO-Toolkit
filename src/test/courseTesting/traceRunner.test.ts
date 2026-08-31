import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import type { AsmCase } from '../../asmCaseStore';
import { runCourseTraceCase } from '../../courseTesting/traceRunner';
import { getMipsEngine, getProfile } from '../../config';
import { runP3LogisimTraceCase } from '../../courseTestLogisim';
import {
  asmCaseSourceSnapshotIssue,
  prepareAsmCaseMachineCode,
  createAsmCaseFromAsm,
  readAsmCaseStdinSnapshot,
  recordAsmCaseOracleResult
} from '../../asmCaseStore';
import { executeWithPreflight } from '../../mips/providers/providerResolver';
import { runVerilogSimulation } from '../../verilog/simulationRunner';
import { readTextFile } from '../../fsUtil';
import { compareTraceIterables } from '../../language/mips/traceCompare';
import {
  iterCpuTraceEvents
} from '../../language/mips/traceParser';
import { checkP7Probe } from '../../courseTesting/p7ProbeCheck';
import { createLegacyProgramImage } from '../../mips/replay/programImage';
import { verifyConfiguredFixedMarsReference } from '../../mips/providers/fixedMarsReference';
import { runFullStackShadow } from '../../courseTesting/fullStackShadowRunner';

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  return createVscodeModuleMock(createVscodeMockState(), vi.fn);
});

vi.mock('../../config', () => ({
  getProfile: vi.fn(() => 'P5'),
  getMipsEngine: vi.fn(() => 'auto'),
  getMemoryConfiguration: vi.fn(() => 'Default')
}));

vi.mock('../../asmCaseStore', () => ({
  asmCaseArtifactUri: vi.fn((_asmCase, kind: string, fileName: string) => URI.file(`E:/work/.co/cases/case-1/${kind}/${fileName}`)),
  asmCaseSourceSnapshotIssue: vi.fn(async () => undefined),
  copyAsmCaseArtifact: vi.fn(async () => undefined),
  createAsmCaseFromAsm: vi.fn(),
  prepareAsmCaseMachineCode: vi.fn(),
  readAsmCaseStdinSnapshot: vi.fn(async () => undefined),
  recordAsmCaseOracleResult: vi.fn(async () => undefined),
  readAsmCaseManifestForAsm: vi.fn(async () => undefined),
  updateAsmCaseArtifacts: vi.fn(async () => undefined)
}));

vi.mock('../../mips/providers/providerResolver', () => ({
  executeWithPreflight: vi.fn()
}));

vi.mock('../../mips/providers/fixedMarsReference', () => ({
  verifyConfiguredFixedMarsReference: vi.fn()
}));

vi.mock('../../courseTesting/fullStackShadowRunner', () => ({
  runFullStackShadow: vi.fn()
}));

vi.mock('../../verilog/simulationRunner', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../verilog/simulationRunner')>(),
  runVerilogSimulation: vi.fn()
}));

vi.mock('../../fsUtil', () => ({
  readTextFile: vi.fn(),
  workspaceFolderFor: vi.fn(() => undefined)
}));

vi.mock('../../language/mips/traceCompare', () => ({
  compareTraceIterables: vi.fn(),
  firstTraceDiffSnapshot: vi.fn(() => ({ index: 0, status: 'diff' }))
}));

vi.mock('../../language/mips/traceParser', () => ({
  iterCpuTraceEvents: vi.fn((text: string) => text.split('\n').filter((line) => line === 'trace'))
}));

vi.mock('../../language/verilog/traceParser', () => ({
  parseSimOutput: vi.fn(() => [{ pc: 0x3000 }])
}));

vi.mock('../../traceCompare', () => ({
  defaultTraceCompareMode: { compareCycles: true }
}));

vi.mock('../../courseTestLogisim', () => ({
  runP3LogisimTraceCase: vi.fn()
}));

vi.mock('../../courseTesting/p7ProbeCheck', () => ({
  checkP7Probe: vi.fn()
}));

const callOrder: string[] = [];
const testProgramImage = createLegacyProgramImage(
  '00000000\n1000ffff\n00000000\n',
  [{ id: 'root', contentHash: 'b'.repeat(64) }]
);

function services() {
  return {
    output: {
      appendLine: vi.fn((line: string) => callOrder.push(line.startsWith('完整') ? 'start' : 'output')),
      append: vi.fn(),
      show: vi.fn(),
      clear: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      name: 'test'
    } as never,
    statusBar: {} as never
  };
}

function makeAsmCase(overrides: Partial<AsmCase['manifest']> = {}): AsmCase {
  return {
    id: 'case-1',
    dir: URI.file('E:/work/.co/cases/case-1'),
    manifestUri: URI.file('E:/work/.co/cases/case-1/case.json'),
    asm: URI.file('E:/work/.co/cases/case-1/program.asm'),
    sourceAsm: URI.file('E:/work/src/test.asm'),
    machineCode: URI.file('E:/work/.co/cases/case-1/code.txt'),
    manifest: {
      version: 1,
      caseId: 'case-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      source: { kind: 'selected' },
      asm: { path: 'E:/work/src/test.asm', sha256: 'asm' },
      machineCode: {
        path: 'E:/work/.co/cases/case-1/code.txt',
        sha256: 'code',
        bytes: 12,
        wordCount: 3,
        haltPc: 0x3004
      },
      ...overrides
    }
  };
}

describe('course trace runner orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recordAsmCaseOracleResult).mockResolvedValue(undefined);
    vi.mocked(getMipsEngine).mockReturnValue('auto');
    vi.mocked(readAsmCaseStdinSnapshot).mockResolvedValue(undefined);
    vi.mocked(asmCaseSourceSnapshotIssue).mockResolvedValue(undefined);
    callOrder.splice(0);
    const currentCase = makeAsmCase();
    vi.mocked(createAsmCaseFromAsm).mockImplementation(async () => {
      callOrder.push('create-case');
      return currentCase;
    });
    const descriptor = { id: 'legacy-mars-v0.6.3' } as never;
    vi.mocked(prepareAsmCaseMachineCode).mockImplementation(async () => {
      callOrder.push('dump');
      return {
        ok: true,
        status: { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false },
        outputFile: currentCase.machineCode,
        descriptor,
        image: testProgramImage,
        executionBinding: {
          kind: 'source-reassembly', providerId: descriptor.id,
          sourceUri: currentCase.sourceAsm, imageFingerprint: testProgramImage.fingerprint
        }
      } as never;
    });
    vi.mocked(executeWithPreflight).mockImplementation(async () => {
      callOrder.push('oracle');
      return {
        ok: true,
        result: {
          ok: true,
          status: { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false },
          outputFile: URI.file('E:/work/oracle.out'),
          descriptor,
          trace: {
            schemaRevision: 1,
            eventSchema: 'buaa-co-architectural-write-v1',
            events: ['canonical-oracle-event'],
            rawText: '@PC00003004 -> beq $0, $0, -1 (1000ffff)\n',
            rawTraceRevision: 2
          },
          stop: { kind: 'halt-loop', haltPc: 0x3004 }
        },
        preflight: { ok: true, diagnostics: [], descriptor }
      } as never;
    });
    vi.mocked(runVerilogSimulation).mockImplementation(async () => {
      callOrder.push('isim');
      return {
        backend: 'isim',
        generated: {} as never,
        fuseResult: { ok: true, code: 0, stdout: '', stderr: '' },
        simResult: { ok: true, code: 0, stdout: '', stderr: '' },
        simOut: URI.file('E:/work/sim.out')
      };
    });
    vi.mocked(readTextFile).mockImplementation(async (uri) => {
      if (uri.fsPath.endsWith('code.txt')) {
        return '00000000\n1000ffff\n00000000\n';
      }
      return 'trace\n';
    });
    vi.mocked(compareTraceIterables).mockImplementation(() => {
      callOrder.push('compare');
      return {
        matched: true,
        firstDiffIndex: -1,
        summary: { oracleEvents: 1, dutEvents: 1, matchedEvents: 1, diffEvents: 0 }
      } as never;
    });
    vi.mocked(checkP7Probe).mockReturnValue({ passed: true, failures: [] } as never);
  });

  it('creates a case, assembles a ProgramImage, runs an oracle and ISim, then compares canonical traces', async () => {
    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result.status).toBe('passed');
    expect(callOrder).toEqual(expect.arrayContaining(['create-case', 'dump', 'oracle', 'isim', 'compare']));
    expect(callOrder.indexOf('create-case')).toBeLessThan(callOrder.indexOf('dump'));
    expect(callOrder.indexOf('dump')).toBeLessThan(callOrder.indexOf('oracle'));
    expect(callOrder.indexOf('oracle')).toBeLessThan(callOrder.indexOf('isim'));
    expect(callOrder.indexOf('isim')).toBeLessThan(callOrder.indexOf('compare'));
    const executeRequest = vi.mocked(executeWithPreflight).mock.calls[0][1];
    expect(executeRequest).toMatchObject({
      image: testProgramImage,
      trace: { kind: 'architectural-writes', courseCorrect: true },
      haltPc: 0x3004
    });
    expect(result).toMatchObject({
      stage: 'compare',
      oracleOut: expect.stringContaining('oracle.out'),
      dutOut: expect.stringContaining('sim.out'),
      oracleEvents: 1,
      dutEvents: 1
    });
    expect(result).not.toHaveProperty('marsOut');
    expect(result).not.toHaveProperty('simOut');
    expect(result).not.toHaveProperty('marsEvents');
    expect(result).not.toHaveProperty('simEvents');
  });

  it('snapshots one atomic engine plan for case capture, assembly and execution', async () => {
    await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    const capturedPlan = vi.mocked(createAsmCaseFromAsm).mock.calls[0][1]?.enginePlan;
    expect(capturedPlan).toMatchObject({ mode: 'auto', primaryEngineId: 'builtin-ts', profile: 'P5' });
    expect(vi.mocked(prepareAsmCaseMachineCode).mock.calls[0][2]?.enginePlan).toBe(capturedPlan);
    expect(vi.mocked(executeWithPreflight).mock.calls[0][3]).toBe(capturedPlan);
  });

  it('accepts a native ProgramImage assembler without a legacy source-reassembly binding', async () => {
    const currentCase = makeAsmCase();
    vi.mocked(prepareAsmCaseMachineCode).mockResolvedValueOnce({
      ok: true,
      status: { ok: true, exitCode: null, stdout: '', stderr: '', timedOut: false },
      outputFile: currentCase.machineCode,
      descriptor: { id: 'builtin-ts', kind: 'assembler', semanticsRevision: 2, capabilitiesRevision: 1 },
      image: testProgramImage
    } as never);

    const result = await runCourseTraceCase(services(), {
      asm: URI.file('E:/work/src/test.asm'),
      asmCase: currentCase
    });

    expect(result.status).toBe('passed');
    expect(executeWithPreflight).toHaveBeenCalled();
    expect(vi.mocked(executeWithPreflight).mock.calls[0][1].executionBinding).toBeUndefined();
  });

  it('lets the P3 runner construct its Logisim pipeline', async () => {
    vi.mocked(getProfile).mockReturnValueOnce('P3');
    vi.mocked(runP3LogisimTraceCase).mockResolvedValueOnce({
      asm: 'E:/work/src/test.asm',
      status: 'passed',
      stage: 'compare',
      message: 'ok'
    } as never);

    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result.status).toBe('passed');
    expect(runP3LogisimTraceCase).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ pipeline: expect.anything() })
    );
  });

  it('executes only the manifest-bound case-local stdin snapshot', async () => {
    const currentCase = makeAsmCase({
      stdin: {
        originalPath: 'E:/work/input.txt',
        path: 'stdin/input.txt',
        sha256: 'a'.repeat(64),
        bytes: 7
      }
    } as never);
    currentCase.stdin = URI.file('E:/work/.co/cases/case-1/stdin/input.txt');
    vi.mocked(readAsmCaseStdinSnapshot).mockResolvedValueOnce('sealed\n');

    const result = await runCourseTraceCase(services(), {
      asm: URI.file('E:/work/src/test.asm'),
      stdin: URI.file('E:/work/input.txt'),
      asmCase: currentCase
    });

    expect(result.status).toBe('passed');
    expect(executeWithPreflight).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stdin: 'sealed\n' }),
      expect.anything(),
      expect.objectContaining({ primaryEngineId: 'legacy-mars-configured' })
    );
    expect(vi.mocked(executeWithPreflight).mock.calls[0][1]).not.toHaveProperty('stdinSource');
  });

  it('rejects replacing stdin on an existing case', async () => {
    const currentCase = makeAsmCase({
      stdin: {
        originalPath: 'E:/work/input-a.txt',
        path: 'stdin/input-a.txt',
        sha256: 'a'.repeat(64),
        bytes: 2
      }
    } as never);
    currentCase.stdin = URI.file('E:/work/.co/cases/case-1/stdin/input-a.txt');

    const result = await runCourseTraceCase(services(), {
      asm: URI.file('E:/work/src/test.asm'),
      stdin: URI.file('E:/work/input-b.txt'),
      asmCase: currentCase
    });

    expect(result).toMatchObject({ status: 'error', stage: 'oracle' });
    expect(result.message).toContain('不能改用另一个标准输入');
    expect(prepareAsmCaseMachineCode).not.toHaveBeenCalled();
    expect(executeWithPreflight).not.toHaveBeenCalled();
  });

  it('marks an aborted oracle run as a cancelled case', async () => {
    const descriptor = { id: 'legacy-mars-v0.6.3' } as never;
    vi.mocked(executeWithPreflight).mockResolvedValueOnce({
      ok: false,
      result: {
        ok: false,
        status: {
          ok: false,
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          stopped: true,
          stopReason: 'aborted'
        },
        descriptor
      },
      preflight: { ok: true, diagnostics: [], descriptor }
    } as never);

    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result).toMatchObject({ status: 'error', stage: 'oracle', cancelled: true });
    expect(runVerilogSimulation).not.toHaveBeenCalled();
  });

  it('compares the canonical provider projection without interpreting provider-private trace text', async () => {
    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result.status).toBe('passed');
    expect(executeWithPreflight).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ trace: { kind: 'architectural-writes', courseCorrect: true } }),
      expect.objectContaining({ signal: undefined }),
      expect.objectContaining({ primaryEngineId: 'builtin-ts' })
    );
    expect(iterCpuTraceEvents).toHaveBeenCalledTimes(1);
    expect(compareTraceIterables).toHaveBeenCalledWith(
      ['canonical-oracle-event'],
      ['trace'],
      expect.objectContaining({ retainedEntryLimit: 1 })
    );
  });

  it('passes only ProgramImage and a provider-neutral execution binding across the orchestration boundary', async () => {
    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result.status).toBe('passed');
    const request = vi.mocked(executeWithPreflight).mock.calls[0][1];
    expect(request.image).toEqual(testProgramImage);
    expect(request.executionBinding).toMatchObject({
      kind: 'source-reassembly',
      providerId: 'legacy-mars-v0.6.3',
      imageFingerprint: testProgramImage.fingerprint
    });
    expect(request).not.toHaveProperty('sourceUri');
    expect(request).not.toHaveProperty('imageRef');
    expect(request).not.toHaveProperty('traceLevel');
    expect(request).not.toHaveProperty('traceOutput');
  });

  it('rejects an actually executed tutorial undefined behavior before running ISim', async () => {
    const descriptor = { id: 'legacy-mars-v0.6.3' } as never;
    vi.mocked(executeWithPreflight).mockResolvedValueOnce({
      ok: false,
      result: {
        ok: false,
        status: {
          ok: false,
          exitCode: 1,
          stdout: '',
          stderr: '教程未定义行为 DivZero',
          timedOut: false
        },
        descriptor
      },
      preflight: { ok: true, diagnostics: [], descriptor }
    } as never);

    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result).toMatchObject({ status: 'error', stage: 'oracle' });
    expect(result.message).toContain('DivZero');
    expect(runVerilogSimulation).not.toHaveBeenCalled();
  });

  it('surfaces a provider stop-validation failure without knowing its legacy trace format', async () => {
    const descriptor = { id: 'legacy-mars-v0.6.3' } as never;
    vi.mocked(executeWithPreflight).mockResolvedValueOnce({
      ok: false,
      result: {
        ok: false,
        status: {
          ok: false,
          exitCode: 0,
          stdout: '',
          stderr: 'MARS 正常退出但跳出已装载文本，未到达标准停机尾',
          timedOut: false
        },
        descriptor
      },
      preflight: { ok: true, diagnostics: [], descriptor }
    } as never);

    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result).toMatchObject({ status: 'error', stage: 'oracle' });
    expect(result.message).toContain('跳出已装载文本');
    expect(runVerilogSimulation).not.toHaveBeenCalled();
  });

  it('stops after a failed assembly without running the oracle or ISim', async () => {
    vi.mocked(prepareAsmCaseMachineCode).mockResolvedValueOnce({
      ok: false,
      status: { ok: false, exitCode: 1, stdout: '', stderr: 'bad', timedOut: false },
      descriptor: { id: 'legacy-mars-v0.6.3' }
    } as never);

    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result.status).toBe('error');
    expect(result.stage).toBe('assemble');
    expect(executeWithPreflight).not.toHaveBeenCalled();
    expect(runVerilogSimulation).not.toHaveBeenCalled();
  });

  it('classifies an unexpected test-point preparation exception as assemble, not compare', async () => {
    vi.mocked(prepareAsmCaseMachineCode).mockRejectedValueOnce(
      new Error('invalid ProgramImage: symbol references an unknown segment')
    );

    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result).toMatchObject({
      status: 'error',
      stage: 'assemble',
      caseId: 'case-1'
    });
    expect(result.message).toContain('invalid ProgramImage');
    expect(executeWithPreflight).not.toHaveBeenCalled();
    expect(runVerilogSimulation).not.toHaveBeenCalled();
  });

  it('returns a DUT-stage failure with case metadata and prior oracle output', async () => {
    vi.mocked(runVerilogSimulation).mockResolvedValueOnce({
      backend: 'isim',
      generated: {} as never,
      fuseResult: { ok: true, code: 0, stdout: '', stderr: '' },
      simResult: { ok: false, code: 1, stdout: '', stderr: 'bad' }
    } as never);

    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result.status).toBe('error');
    expect(result.stage).toBe('dut');
    expect(result.caseId).toBe('case-1');
    expect(result.machineCode).toContain('code.txt');
    expect(result.oracleOut).toContain('oracle.out');
    expect(result.dutFailure).toMatchObject({
      phase: 'simulate',
      reason: 'exit',
      diagnostic: { message: 'bad' }
    });
    expect(result).not.toHaveProperty('marsOut');
  });

  it('preserves a path-safe Icarus compile diagnostic for the automatic report', async () => {
    vi.mocked(runVerilogSimulation).mockResolvedValueOnce({
      backend: 'iverilog',
      compileResult: {
        ok: false,
        exitCode: 26,
        commandLine: 'E:/SECRET/bin/iverilog.exe --private',
        cwd: 'E:/SECRET/work',
        stdout: '',
        stderr: 'E:/work/rtl/CPU.v:449: error: Unable to bind `D_fixedRD1_reg`',
        timedOut: false,
        stopped: false
      }
    } as never);

    const result = await runCourseTraceCase(
      services(),
      { asm: URI.file('E:/work/src/test.asm') },
      { source: { kind: 'generator' } }
    );

    expect(result).toMatchObject({
      status: 'error',
      stage: 'dut',
      dutBackend: 'iverilog',
      dutFailure: {
        phase: 'compile',
        reason: 'exit',
        exitCode: 26,
        diagnostic: {
          file: 'CPU.v',
          line: 449,
          message: 'Unable to bind `D_fixedRD1_reg`'
        }
      }
    });
    expect(result.message).toContain('CPU.v:449');
    expect(JSON.stringify(result)).not.toMatch(/SECRET|--private/);
  });

  it('preserves the same Icarus compile diagnosis on the P7 probe branch', async () => {
    vi.mocked(getProfile).mockReturnValue('P7');
    const probe = { version: 1, logBase: 0x2800, recordWords: 8, scenarios: [{ id: 1, kind: 'ri' }] };
    const currentCase = makeAsmCase({ p7: { probe } as never });
    vi.mocked(createAsmCaseFromAsm).mockResolvedValueOnce(currentCase);
    vi.mocked(runVerilogSimulation).mockResolvedValueOnce({
      backend: 'iverilog',
      compileResult: {
        ok: false,
        exitCode: 26,
        commandLine: '',
        cwd: 'E:/work/.co/isim',
        stdout: '',
        stderr: 'E:/work/CPU.v:500: error: Unable to bind `M_RD2_from_W`',
        timedOut: false,
        stopped: false
      }
    } as never);

    const result = await runCourseTraceCase(
      services(),
      { asm: URI.file('E:/work/src/test.asm') },
      { source: { kind: 'generator' } }
    );

    expect(result).toMatchObject({
      stage: 'dut',
      dutBackend: 'iverilog',
      dutFailure: {
        phase: 'compile',
        diagnostic: { file: 'CPU.v', line: 500 }
      }
    });
    expect(executeWithPreflight).not.toHaveBeenCalled();
  });

  it('reports two empty writeback traces as indeterminate instead of blaming one side', async () => {
    vi.mocked(compareTraceIterables).mockReturnValueOnce({
      matched: true,
      firstDiffIndex: -1,
      summary: { oracleEvents: 0, dutEvents: 0, matchedEvents: 0, diffEvents: 0 }
    } as never);

    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result.status).toBe('error');
    expect(result.stage).toBe('compare');
    expect(result.message).toContain('无法判定 CPU 是否实际执行');
  });

  it('reports a one-sided empty trace as an asymmetric observation failure', async () => {
    vi.mocked(compareTraceIterables).mockReturnValueOnce({
      matched: false,
      firstDiffIndex: 0,
      summary: { oracleEvents: 1, dutEvents: 0, matchedEvents: 0, diffEvents: 1 }
    } as never);

    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result.status).toBe('error');
    expect(result.message).toContain('仅有一端');
  });

  it('passes P7 interrupt and probe metadata from the case manifest into ISim', async () => {
    const probe = { version: 1, logBase: 0x3000, recordWords: 4, scenarios: [{ id: 's0', kind: 'mmio' }] };
    const currentCase = makeAsmCase({ p7: { interruptSchedule: [0x4180], probe } as never });
    vi.mocked(createAsmCaseFromAsm).mockResolvedValueOnce(currentCase);

    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result.stage).toBe('probe');
    expect(runVerilogSimulation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      asmCase: currentCase,
      p7Probe: probe,
      tclText: 'run 4195us;\nexit\n'
    }));
    expect(checkP7Probe).toHaveBeenCalled();
    expect(executeWithPreflight).not.toHaveBeenCalled();
  });

  it.each(['mars', 'verify-both'] as const)(
    'runs an automatic P7 probe as builtin/DUT-only when the workspace engine is %s',
    async (configuredEngine) => {
      vi.mocked(getProfile).mockReturnValue('P7');
      vi.mocked(getMipsEngine).mockReturnValue(configuredEngine);
      const probe = { version: 1, logBase: 0x2800, recordWords: 8, scenarios: [{ id: 1, kind: 'ri' }] };
      const currentCase = makeAsmCase({ p7: { probe } as never });

      const result = await runCourseTraceCase(
        services(),
        { asm: URI.file('E:/work/src/test.asm'), asmCase: currentCase },
        { source: { kind: 'generator' } }
      );

      expect(result.stage).toBe('probe');
      expect(prepareAsmCaseMachineCode).toHaveBeenCalledWith(
        expect.anything(),
        currentCase,
        expect.objectContaining({
          enginePlan: expect.objectContaining({ mode: 'builtin', primaryEngineId: 'builtin-ts' })
        })
      );
      expect(verifyConfiguredFixedMarsReference).not.toHaveBeenCalled();
      expect(executeWithPreflight).not.toHaveBeenCalled();
      expect(runVerilogSimulation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        p7Probe: probe,
        nonInteractive: true
      }));
    }
  );

  it('passes a private execution-budget-derived TCL window to automatic ISim', async () => {
    const result = await runCourseTraceCase(
      services(),
      { asm: URI.file('E:/work/src/test.asm') },
      { source: { kind: 'generator' } }
    );

    expect(result.status).toBe('passed');
    expect(runVerilogSimulation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tclText: 'run 4195us;\nexit\n',
      nonInteractive: true
    }));
  });

  it.each(['mars', 'verify-both'] as const)(
    'keeps every generated case on the private builtin stack when the workspace engine is %s',
    async (configuredEngine) => {
      vi.mocked(getMipsEngine).mockReturnValue(configuredEngine);

      const result = await runCourseTraceCase(
        services(),
        { asm: URI.file('E:/work/src/test.asm') },
        { source: { kind: 'generator' } }
      );

      expect(result.status).toBe('passed');
      expect(prepareAsmCaseMachineCode).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          nonInteractive: true,
          enginePlan: expect.objectContaining({ mode: 'builtin', primaryEngineId: 'builtin-ts' })
        })
      );
      expect(executeWithPreflight).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ nonInteractive: true }),
        expect.objectContaining({ mode: 'builtin', primaryEngineId: 'builtin-ts' })
      );
      expect(verifyConfiguredFixedMarsReference).not.toHaveBeenCalled();
      expect(runFullStackShadow).not.toHaveBeenCalled();
    }
  );

  it('preserves verify-both full-stack validation for a manual case', async () => {
    vi.mocked(getMipsEngine).mockReturnValue('verify-both');
    vi.mocked(verifyConfiguredFixedMarsReference).mockResolvedValueOnce({
      ok: true,
      identity: { sha256: 'a'.repeat(64) }
    } as never);
    vi.mocked(runFullStackShadow).mockResolvedValueOnce({
      evidenceKind: 'full-stack',
      status: 'matched',
      message: 'matched',
      bundleDir: 'E:/work/shadow',
      resultFile: 'E:/work/shadow/full-stack-result.json',
      assembly: {
        matched: true,
        builtinWords: 3,
        legacyWords: 3,
        disposition: 'matched',
        message: 'matched'
      }
    } as never);

    const result = await runCourseTraceCase(
      services(),
      { asm: URI.file('E:/work/src/test.asm') }
    );

    expect(result.status).toBe('passed');
    expect(runFullStackShadow).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        expectedLegacySha256: 'a'.repeat(64),
        nonInteractive: undefined
      })
    );
  });
});
