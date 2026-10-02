// @index course-testing — 失败页宿主：受控导航、取消与重跑结果衔接
import * as path from 'path';
import * as vscode from 'vscode';
import { recordAsmCaseTestOutcome } from './asmCaseStore';
import { Commands } from './constants';
import { getProfile } from './config';
import { renderCourseTestFailure, type CourseFailureView } from './courseTestFailureReport';
import { publicAutomaticDiagnosticMessage, neutralCourseTraceStage } from './courseTestReport';
import { loadCaseInspection, loadCaseWaveform, findSourceAtPc, type CaseInspection, type CaseSourceLocation } from './courseTesting/caseInspection';
import { failureFocus, recordedTestStatus } from './courseTesting/failureDiagnosis';
import { parseFailureEvidence, serializeFailureEvidence } from './courseTesting/failureEvidence';
import { rerunCourseTestCase } from './courseTesting/caseRerun';
import { tryAcquireCourseTestSession } from './courseTesting/courseTestSession';
import { isManifestV2, manifestP7Of } from './courseTesting/manifestCodec';
import { probeScopeFromCase, specialTimerExlNotice } from './courseTesting/p7ProbeScope';
import { normalizePathKey } from './pathUtils';
import type { AppServices } from './types';

const openCases = new Map<string, vscode.WebviewPanel>();

export async function openCourseTestFailure(services: AppServices, directory: string, caseId: string): Promise<void> {
  const keyFor = (id: string) => normalizePathKey(path.join(directory, id));
  const existing = openCases.get(keyFor(caseId));
  if (existing) { existing.reveal(); return; }
  let inspection = await loadCaseInspection(directory, caseId);
  // Another report can have opened this case while the bounded read was pending.
  const opened = openCases.get(keyFor(caseId));
  if (opened) { opened.reveal(); return; }
  const panel = vscode.window.createWebviewPanel('coTestFailure', '用例排查', vscode.ViewColumn.Beside, {
    enableScripts: true, enableFindWidget: true, localResourceRoots: [], retainContextWhenHidden: true
  });
  let key = keyFor(caseId);
  openCases.set(key, panel);
  let disposed = false;
  let busy = false;
  let actionMessage: string | undefined;
  let previousCaseId = isManifestV2(inspection.asmCase.manifest) ? inspection.asmCase.manifest.metadata?.['rerun.originalCaseId'] : undefined;
  let waveform: vscode.Uri | undefined;
  let controller: AbortController | undefined;
  let locations: Array<CaseSourceLocation | undefined> = [];

  const render = () => {
    if (disposed) return;
    const { view, sources } = inspectionView(inspection);
    locations = sources;
    const savedWaveform = isManifestV2(inspection.asmCase.manifest) && !!inspection.asmCase.manifest.artifacts?.dut?.['verilog/waveform'];
    panel.webview.html = renderCourseTestFailure({ ...view, busy, actionMessage, previousCaseId, waveformAvailable: !!waveform || savedWaveform });
  };

  const rerun = async (withWaveform: boolean) => {
    const view = inspectionView(inspection).view;
    if (!view.canRerun || withWaveform && !view.canWaveform) return;
    const lease = tryAcquireCourseTestSession();
    if (!lease) {
      actionMessage = '已有测试正在运行，请先停止持续测试或等待当前重跑结束。';
      render(); return;
    }
    busy = true;
    controller = new AbortController();
    actionMessage = undefined;
    render();
    try {
      if (!await vscode.workspace.saveAll(false)) throw new Error('部分文件未能保存，请保存 CPU 源码后重试。');
      if (disposed || controller.signal.aborted) return;
      // Reload before executing: a visible report never grants access to stale or changed snapshots.
      const original = await loadCaseInspection(directory, inspection.asmCase.id);
      const outcome = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: withWaveform ? '重跑用例并生成波形' : '重跑此用例', cancellable: true
      }, async (_progress, token) => {
        const cancel = token.onCancellationRequested(() => controller?.abort());
        if (token.isCancellationRequested) controller?.abort();
        try { return await rerunCourseTestCase(services, original.asmCase, { waveform: withWaveform, signal: controller!.signal }); }
        finally { cancel.dispose(); }
      });
      if (outcome.result.cancelled) {
        actionMessage = '重跑已取消，没有形成新的通过或失败判定。';
        return;
      }
      if (!outcome.result.caseId || !outcome.result.caseManifest) {
        actionMessage = outcome.result.message;
        return;
      }
      await recordAsmCaseTestOutcome(outcome.result.caseManifest, {
        status: outcome.result.status, stage: neutralCourseTraceStage(outcome.result.stage),
        diagnostic: publicAutomaticDiagnosticMessage(outcome.result), evidence: serializeFailureEvidence(outcome.result)
      });
      const next = await loadCaseInspection(directory, outcome.result.caseId);
      if (disposed) return;
      previousCaseId = original.asmCase.id;
      openCases.delete(key);
      key = keyFor(next.asmCase.id);
      openCases.set(key, panel);
      inspection = next;
      waveform = outcome.waveform;
      actionMessage = outcome.waveformIssue ?? (outcome.result.status === 'passed'
        ? '此用例已通过。原始失败记录已保留，可继续持续测试。' : '重跑完成，以下显示本次结果。');
      if (waveform) await vscode.commands.executeCommand(Commands.Waveform.OpenFile, waveform);
    } finally {
      controller = undefined;
      busy = false;
      lease.release();
      render();
    }
  };

  const listener = panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (disposed || busy || !message || typeof message !== 'object') return;
    const { action, index } = message as { action?: unknown; index?: unknown };
    const selected = typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : undefined;
    try {
      switch (action) {
        case 'source': {
          if (selected === undefined) return;
          const location = locations[selected];
          if (location) await revealText(location.uri, location.line);
          return;
        }
        case 'program':
          if (inspection.sourceAvailable) await revealText(inspection.asmCase.sourceAsm);
          return;
        case 'compare':
          if (inspection.oracle && inspection.dut) {
            const evidence = parseFailureEvidence(isManifestV2(inspection.asmCase.manifest) ? inspection.asmCase.manifest.metadata?.['test.evidence'] : undefined);
            await vscode.commands.executeCommand('vscode.diff', inspection.oracle.uri, inspection.dut.uri, '参考写回 ↔ 待测 CPU 写回', {
              viewColumn: vscode.ViewColumn.Beside, preview: true,
              ...(evidence?.dut ? { selection: new vscode.Range(evidence.dut.lineNumber - 1, 0, evidence.dut.lineNumber - 1, 0) } : {})
            });
          }
          return;
        case 'dut':
          if (inspection.dut) await revealText(inspection.dut.uri);
          return;
        case 'log':
          if (selected !== undefined && inspection.logs[selected]) await revealText(inspection.logs[selected].uri);
          return;
        case 'hazard':
          if (inspectionView(inspection).view.canHazard) await vscode.commands.executeCommand(Commands.Hazard.AnalyzeCurrentMachineCode, inspection.asmCase.sourceAsm);
          return;
        case 'history':
          await vscode.commands.executeCommand(Commands.Test.OpenAsmCaseIndex, inspection.asmCase.asm);
          return;
        case 'openWaveform':
          waveform = await loadCaseWaveform(inspection);
          if (waveform) await vscode.commands.executeCommand(Commands.Waveform.OpenFile, waveform);
          else { actionMessage = '没有可验证的已保存波形，请重跑并生成波形。'; render(); }
          return;
        case 'rerun': await rerun(false); return;
        case 'waveform': await rerun(true); return;
      }
    } catch (error) {
      actionMessage = error instanceof Error ? error.message : String(error);
      services.output.appendLine(`用例排查：${actionMessage}`);
      render();
    }
  });
  panel.onDidDispose(() => {
    disposed = true;
    controller?.abort();
    if (openCases.get(key) === panel) openCases.delete(key);
    listener.dispose();
  });
  render();
}

