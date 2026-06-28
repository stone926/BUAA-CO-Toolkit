import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import type { AsmCase } from '../../asmCaseStore';
import { runCourseTraceCase } from '../../courseTesting/traceRunner';
import { prepareAsmCaseMachineCode, createAsmCaseFromAsm } from '../../asmCaseStore';
import { runMarsFile } from '../../mips';
import { runIsim } from '../../verilog';
import { readTextFile } from '../../fsUtil';
import { compareTraceIterables } from '../../language/mips/traceCompare';
import { checkP7Probe } from '../../courseTesting/p7ProbeCheck';

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  return createVscodeModuleMock(createVscodeMockState(), vi.fn);
});

vi.mock('../../config', () => ({
  getProfile: vi.fn(() => 'P5')
}));

vi.mock('../../asmCaseStore', () => ({
  asmCaseArtifactUri: vi.fn((_asmCase, kind: string, fileName: string) => URI.file(`E:/work/.co/cases/case-1/${kind}/${fileName}`)),
  copyAsmCaseArtifact: vi.fn(async () => undefined),
  createAsmCaseFromAsm: vi.fn(),
  prepareAsmCaseMachineCode: vi.fn(),
  readAsmCaseManifestForAsm: vi.fn(async () => undefined),
  updateAsmCaseArtifacts: vi.fn(async () => undefined)
}));

vi.mock('../../mips', () => ({
  runMarsFile: vi.fn()
}));

vi.mock('../../verilog', () => ({
  runIsim: vi.fn()
}));

vi.mock('../../fsUtil', () => ({
  readTextFile: vi.fn()
}));

vi.mock('../../language/mips/traceCompare', () => ({
  compareTraceIterables: vi.fn(),
  firstTraceDiffSnapshot: vi.fn(() => ({ index: 0 }))
}));

vi.mock('../../language/mips/traceParser', () => ({
  iterCpuTraceEvents: vi.fn((text: string) => text.split('\n').filter(Boolean))
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
      ...overrides
    }
  };
}

describe('course trace runner orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.splice(0);
    const currentCase = makeAsmCase();
    vi.mocked(createAsmCaseFromAsm).mockImplementation(async () => {
      callOrder.push('create-case');
      return currentCase;
    });
    vi.mocked(prepareAsmCaseMachineCode).mockImplementation(async () => {
      callOrder.push('dump');
      return { result: { ok: true, code: 0, stdout: '', stderr: '' }, outputFile: currentCase.machineCode };
    });
    vi.mocked(runMarsFile).mockImplementation(async () => {
      callOrder.push('mars');
      return { result: { ok: true, code: 0, stdout: '', stderr: '' }, outputFile: URI.file('E:/work/mars.out') };
    });
    vi.mocked(runIsim).mockImplementation(async () => {
      callOrder.push('isim');
      return {
        generated: {} as never,
        fuseResult: { ok: true, code: 0, stdout: '', stderr: '' },
        simResult: { ok: true, code: 0, stdout: '', stderr: '' },
        simOut: URI.file('E:/work/sim.out')
      };
    });
    vi.mocked(readTextFile).mockResolvedValue('trace\n');
    vi.mocked(compareTraceIterables).mockImplementation(() => {
      callOrder.push('compare');
      return {
        matched: true,
        firstDiffIndex: -1,
        summary: { marsEvents: 1, simEvents: 1, matchedEvents: 1, diffEvents: 0 }
      } as never;
    });
    vi.mocked(checkP7Probe).mockReturnValue({ passed: true, failures: [] } as never);
  });

  it('creates a case, dumps machine code, runs Mars and ISim, then compares traces', async () => {
    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result.status).toBe('passed');
    expect(callOrder).toEqual(expect.arrayContaining(['create-case', 'dump', 'mars', 'isim', 'compare']));
    expect(callOrder.indexOf('create-case')).toBeLessThan(callOrder.indexOf('dump'));
    expect(callOrder.indexOf('dump')).toBeLessThan(callOrder.indexOf('mars'));
    expect(callOrder.indexOf('mars')).toBeLessThan(callOrder.indexOf('isim'));
    expect(callOrder.indexOf('isim')).toBeLessThan(callOrder.indexOf('compare'));
  });

  it('stops after a failed dump without running Mars or ISim', async () => {
    vi.mocked(prepareAsmCaseMachineCode).mockResolvedValueOnce({ result: { ok: false, code: 1, stdout: '', stderr: 'bad' } } as never);

    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result.status).toBe('error');
    expect(result.stage).toBe('dump');
    expect(runMarsFile).not.toHaveBeenCalled();
    expect(runIsim).not.toHaveBeenCalled();
  });

  it('returns an ISim-stage failure with case metadata and prior Mars output', async () => {
    vi.mocked(runIsim).mockResolvedValueOnce({
      generated: {} as never,
      fuseResult: { ok: true, code: 0, stdout: '', stderr: '' },
      simResult: { ok: false, code: 1, stdout: '', stderr: 'bad' }
    } as never);

    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result.status).toBe('error');
    expect(result.stage).toBe('isim');
    expect(result.caseId).toBe('case-1');
    expect(result.machineCode).toContain('code.txt');
    expect(result.marsOut).toContain('mars.out');
  });

  it('passes P7 interrupt and probe metadata from the case manifest into ISim', async () => {
    const probe = { version: 1, logBase: 0x3000, recordWords: 4, scenarios: [{ id: 's0', kind: 'mmio' }] };
    const currentCase = makeAsmCase({ p7: { interruptSchedule: [0x4180], probe } as never });
    vi.mocked(createAsmCaseFromAsm).mockResolvedValueOnce(currentCase);

    const result = await runCourseTraceCase(services(), { asm: URI.file('E:/work/src/test.asm') });

    expect(result.stage).toBe('probe');
    expect(runIsim).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      asmCase: currentCase,
      p7Probe: probe
    }));
    expect(checkP7Probe).toHaveBeenCalled();
    expect(runMarsFile).not.toHaveBeenCalled();
  });
});
