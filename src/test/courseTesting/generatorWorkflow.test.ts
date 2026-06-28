import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import {
  runGeneratorAndCollectAsms,
  type BuiltinGeneratorRunSetup
} from '../../courseTesting/generatorWorkflow';
import { createAsmCaseFromText, updateAsmCaseArtifacts } from '../../asmCaseStore';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  return createVscodeModuleMock(createVscodeMockState(), vi.fn);
});

vi.mock('../../config', () => ({
  resolvePython: vi.fn(async () => 'python'),
  getJava: vi.fn(() => 'java'),
  getGeneratorArgs: vi.fn(() => []),
  getGeneratedAsmLimit: vi.fn(() => 10)
}));

vi.mock('../../process', () => ({
  revealOutputChannel: vi.fn(),
  runTool: vi.fn()
}));

vi.mock('../../asmCaseStore', () => ({
  createAsmCaseFromText: vi.fn(),
  updateAsmCaseArtifacts: vi.fn(async () => undefined)
}));

vi.mock('../../courseTesting/builtinAsmGenerator', () => ({
  BuiltinAsmGeneratorError: class BuiltinAsmGeneratorError extends Error {},
  generateBuiltinAsmTestCase: vi.fn()
}));

function services() {
  return {
    output: {
      appendLine: vi.fn(),
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

function setup(overrides: Partial<BuiltinGeneratorRunSetup> = {}): BuiltinGeneratorRunSetup {
  return {
    kind: 'builtin',
    folder: { uri: URI.file('E:/work'), name: 'work', index: 0 },
    resource: URI.file('E:/work/main.asm'),
    profile: 'P7',
    instructionText: 'addu subu',
    instructionCount: 20,
    interrupt: true,
    p7StressMode: 'anchor',
    timerInterrupt: false,
    externalInterruptIntensity: 1,
    timerIntensity: 0,
    probeScenarioCount: 1,
    exceptionRate: 0,
    exceptionTypes: [],
    ...overrides
  };
}

describe('builtin generator workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateBuiltinAsmTestCase).mockReturnValue({
      profile: 'P7',
      mode: 'anchor',
      text: '.text\nori $0, $0, 0\n',
      instructionCount: 20,
      instructionSet: ['addu', 'subu'],
      seed: 'seed-1',
      interruptSchedule: [0x4180],
      probe: undefined
    } as never);
    vi.mocked(createAsmCaseFromText).mockImplementation(async (fileName: string) => ({
      id: 'case-1',
      dir: URI.file('E:/work/.co/cases/case-1'),
      manifestUri: URI.file('E:/work/.co/cases/case-1/case.json'),
      asm: URI.file(`E:/work/.co/cases/case-1/${fileName}`),
      sourceAsm: URI.file(`E:/work/.co/cases/case-1/${fileName}`),
      machineCode: URI.file('E:/work/.co/cases/case-1/code.txt'),
      manifest: {
        version: 1,
        caseId: 'case-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        source: { kind: 'builtin' },
        asm: { path: fileName, sha256: 'asm' }
      }
    } as never));
  });

  it('creates traceable ASM cases and records source artifacts for builtin random output', async () => {
    const batch = await runGeneratorAndCollectAsms(services(), setup(), { revealOutput: false });

    expect(batch?.asmCases).toHaveLength(1);
    expect(batch?.asms[0].fsPath).toContain('builtin-p7-anchor-');
    expect(batch?.source).toMatchObject({
      kind: 'generator',
      generator: 'builtin:random-asm'
    });
    expect(batch?.source.cwd.toLowerCase()).toMatch(/[\\/]\.co[\\/]cases$/);
    expect(createAsmCaseFromText).toHaveBeenCalledWith(
      expect.stringMatching(/^builtin-p7-anchor-\d{14}-[0-9a-f]{6}\.asm$/),
      '.text\nori $0, $0, 0\n',
      expect.objectContaining({
        resource: URI.file('E:/work/main.asm'),
        source: expect.objectContaining({
          kind: 'builtin',
          generator: 'builtin:random-asm',
          commandLine: expect.stringContaining('builtin-random-asm')
        }),
        p7: { interruptSchedule: [0x4180], probe: undefined }
      })
    );
    expect(updateAsmCaseArtifacts).toHaveBeenCalledWith(expect.anything(), 'source', expect.objectContaining({
      generatedName: expect.stringMatching(/^builtin-p7-anchor-/),
      seed: 'seed-1',
      mode: 'anchor'
    }));
  });

  it('emits both anchor and probe cases for hybrid P7 stress mode', async () => {
    vi.mocked(generateBuiltinAsmTestCase)
      .mockReturnValueOnce({
        profile: 'P7',
        mode: 'anchor',
        text: 'anchor',
        instructionCount: 10,
        instructionSet: ['addu'],
        seed: 'anchor-seed',
        interruptSchedule: [0x4180],
        probe: undefined
      } as never)
      .mockReturnValueOnce({
        profile: 'P7',
        mode: 'probe',
        text: 'probe',
        instructionCount: 10,
        instructionSet: ['addu'],
        seed: 'probe-seed',
        interruptSchedule: [],
        probe: { version: 1, logBase: 0x3000, recordWords: 4, scenarios: [] }
      } as never);

    const batch = await runGeneratorAndCollectAsms(services(), setup({ p7StressMode: 'hybrid' }), { revealOutput: false });

    expect(batch?.asmCases).toHaveLength(2);
    expect(generateBuiltinAsmTestCase).toHaveBeenNthCalledWith(1, expect.objectContaining({ p7StressMode: 'anchor' }));
    expect(generateBuiltinAsmTestCase).toHaveBeenNthCalledWith(2, expect.objectContaining({ p7StressMode: 'probe', exceptionRate: 0 }));
    expect(updateAsmCaseArtifacts).toHaveBeenCalledWith(expect.anything(), 'source', expect.objectContaining({ seed: 'anchor-seed', mode: 'anchor' }));
    expect(updateAsmCaseArtifacts).toHaveBeenCalledWith(expect.anything(), 'source', expect.objectContaining({ seed: 'probe-seed', mode: 'probe' }));
  });
});
