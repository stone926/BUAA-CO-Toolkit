// @index user-asm-command — 用户汇编文件/目录测试的选择、进度与报告宿主适配
import * as path from 'path';
import * as vscode from 'vscode';
import { Commands, CO_OUT_DIR } from './constants';
import { ensureConcreteProfile } from './config';
import { activeProjectResource } from './configurationResource';
import { asmCaseIndexDirectory } from './asmCaseStore';
import { ensureDirectory, workspaceFolderFor, writeTextFile } from './fsUtil';
import type { AppServices } from './types';
import type { CourseTraceCaseInput } from './courseTestCases';
import { findStdinCandidatesForAsm } from './courseTestStdin';
import { resolveP3LogisimTraceSetup } from './courseTestLogisim';
import { tryAcquireCourseTestSession } from './courseTesting/courseTestSession';
import { acceptsInspectionMessage } from './courseTesting/failureDiagnosis';
import { discoverUserAsmInputs } from './courseTesting/userAsmInputs';
import { createUserAsmBatchReport, runUserAsmBatch, type UserAsmReferenceMode } from './courseTesting/userAsmBatch';
import { renderUserAsmBatchReport } from './courseTesting/userAsmBatchReport';
import { runCourseTraceCase, type CourseTraceRunOptions } from './courseTesting/traceRunner';

let activeUserAsmController: AbortController | undefined;

export function requestUserAsmTestsStop(): boolean {
  if (!activeUserAsmController) return false;
  activeUserAsmController.abort();
  return true;
}

/** ASM input and CPU project are separate command arguments and remain separate through execution. */
export async function runUserAsmTests(services: AppServices, input?: vscode.Uri, cpuResource?: vscode.Uri, referenceMode?: UserAsmReferenceMode): Promise<void> {
  const lease = tryAcquireCourseTestSession();
  if (!lease) {
    void vscode.window.showWarningMessage('已有一个测试任务正在运行');
    return;
  }
  const controller = new AbortController();
  activeUserAsmController = controller;
  try {
    if (referenceMode !== undefined && referenceMode !== 'auto' && referenceMode !== 'mars') throw new Error('参考引擎仅支持 auto 或 mars');
    await vscode.commands.executeCommand('setContext', 'co.continuousTestRunning', true);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '用户汇编 CPU 测试', cancellable: true }, async (_progress, token) => {
      const cancellation = token.onCancellationRequested(() => controller.abort());
      try {
        if (token.isCancellationRequested) controller.abort();
        if (controller.signal.aborted) return;
        // Snapshot the CPU before opening input pickers or report panels changes editor focus.
        const cpu = await resolveCpuResource(cpuResource);
        if (!cpu || controller.signal.aborted) return;
        const folder = workspaceFolderFor(cpu);
        if (!folder) throw new Error('请先打开待测 CPU 所在的工作区');
        const profile = await ensureConcreteProfile(cpu, '用户汇编 CPU 测试需要先确定项目 Profile');
        if (!profile || controller.signal.aborted) return;
        if (!['P3', 'P4', 'P5', 'P6', 'P7'].includes(profile)) throw new Error('用户汇编 CPU 测试支持 P3–P7 项目');
        const selected = input ?? await pickAsmInput(folder.uri);
        if (!selected || controller.signal.aborted) return;
        if (selected.scheme !== 'file') throw new Error('汇编测试仅支持本地文件或目录');
        if (!await vscode.workspace.saveAll(false)) throw new Error('文件未能全部保存，请保存 CPU 与汇编源码后重试');
        if (controller.signal.aborted) return;
        const asms = (await discoverUserAsmInputs(selected.fsPath)).map(file => vscode.Uri.file(file));
        if (controller.signal.aborted) return;
        const cases: CourseTraceCaseInput[] = [];
        for (const asm of asms) {
          const stdins = await findStdinCandidatesForAsm(asm);
          if (stdins.length) cases.push(...stdins.map(stdin => ({ asm, stdin })));
          else cases.push({ asm });
          if (controller.signal.aborted) return;
        }
        const reference = referenceMode ?? await pickReferenceMode();
        if (!reference || controller.signal.aborted) return;
        const baseRunOptions: CourseTraceRunOptions = {
          cpuResource: cpu,
          engineMode: reference,
          sourceRoot: workspaceFolderFor(selected)?.uri ?? vscode.Uri.file(path.dirname(asms[0].fsPath))
        };
        if (profile === 'P3') {
          if (!/\.circ$/i.test(cpu.fsPath)) throw new Error('P3 用户汇编测试需要选择待测 Logisim 电路（.circ）');
          const setup = await resolveP3LogisimTraceSetup(services, cpu, { circuit: cpu });
          if (!setup || controller.signal.aborted) return;
          baseRunOptions.logisim = setup;
        }
        const output = vscode.Uri.file(path.join(folder.uri.fsPath, CO_OUT_DIR));
        await ensureDirectory(output);
        const reportFile = vscode.Uri.file(path.join(output.fsPath, 'user-asm-test-report.json'));
        const report = createUserAsmBatchReport(cpu, selected, cases.length, reference);
        const panel = vscode.window.createWebviewPanel('coUserAsmTestReport', '用户汇编 CPU 测试', vscode.ViewColumn.Active, {
          enableScripts: true, enableFindWidget: true, localResourceRoots: [], retainContextWhenHidden: true
        });
        let disposed = false;
        let openingCase = false;
        const listener = panel.webview.onDidReceiveMessage(async (message: unknown) => {
          if (!message || typeof message !== 'object') return;
          const action = (message as { action?: unknown }).action;
          if (action === 'stop' && report.running) controller.abort();
          if (openingCase) return;
          if (action === 'openHistory' || (acceptsInspectionMessage(message) && report.iteration.results.some(result => result.caseId === message.caseId && !result.artifactsPruned))) {
            openingCase = true;
            try {
              if (acceptsInspectionMessage(message)) {
                const { openCourseTestFailure } = await import('./courseTestFailure');
                await openCourseTestFailure(services, asmCaseIndexDirectory(cpu), message.caseId);
              } else await vscode.commands.executeCommand(Commands.Test.OpenAsmCaseIndex, cpu);
            } catch (error) {
              void vscode.window.showErrorMessage(`无法打开测试记录：${error instanceof Error ? error.message : String(error)}`);
            } finally { openingCase = false; }
          }
        });
        panel.onDidDispose(() => { disposed = true; listener.dispose(); if (report.running) controller.abort(); });
        const updateMonitor = async (): Promise<void> => {
          report.stopRequested = controller.signal.aborted;
          await writeTextFile(reportFile, JSON.stringify(report, null, 2) + '\n');
          if (!disposed) panel.webview.html = renderUserAsmBatchReport(report);
        };
        await updateMonitor();
        services.output.appendLine(`用户汇编 CPU 测试：${cpu.fsPath}；${cases.length} 个测试点`);
        await runUserAsmBatch({ services, cases, cpuResource: cpu, report, signal: controller.signal, baseRunOptions, run: runCourseTraceCase, updateMonitor });
      } finally { cancellation.dispose(); }
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = `用户汇编测试失败：${error instanceof Error ? error.message : String(error)}`;
      services.output.appendLine(message);
      void vscode.window.showErrorMessage(message);
    }
  } finally {
    // Clear the toolbar only after every in-flight run and report write has drained.
    try { await vscode.commands.executeCommand('setContext', 'co.continuousTestRunning', false); }
    finally { if (activeUserAsmController === controller) activeUserAsmController = undefined; lease.release(); }
  }
}

