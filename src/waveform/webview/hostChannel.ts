// @index waveform-webview-host — Webview 侧宿主通道：acquireVsCodeApi 封装与类型化的出站消息

import type { PersistedViewState } from '../model/viewStateContract';
import type { WebviewToHostMessage } from '../model/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export class HostChannel {
  private readonly api: VsCodeApi = acquireVsCodeApi();

  ready(): void {
    this.post({ type: 'ready' });
  }

  saveState(state: PersistedViewState): void {
    this.post({ type: 'saveState', state });
  }

  openSource(path: string, scope: boolean): void {
    this.post({ type: 'openSource', path, scope });
  }

  reload(force = false): void {
    this.post({ type: 'reload', force });
  }

  copyText(text: string): void {
    this.post({ type: 'copyText', text });
  }

  private post(message: WebviewToHostMessage): void {
    this.api.postMessage(message);
  }
}
