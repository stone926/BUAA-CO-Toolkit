// @index waveform-provider — VCD 只读自定义编辑器 provider：为每个页签创建 WaveformPanel，按文件追踪打开的页签以便仿真后重载/定位，向活动页签转发快捷键

import * as vscode from 'vscode';
import { WAVEFORM_VIEW_TYPE } from '../../constants';
import { normalizePathKey } from '../../pathUtils';
import { WaveformPanel, WaveformPanelDependencies } from './waveformPanel';

class WaveformDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose(): void {}
}

export class WaveformEditorProvider implements vscode.CustomReadonlyEditorProvider<WaveformDocument> {
  private readonly panels = new Map<string, Set<WaveformPanel>>();

  constructor(private readonly dependencies: WaveformPanelDependencies) {}

  static register(dependencies: WaveformPanelDependencies): { provider: WaveformEditorProvider; registration: vscode.Disposable } {
    const provider = new WaveformEditorProvider(dependencies);
    const registration = vscode.window.registerCustomEditorProvider(WAVEFORM_VIEW_TYPE, provider, {
      // The canvas view state (zoom, cursor, scroll) is expensive to rebuild.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true
    });
    return { provider, registration };
  }

  openCustomDocument(uri: vscode.Uri): WaveformDocument {
    return new WaveformDocument(uri);
  }

  resolveCustomEditor(document: WaveformDocument, webviewPanel: vscode.WebviewPanel): void {
    const key = keyFor(document.uri);
    const panel = new WaveformPanel(document.uri, webviewPanel, this.dependencies);
    const set = this.panels.get(key) ?? new Set<WaveformPanel>();
    set.add(panel);
    this.panels.set(key, set);
    webviewPanel.onDidDispose(() => {
      set.delete(panel);
      if (!set.size) {
        this.panels.delete(key);
      }
    });
  }

  isOpen(uri: vscode.Uri): boolean {
    return this.panels.has(keyFor(uri));
  }

  /** Ask every open editor of `uri` to reload (they skip unchanged files). */
  reload(uri: vscode.Uri): void {
    for (const panel of this.panels.get(keyFor(uri)) ?? []) {
      panel.reload();
    }
  }

  revealTime(uri: vscode.Uri, time: number): void {
    for (const panel of this.panels.get(keyFor(uri)) ?? []) {
      panel.revealTime(time);
    }
  }

  /** The waveform editor that is the active editor, if any. */
  activePanel(): WaveformPanel | undefined {
    for (const set of this.panels.values()) {
      for (const panel of set) {
        if (panel.panel.active) {
          return panel;
        }
      }
    }
    return undefined;
  }
}

function keyFor(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? normalizePathKey(uri.fsPath) : uri.toString();
}

/**
 * Show `uri` in the waveform viewer: focus an existing tab of it, otherwise open
 * one beside the active editor so the source stays visible.
 */
export async function openWaveformEditor(uri: vscode.Uri, options: { preserveFocus?: boolean } = {}): Promise<void> {
  const key = keyFor(uri);
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputCustom
        && tab.input.viewType === WAVEFORM_VIEW_TYPE
        && keyFor(tab.input.uri) === key) {
        await vscode.commands.executeCommand('vscode.openWith', uri, WAVEFORM_VIEW_TYPE, {
          viewColumn: group.viewColumn,
          preserveFocus: options.preserveFocus === true
        });
        return;
      }
    }
  }
  await vscode.commands.executeCommand('vscode.openWith', uri, WAVEFORM_VIEW_TYPE, {
    viewColumn: vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
    preserveFocus: options.preserveFocus === true,
    preview: false
  });
}