function inspectionView(inspection: CaseInspection): { view: CourseFailureView; sources: Array<CaseSourceLocation | undefined> } {
  const manifest = inspection.asmCase.manifest;
  const metadata = isManifestV2(manifest) ? manifest.metadata : undefined;
  const evidence = parseFailureEvidence(metadata?.['test.evidence']);
  const probe = manifestP7Of(manifest)?.probe;
  const focus = failureFocus(evidence, probe);
  const sources = focus.map(target => findSourceAtPc(inspection, target.pc));
  const status = recordedTestStatus(metadata);
  const canRerun = isManifestV2(manifest) && inspection.sourceAvailable;
  const canWaveform = canRerun && /^P[4-7]$/.test(manifest.profile);
  return {
    sources,
    view: {
      caseId: manifest.caseId, profile: manifest.profile, status,
      diagnostic: metadata?.['test.diagnostic']?.slice(0, 4096) ?? '此历史记录未保存具体诊断。', evidence,
      ...(probeScopeFromCase(probe, metadata) === 'special-timer-exl' ? { scopeNotice: specialTimerExlNotice } : {}),
      targets: focus.map((target, index) => ({ ...target, ...(sources[index] ? { line: sources[index]!.line, text: sources[index]!.text } : {}) })),
      sourceAvailable: inspection.sourceAvailable,
      compareAvailable: !!inspection.oracle && !!inspection.dut,
      dutAvailable: !!inspection.dut, logs: inspection.logs.map(log => log.label),
      canRerun, canWaveform,
      canHazard: inspection.sourceAvailable && /^P[5-7]$/.test(manifest.profile) && !probe
        && !manifestP7Of(manifest)?.interruptSchedule?.length && getProfile(inspection.asmCase.asm) === manifest.profile,
      warnings: [...inspection.warnings, ...(!evidence && status === 'failed' ? ['此记录没有保存首差异定位信息，可查看完整汇编和写回记录，或重跑补充证据。'] : [])]
    }
  };
}

async function revealText(uri: vscode.Uri, line?: number): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const row = Math.min(document.lineCount - 1, Math.max(0, (line ?? 1) - 1));
  await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Beside, preview: true,
    selection: new vscode.Range(row, 0, row, 0)
  });
}
