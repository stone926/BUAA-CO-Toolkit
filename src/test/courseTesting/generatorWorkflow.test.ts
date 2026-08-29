import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import {
  resolveGeneratedAsmBatch,
  resolveGeneratorRunSetup,
  runGeneratorAndCollectAsms,
  type BuiltinGeneratorRunSetup
} from '../../courseTesting/generatorWorkflow';
import { createAsmCaseFromText, updateAsmCaseMetadata } from '../../asmCaseStore';
import {
  BuiltinAsmGeneratorError,
  generateBuiltinAsmTestCase
} from '../../courseTesting/builtinAsmGenerator';

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  const state = createVscodeMockState();
  return { ...createVscodeModuleMock(state, vi.fn), __state: state };
});

vi.mock('../../config', () => ({
  resolvePython: vi.fn(async () => 'python'),
  getJava: vi.fn(() => 'java'),
  getGeneratorArgs: vi.fn(() => []),
  getGeneratedAsmLimit: vi.fn(() => 10),
  ensureConcreteProfile: vi.fn(async () => 'P5'),
  getAutomaticTestInstructions: vi.fn(() => 'addu subu'),
  getMipsEngine: vi.fn(() => 'mars')
}));

vi.mock('../../process', () => ({
  revealOutputChannel: vi.fn(),
  runTool: vi.fn()
}));

