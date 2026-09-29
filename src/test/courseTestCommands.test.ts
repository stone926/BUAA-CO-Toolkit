import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerCourseTest } from '../courseTest';
import { Commands } from '../constants';
import { requestContinuousTestsStop, startContinuousGeneratedTraceTests } from '../courseTestContinuous';
import { listAsmCaseManifests } from '../asmCaseStore';
import { resolveP3LogisimTraceSetup } from '../courseTestLogisim';
import { runCourseTraceCase } from '../courseTesting/traceRunner';
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
vi.mock('../asmCaseStore', () => ({ listAsmCaseManifests: vi.fn(async () => []) }));
vi.mock('../courseTestLogisim', () => ({ resolveP3LogisimTraceSetup: vi.fn() }));
vi.mock('../courseTesting/traceRunner', () => ({ runCourseTraceCase: vi.fn() }));
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
    expect(listAsmCaseManifests).toHaveBeenCalledOnce();
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'coAsmCaseIndex', '测试历史 / 失败用例', vscode.ViewColumn.Beside, {
        enableScripts: true,
        enableFindWidget: true,
        localResourceRoots: []
      }
    );
    const panel = vi.mocked(vscode.window.createWebviewPanel).mock.results[0].value;
    expect(panel.webview.html).toContain('已保存测试点');
  });
});
