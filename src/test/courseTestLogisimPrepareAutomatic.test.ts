import { beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import { createTestServices as services } from './helpers/appServices';

const mocks = vi.hoisted(() => ({
  copyArtifact: vi.fn(async () => undefined),
  createCase: vi.fn(),
  ensureDirectory: vi.fn(async () => undefined),
  findRomTargets: vi.fn(),
  getMipsEngine: vi.fn(() => 'mars'),
  injectMachineCode: vi.fn(),
  prepareMachineCode: vi.fn(),
  readTextFile: vi.fn(),
  resolveWorkspaceFile: vi.fn(),
  revealOutput: vi.fn(),
  showReport: vi.fn(),
  writeTextFile: vi.fn<typeof import('../fsUtil').writeTextFile>(async () => undefined)
}));

vi.mock('vscode', () => ({
  Uri: URI,
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn()
  },
  workspace: { saveAll: vi.fn(async () => true) }
}));

vi.mock('../config', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config')>(),
  getMipsEngine: mocks.getMipsEngine
}));

vi.mock('../workflowInputs', () => ({ resolveWorkspaceFile: mocks.resolveWorkspaceFile }));

vi.mock('../fsUtil', () => ({
  ensureDirectory: mocks.ensureDirectory,
  readTextFile: mocks.readTextFile,
  workspaceFolderFor: vi.fn(() => ({ uri: URI.file('E:/workspace') })),
  workspaceFolderForOrFirst: vi.fn(() => ({ uri: URI.file('E:/workspace') })),
  writeTextFile: mocks.writeTextFile
}));

vi.mock('../process', () => ({
  commandLine: vi.fn(),
  revealOutputChannel: mocks.revealOutput
}));

vi.mock('../language/logisim/rom', () => ({
  findLogisimRomTargets: mocks.findRomTargets,
  injectMachineCodeIntoLogisimRom: mocks.injectMachineCode,
  parseMachineCodeWords: vi.fn(() => [0])
}));

vi.mock('../asmCaseStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../asmCaseStore')>(),
  copyAsmCaseArtifact: mocks.copyArtifact,
  createAsmCaseFromAsm: mocks.createCase,
  prepareAsmCaseMachineCode: mocks.prepareMachineCode
}));

vi.mock('../courseTestReport', async (importOriginal) => ({
  ...await importOriginal<typeof import('../courseTestReport')>(),
  showLogisimPrepareReport: mocks.showReport
}));

import { runLogisimPrepareBatch } from '../courseTestLogisim';

const asm = URI.file('E:/SECRET_PROJECT/generated.asm');
const circuit = URI.file('E:/SECRET_PROJECT/cpu.circ');
const asmCase = {
  id: 'case-1',
  dir: URI.file('E:/workspace/.co/cases/case-1'),
  manifestUri: URI.file('E:/workspace/.co/cases/case-1/case.json'),
  asm: URI.file('E:/workspace/.co/cases/case-1/program.asm'),
  sourceAsm: URI.file('E:/workspace/.co/cases/case-1/source/main.asm'),
  machineCode: URI.file('E:/workspace/.co/cases/case-1/code.txt'),
  manifest: { version: 2, source: { kind: 'builtin' } }
};

describe('generated Logisim prepare compatibility boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWorkspaceFile.mockResolvedValue(circuit);
    mocks.findRomTargets.mockReturnValue([{ index: 0, dataWidth: 32, addrWidth: 12 }]);
    mocks.readTextFile.mockImplementation(async (uri: URI) => (
      uri.fsPath.endsWith('.circ') ? '<circuit />' : '00000000\n'
    ));
    mocks.createCase.mockResolvedValue(asmCase);
    mocks.prepareMachineCode.mockResolvedValue({ ok: true, outputFile: asmCase.machineCode });
    mocks.injectMachineCode.mockReturnValue({ text: '<prepared />', wordCount: 1 });
    mocks.getMipsEngine.mockReturnValue('mars');
  });

  it('pins generated preparation to builtin, stays quiet, and skips the detailed path report', async () => {
    const owner = services();
    await runLogisimPrepareBatch(
      owner,
      [{ asm }],
      { kind: 'generator', commandLine: 'SECRET_COMMAND --count 4094', cwd: 'E:/SECRET_PROJECT' }
    );

    expect(mocks.createCase).toHaveBeenCalledWith(asm, expect.objectContaining({
      enginePlan: expect.objectContaining({ mode: 'builtin', primaryEngineId: 'builtin-ts' })
    }));
    expect(mocks.prepareMachineCode).toHaveBeenCalledWith(
      owner,
      asmCase,
      expect.objectContaining({
        enginePlan: expect.objectContaining({ mode: 'builtin', primaryEngineId: 'builtin-ts' }),
        nonInteractive: true
      })
    );
    expect(mocks.getMipsEngine).not.toHaveBeenCalled();
    expect(mocks.revealOutput).not.toHaveBeenCalled();
    expect(mocks.showReport).not.toHaveBeenCalled();
    expect(mocks.writeTextFile.mock.calls.some(([uri]) => uri.fsPath.includes('report'))).toBe(false);
    expect(JSON.stringify(owner.output.appendLine.mock.calls)).not.toContain('SECRET_PROJECT');
    expect(JSON.stringify(owner.output.appendLine.mock.calls)).not.toContain('SECRET_COMMAND');
  });

  it('preserves workspace engine selection and the detailed report for manual preparation', async () => {
    await runLogisimPrepareBatch(services(), [{ asm }], { kind: 'selected', asmFiles: [asm.fsPath] });

    expect(mocks.getMipsEngine).toHaveBeenCalledWith(asm);
    expect(mocks.prepareMachineCode).toHaveBeenCalledWith(
      expect.anything(),
      asmCase,
      expect.objectContaining({
        enginePlan: expect.objectContaining({ mode: 'mars', primaryEngineId: 'legacy-mars-configured' }),
        nonInteractive: false
      })
    );
    expect(mocks.revealOutput).toHaveBeenCalled();
    expect(mocks.showReport).toHaveBeenCalled();
  });
});