vi.mock('../../asmCaseStore', () => ({
  createAsmCaseFromText: vi.fn(),
  updateAsmCaseMetadata: vi.fn(async () => undefined)
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

  it('always resolves the strongest builtin policy even when the workspace rollback is mars', async () => {
    const vscode = await import('vscode') as typeof import('vscode') & {
      __state: {
        activeTextEditor?: { document: { uri: URI } };
        workspaceFolders: Array<{ uri: URI; name?: string }>;
      };
    };
    vscode.__state.workspaceFolders.push({ uri: URI.file('E:/work'), name: 'work' });
    // An active legacy generator file must no longer take over the public automatic command.
    vscode.__state.activeTextEditor = { document: { uri: URI.file('E:/work/legacy-generator.py') } };

    const resolved = await resolveGeneratorRunSetup();

    expect(resolved).toMatchObject({
      kind: 'builtin',
      profile: 'P5',
      instructionText: 'addu subu',
      instructionCount: 4094,
      interrupt: false,
      p7StressMode: 'off'
    });
  });

  it('creates traceable ASM cases and records source artifacts for builtin random output', async () => {
    const batch = await runGeneratorAndCollectAsms(services(), setup(), { revealOutput: false });

    expect(batch?.asmCases).toHaveLength(1);
    expect(batch?.asms[0].fsPath).toContain('builtin-p7-');
    expect(batch?.source).toMatchObject({
      kind: 'generator',
      generator: 'builtin:random-asm'
    });
    expect(batch?.source.cwd.toLowerCase()).toMatch(/[\\/]\.co[\\/]cases$/);
    expect(createAsmCaseFromText).toHaveBeenCalledWith(
      expect.stringMatching(/^builtin-p7-\d{14}-[0-9a-f]{6}\.asm$/),
      '.text\nori $0, $0, 0\n',
      expect.objectContaining({
        resource: URI.file('E:/work/main.asm'),
        source: expect.objectContaining({
          kind: 'builtin',
          generator: 'builtin:random-asm',
          commandLine: expect.stringContaining('builtin-random-asm')
        }),
        enginePlan: expect.objectContaining({
          mode: 'builtin',
          primaryEngineId: 'builtin-ts',
          profile: 'P7'
        }),
        p7: { interruptSchedule: [0x4180], probe: undefined }
      })
    );
    expect(updateAsmCaseMetadata).toHaveBeenCalledWith(expect.anything(), {
      'source.generatedName': expect.stringMatching(/^builtin-p7-/),
      'source.seed': 'seed-1',
      'source.mode': 'anchor'
    });
  });

  it('keeps the public one-shot automatic generator quiet', async () => {
    const vscode = await import('vscode') as typeof import('vscode') & {
      __state: {
        activeTextEditor?: { document: { uri: URI } };
        workspaceFolders: Array<{ uri: URI; name?: string }>;
      };
    };
    const process = await import('../../process');
    vscode.__state.workspaceFolders.splice(0, vscode.__state.workspaceFolders.length, {
      uri: URI.file('E:/work'),
      name: 'work'
    });
    vscode.__state.activeTextEditor = { document: { uri: URI.file('E:/work/main.asm') } };

    const batch = await resolveGeneratedAsmBatch(services(), {
      resolveAsmBatchInputs: vi.fn(async () => [])
    });

    expect(batch?.asmCases).toHaveLength(1);
    expect(process.revealOutputChannel).not.toHaveBeenCalled();
  });

  it('hides internal generator invariants from the automatic surface', async () => {
    const currentServices = services();
    vi.mocked(generateBuiltinAsmTestCase).mockImplementationOnce(() => {
      throw new Error('Internal scenario=timer count=1118 entry=0x4180 E:/SECRET');
    });
    const vscode = await import('vscode');

    const batch = await runGeneratorAndCollectAsms(currentServices, setup(), { revealOutput: false });

    expect(batch).toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      '自动测试点准备失败；请检查 co.test.instructions 后重试'
    );
    expect(JSON.stringify(vi.mocked(currentServices.output.appendLine).mock.calls))
      .not.toMatch(/scenario|1118|0x4180|SECRET/);
  });

  it('keeps the user-owned instruction-set error actionable', async () => {
    const currentServices = services();
    vi.mocked(generateBuiltinAsmTestCase).mockImplementationOnce(() => {
      throw new BuiltinAsmGeneratorError(
        'Invalid built-in ASM generator instruction set: unknown mnemonics: custom_bad_op.'
      );
    });
    const vscode = await import('vscode');

    await runGeneratorAndCollectAsms(currentServices, setup(), { revealOutput: false });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      '自动测试指令集无效：unknown mnemonics: custom_bad_op'
    );
  });

  it('expands strongest hybrid P7 testing into anchor, core probe, and timer probe shards', async () => {
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
        probe: { version: 1, shard: 'core', logBase: 0x3000, recordWords: 4, scenarios: [] }
      } as never)
      .mockReturnValueOnce({
        profile: 'P7',
        mode: 'probe',
        text: 'timer-probe',
        instructionCount: 10,
        instructionSet: ['addu'],
        seed: 'timer-probe-seed',
        interruptSchedule: [],
        probe: { version: 1, shard: 'timer', logBase: 0x3000, recordWords: 4, scenarios: [] }
      } as never);

    const batch = await runGeneratorAndCollectAsms(services(), setup({
      p7StressMode: 'hybrid',
      timerInterrupt: true,
      timerIntensity: 1,
      probeScenarioCount: 64
    }), { revealOutput: false });

    expect(batch?.asmCases).toHaveLength(3);
    expect(generateBuiltinAsmTestCase).toHaveBeenNthCalledWith(1, expect.objectContaining({ p7StressMode: 'anchor' }));
    expect(generateBuiltinAsmTestCase).toHaveBeenNthCalledWith(2, expect.objectContaining({
      p7StressMode: 'probe',
      probeShard: 'core',
      probeScenarioCount: 64,
      exceptionRate: 0
    }));
    expect(generateBuiltinAsmTestCase).toHaveBeenNthCalledWith(3, expect.objectContaining({
      p7StressMode: 'probe',
      probeShard: 'timer',
      probeScenarioCount: 10,
      exceptionRate: 0
    }));
    expect(updateAsmCaseMetadata).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      'source.seed': 'anchor-seed',
      'source.mode': 'anchor'
    }));
    expect(updateAsmCaseMetadata).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      'source.seed': 'probe-seed',
      'source.mode': 'probe',
      'source.probeShard': 'core'
    }));
    expect(updateAsmCaseMetadata).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      'source.seed': 'timer-probe-seed',
      'source.mode': 'probe',
      'source.probeShard': 'timer'
    }));
  });
});