async function resolveCpuResource(explicit?: vscode.Uri): Promise<vscode.Uri | undefined> {
  const isCpu = (uri: vscode.Uri | undefined): uri is vscode.Uri => uri?.scheme === 'file' && /\.(?:v|vh|circ)$/i.test(uri.fsPath);
  if (explicit) {
    if (!isCpu(explicit)) throw new Error('CPU 工程入口必须是 Verilog 文件或 Logisim 电路');
    return explicit;
  }
  const active = activeProjectResource();
  if (isCpu(active)) return active;
  const visible = vscode.window.visibleTextEditors.map(editor => editor.document.uri).find(isCpu);
  if (visible) return visible;
  const picked = await vscode.window.showOpenDialog({
    title: '选择待测 CPU 的 Verilog 入口或 Logisim 电路', canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
    filters: { 'CPU 入口': ['v', 'vh', 'circ'] }
  });
  return picked?.[0];
}

async function pickAsmInput(defaultUri: vscode.Uri): Promise<vscode.Uri | undefined> {
  const kind = await vscode.window.showQuickPick([
    { label: '单个汇编文件', directory: false, description: '.asm / .s / .mips' },
    { label: '汇编目录', directory: true, description: '按文件名顺序测试直属汇编文件，不递归' }
  ], { title: '选择用户汇编测试输入' });
  if (!kind) return undefined;
  const picked = await vscode.window.showOpenDialog({
    title: kind.directory ? '选择汇编目录（不递归）' : '选择汇编文件', defaultUri,
    canSelectFiles: !kind.directory, canSelectFolders: kind.directory, canSelectMany: false,
    ...(!kind.directory ? { filters: { 'MIPS 汇编': ['asm', 's', 'mips'] } } : {})
  });
  return picked?.[0];
}

async function pickReferenceMode(): Promise<UserAsmReferenceMode | undefined> {
  const picked = await vscode.window.showQuickPick([
    { label: '自动选择（推荐）', description: '优先内置引擎；未知指令交给自定义 Mars', reference: 'auto' as const },
    { label: '自定义 Mars', description: '始终按你的 Mars 和 .class 定义执行，适合修改已有指令语义', reference: 'mars' as const }
  ], { title: '选择本次测试的参考引擎' });
  return picked?.reference;
}
