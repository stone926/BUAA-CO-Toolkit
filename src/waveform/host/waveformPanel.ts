// @index waveform-panel — 单个波形编辑器页签的宿主控制器：握手、流式加载与进度、文件监视重载、trace 附加、状态持久化与消息校验

import * as path from 'path';
import * as vscode from 'vscode';
import { samePath } from '../../pathUtils';
import type { HostToWebviewMessage, WaveformShortcut, WebviewToHostMessage } from '../model/protocol';
import { sanitizePersistedViewState } from '../model/viewStateContract';
import type { WaveformData } from '../model/waveformData';
import { parseVcdBytes, parseVcdFile, waveformFileSize } from './waveformFileLoader';
import { buildWaveformHtml, waveformAssetRoot } from './waveformHtml';
import { loadTraceForVcd } from './waveformTraceSource';
import type { WaveformViewStateStore } from './waveformViewStateStore';

/** Files above this size need an explicit confirmation from the webview. */
const confirmationBytes = 256 * 1024 * 1024;
/** Simulators write dumps incrementally; wait for writes to settle before reloading. */
const reloadDebounceMs = 400;
const maximumMessageTextLength = 1024 * 1024;

export interface WaveformPanelDependencies {
  readonly extensionUri: vscode.Uri;
  readonly stateStore: WaveformViewStateStore;
  readonly openSource: (dumpUri: vscode.Uri, signalPath: string, isScope: boolean, column: vscode.ViewColumn | undefined) => Promise<void>;
}

export class WaveformPanel implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private loadController: AbortController | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private loadedSignature: string | undefined;
  private ready = false;
  private disposed = false;
  private hasDocument = false;
  private pendingReveal: number | undefined;

  constructor(
    readonly uri: vscode.Uri,
    readonly panel: vscode.WebviewPanel,
    private readonly dependencies: WaveformPanelDependencies
  ) {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [waveformAssetRoot(dependencies.extensionUri)]
    };
    webview.html = buildWaveformHtml(webview, dependencies.extensionUri, path.basename(uri.fsPath || uri.path));
    this.disposables.push(
      webview.onDidReceiveMessage((message: unknown) => {
        void this.handleMessage(message);
      }),
      panel.onDidDispose(() => this.dispose())
    );
    this.watchFile();
  }

  /** Reload after an external rewrite (e.g. a waveform simulation finished). */
  reload(): void {
    if (this.ready) {
      void this.load(true, false);
    }
  }

  /** Move the cursor to `time` once the document is shown. */
  revealTime(time: number): void {
    if (this.hasDocument) {
      this.post({ type: 'revealTime', time });
    } else {
      this.pendingReveal = time;
    }
  }

  /** Run a shortcut VS Code routed here through an extension keybinding. */
  runShortcut(shortcut: WaveformShortcut): void {
    if (this.ready) {
      this.post({ type: 'shortcut', shortcut });
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.loadController?.abort();
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private watchFile(): void {
    if (this.uri.scheme !== 'file') {
      return;
    }
    // Watch the folder rather than using the file name as the glob: names such as
    // `cpu[1].vcd` or `{a}.vcd` are glob syntax and would never match themselves.
    const pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(this.uri.fsPath)), '*');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const forThisFile = (listener: () => void) => (changed: vscode.Uri): void => {
      if (samePath(changed.fsPath, this.uri.fsPath)) {
        listener();
      }
    };
    const schedule = (): void => {
      if (this.reloadTimer) {
        clearTimeout(this.reloadTimer);
      }
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = undefined;
        if (this.ready) {
          void this.load(true, false);
        }
      }, reloadDebounceMs);
    };
    this.disposables.push(
      watcher,
      watcher.onDidChange(forThisFile(schedule)),
      watcher.onDidCreate(forThisFile(schedule)),
      watcher.onDidDelete(forThisFile(() => this.post({ type: 'error', message: '波形文件已被删除', canRetry: true })))
    );
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const message = raw as WebviewToHostMessage;
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      return;
    }
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.loadedSignature = undefined;
        this.post({
          type: 'init',
          fileName: path.basename(this.uri.fsPath || this.uri.path),
          state: this.dependencies.stateStore.load(this.uri)
        });
        await this.load(false, false);
        return;
      case 'saveState': {
        const state = sanitizePersistedViewState(message.state);
        if (state) {
          await this.dependencies.stateStore.save(this.uri, state);
        }
        return;
      }
      case 'reload':
        await this.load(true, message.force === true, true);
        return;
      case 'openSource':
        if (typeof message.path === 'string' && message.path.length <= 1024) {
          await this.dependencies.openSource(this.uri, message.path, message.scope === true, this.panel.viewColumn);
        }
        return;
      case 'copyText':
        if (typeof message.text === 'string' && message.text.length <= maximumMessageTextLength) {
          await vscode.env.clipboard.writeText(message.text);
        }
        return;
      default:
        return;
    }
  }

  /**
   * Parse the file and send it. `reload` keeps the webview's view state; unchanged
   * files (same size and mtime) are skipped unless the user asked explicitly.
   */
  private async load(reload: boolean, force: boolean, userRequested = false): Promise<void> {
    const signature = await this.fileSignature();
    if (this.disposed || (reload && !userRequested && signature !== undefined && signature === this.loadedSignature)) {
      // Unchanged: leave any in-flight load (e.g. an explicit reload) running.
      return;
    }
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;
    try {
      const size = this.uri.scheme === 'file' ? await waveformFileSize(this.uri.fsPath) : undefined;
      if (size !== undefined && size > confirmationBytes && !force) {
        this.post({
          type: 'error',
          message: `波形文件较大（${(size / 1024 / 1024).toFixed(0)} MiB），加载可能占用大量内存`,
          canRetry: true
        });
        return;
      }
      const onProgress = (loadedBytes: number, totalBytes: number): void => {
        if (!controller.signal.aborted) {
          this.post({ type: 'progress', loadedBytes, totalBytes });
        }
      };
      this.post({ type: 'progress', loadedBytes: 0, totalBytes: size ?? 0 });
      const data: WaveformData = this.uri.scheme === 'file'
        ? await parseVcdFile(this.uri.fsPath, { signal: controller.signal, onProgress })
        : await parseVcdBytes(await vscode.workspace.fs.readFile(this.uri), { signal: controller.signal, onProgress });
      if (controller.signal.aborted || this.disposed) {
        return;
      }
      this.loadedSignature = signature;
      this.post({ type: 'document', data, reload: reload && this.hasDocument });
      this.hasDocument = true;
      if (this.pendingReveal !== undefined) {
        this.post({ type: 'revealTime', time: this.pendingReveal });
        this.pendingReveal = undefined;
      }
      const trace = this.uri.scheme === 'file' ? await loadTraceForVcd(this.uri.fsPath, data.timescale) : undefined;
      if (!controller.signal.aborted && !this.disposed) {
        this.post({ type: 'trace', trace });
      }
    } catch (error) {
      if (controller.signal.aborted || this.disposed) {
        return;
      }
      this.post({
        type: 'error',
        message: `无法读取波形文件：${error instanceof Error ? error.message : String(error)}`,
        canRetry: true
      });
    }
  }

  private async fileSignature(): Promise<string | undefined> {
    try {
      const info = await vscode.workspace.fs.stat(this.uri);
      return `${info.size}:${info.mtime}`;
    } catch {
      return undefined;
    }
  }

  private post(message: HostToWebviewMessage): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }
}
