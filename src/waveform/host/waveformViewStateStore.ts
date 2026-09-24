// @index waveform-state-store — 按 VCD 绝对路径把视图状态存入 workspaceState；读取与写入都经契约清洗，条目数有上限

import type * as vscode from 'vscode';
import { normalizePathKey } from '../../pathUtils';
import { PersistedViewState, sanitizePersistedViewState } from '../model/viewStateContract';

const keyPrefix = 'co.waveform.viewState:';
const indexKey = 'co.waveform.viewStateIndex';
/** Remember the most recently used dumps only. */
const maximumEntries = 64;

export class WaveformViewStateStore {
  constructor(private readonly memento: vscode.Memento) {}

  load(uri: vscode.Uri): PersistedViewState | undefined {
    return sanitizePersistedViewState(this.memento.get(this.key(uri)));
  }

  async save(uri: vscode.Uri, state: PersistedViewState): Promise<void> {
    const sanitized = sanitizePersistedViewState(state);
    if (!sanitized) {
      return;
    }
    const key = this.key(uri);
    const index = this.memento.get<string[]>(indexKey, []).filter((entry) => entry !== key);
    index.push(key);
    const evicted = index.splice(0, Math.max(0, index.length - maximumEntries));
    await Promise.all([
      this.memento.update(key, sanitized),
      this.memento.update(indexKey, index),
      ...evicted.map((entry) => this.memento.update(entry, undefined))
    ]);
  }

  private key(uri: vscode.Uri): string {
    return keyPrefix + (uri.scheme === 'file' ? normalizePathKey(uri.fsPath) : uri.toString());
  }
}
