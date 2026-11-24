import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerCourseTest } from '../courseTest';
import { Commands } from '../constants';
import { requestContinuousTestsStop, startContinuousGeneratedTraceTests } from '../courseTestContinuous';
import { openAsmCaseIndex } from '../courseTestHistory';
import { resolveP3LogisimTraceSetup } from '../courseTestLogisim';
import { runCourseTraceCase } from '../courseTesting/traceRunner';
import { requestUserAsmTestsStop, runUserAsmTests } from '../courseTestUserAsm';
import { createTestServices } from './helpers/appServices';

vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('./helpers/vscodeMock');
  return createVscodeModuleMock(createVscodeMockState(), vi.fn);
});
vi.mock('../config', () => ({ getProfile: vi.fn(() => 'P3') }));
vi.mock('../courseTestContinuous', () => ({
  requestContinuousTestsStop: vi.fn(() => 'none'),
  startContinuousGeneratedTraceTests: vi.fn()
}));
vi.mock('../courseTestHistory', () => ({ openAsmCaseIndex: vi.fn() }));
vi.mock('../courseTestLogisim', () => ({ resolveP3LogisimTraceSetup: vi.fn() }));
vi.mock('../courseTesting/traceRunner', () => ({ runCourseTraceCase: vi.fn() }));
vi.mock('../courseTestUserAsm', () => ({ requestUserAsmTestsStop: vi.fn(() => false), runUserAsmTests: vi.fn() }));
vi.mock('../courseTesting/generatorWorkflow', () => ({
  resolveGeneratorRunSetup: vi.fn(),
  generatorFolder: vi.fn(),
  generatorResource: vi.fn(),
  runGeneratorAndCollectAsms: vi.fn()
}));

function register() {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  vi.mocked(vscode.commands.registerCommand).mockImplementation((command, callback) => {
    commands.set(command, callback);
    return { dispose() {} };
  });
  const services = createTestServices();
  registerCourseTest({ subscriptions: [] } as unknown as vscode.ExtensionContext, services);
  return { commands, services };
}

describe('public course-test commands', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts continuous testing through the retained pipeline and resolves P3 setup without a picker', async () => {
    const { commands, services } = register();
    expect([...commands.keys()]).toEqual([
      Commands.Test.RunAsmTests,
      Commands.Test.StartContinuousGeneratedTraceTests,
      Commands.Test.StopContinuousTests,
      Commands.Test.OpenAsmCaseIndex
    ]);
    await commands.get(Commands.Test.StartContinuousGeneratedTraceTests)!();
    const [actualServices, dependencies] = vi.mocked(startContinuousGeneratedTraceTests).mock.calls[0];
    expect(actualServices).toBe(services);
    expect(dependencies.runCourseTraceCase).toBe(runCourseTraceCase);
    const resource = vscode.Uri.file('E:/课程 workspace/case.asm');
    await dependencies.resolveCourseTraceRunOptions(services, resource, { source: { kind: 'generator' } });
    expect(resolveP3LogisimTraceSetup).toHaveBeenCalledWith(services, resource, { nonInteractive: true });
  });

  it('stops through the continuous controller and opens the saved-case history', async () => {
    const { commands } = register();
    await commands.get(Commands.Test.StopContinuousTests)!();
    expect(requestContinuousTestsStop).toHaveBeenCalledOnce();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('当前没有正在运行的持续测试');

    await commands.get(Commands.Test.OpenAsmCaseIndex)!();
    expect(openAsmCaseIndex).toHaveBeenCalledOnce();
  });

  it('routes selected ASM and CPU arguments and stops the user batch through its controller', async () => {
    const { commands, services } = register();
    const asm = vscode.Uri.file('D:/user sources/test.asm');
    const cpu = vscode.Uri.file('E:/CPU/rtl/mips.v');
    await commands.get(Commands.Test.RunAsmTests)!(asm, cpu);
    expect(runUserAsmTests).toHaveBeenCalledWith(services, asm, cpu);
    vi.mocked(requestUserAsmTestsStop).mockReturnValueOnce(true);
    await commands.get(Commands.Test.StopContinuousTests)!();
    expect(requestContinuousTestsStop).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('已请求停止用户汇编测试');
  });

  it('does not treat Explorer selected-resource arrays as an explicit CPU argument', async () => {
    const { commands, services } = register();
    const asm = vscode.Uri.file('D:/user sources/test.asm');
    await commands.get(Commands.Test.RunAsmTests)!(asm, [asm]);
    expect(runUserAsmTests).toHaveBeenCalledWith(services, asm, undefined);
  });
});
