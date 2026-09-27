// @index hazard — 内置流水线冲突分析命令的惰性加载入口
import * as vscode from 'vscode';
import { Commands } from './constants';
import type { AppServices } from './types';
import type { HazardWorkflow } from './hazardUi/workflow';

export function registerHazard(context: vscode.ExtensionContext, services: AppServices): void {
  let workflow: Promise<HazardWorkflow> | undefined;
  let disposed = false;
  const getWorkflow = (): Promise<HazardWorkflow> => workflow ??= import('./hazardUi/workflow').then(({ HazardWorkflow }) => {
    const instance = new HazardWorkflow(services);
    if (disposed) instance.dispose();
    return instance;
  });
  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.Hazard.AnalyzeCurrentMachineCode, async (uri?: vscode.Uri) => (await getWorkflow()).analyze(uri)),
    vscode.commands.registerCommand(Commands.Hazard.OpenReport, async (uri?: vscode.Uri) => (await getWorkflow()).openReport(uri)),
    { dispose: () => { disposed = true; void workflow?.then((instance) => instance.dispose()); } }
  );
}
