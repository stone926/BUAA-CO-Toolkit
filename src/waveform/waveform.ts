// @index waveform-register — 波形功能注册入口：VCD 自定义编辑器、“仿真并查看波形”与“打开波形文件”命令、快捷键命令转发、源码跳转接线

import * as vscode from 'vscode';
import { Commands } from '../constants';
import type { MutableVerilogModuleProvider } from '../language/verilog/moduleProvider';
import type { AppServices } from '../types';
import { openWaveformEditor, WaveformEditorProvider } from './host/waveformEditorProvider';
import { simulateAndShowWaveform } from './host/waveformSimulation';
import { locateWaveformSource, revealSourceLocation } from './host/waveformSourceLocator';
import { WaveformViewStateStore } from './host/waveformViewStateStore';
import type { WaveformShortcut } from './model/protocol';

/** Extension keybindings (package.json, scoped to the waveform editor) and the page action each one runs. */
const shortcutCommands: ReadonlyArray<readonly [string, WaveformShortcut]> = [
  [Commands.Waveform.GoToTime, 'goToTime'],
  [Commands.Waveform.ShowHelp, 'showHelp'],
  [Commands.Waveform.SelectAllRows, 'selectAllRows']
];

export function registerWaveform(
  context: vscode.ExtensionContext,
  services: AppServices,
  moduleRegistry?: MutableVerilogModuleProvider
): void {
  const { provider, registration } = WaveformEditorProvider.register({
    extensionUri: context.extensionUri,
    stateStore: new WaveformViewStateStore(context.workspaceState),
    openSource: async (dumpUri, signalPath, isScope, column) => {
      const location = await locateWaveformSource(dumpUri, signalPath, isScope, moduleRegistry);
      if (typeof location === 'string') {
        vscode.window.showWarningMessage(location);
        return;
      }
      await revealSourceLocation(location, column);
    }
  });
  const showWaveform = async (dump: vscode.Uri): Promise<void> => {
    provider.reload(dump);
    await openWaveformEditor(dump);
  };
  context.subscriptions.push(
    registration,
    vscode.commands.registerCommand(Commands.Verilog.ViewWaveform, () =>
      simulateAndShowWaveform({ services, moduleRegistry, showWaveform })),
    vscode.commands.registerCommand(Commands.Waveform.OpenFile, (uri?: vscode.Uri) => openWaveformFile(uri)),
    ...shortcutCommands.map(([command, shortcut]) =>
      vscode.commands.registerCommand(command, () => provider.activePanel()?.runShortcut(shortcut)))
  );
}

async function openWaveformFile(uri?: vscode.Uri): Promise<void> {
  const target = uri instanceof vscode.Uri
    ? uri
    : (await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: '打开波形',
        filters: { 'VCD 波形': ['vcd'] }
      }))?.[0];
  if (target) {
    await openWaveformEditor(target);
  }
}
