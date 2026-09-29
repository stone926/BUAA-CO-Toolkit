import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
vi.mock('../asmCaseStore', () => ({
  asmCaseIndexDirectory: vi.fn(),
  listAsmCaseManifestsInDirectory: vi.fn()
}));
vi.mock('../courseTestReport', () => ({ renderAsmCaseIndex: vi.fn() }));

import {
  attachAsmCaseIndexLiveRefresh,
  type AsmCaseHistoryLiveDependencies,
  type AsmCaseHistoryPanel
} from '../courseTestHistory';
import type { AsmCaseManifestEntry } from '../courseTestReport';

interface TestWatcher {
  disposed: boolean;
  listeners: Record<'create' | 'change' | 'delete', Set<() => void>>;
  onDidCreate(listener: () => void): { dispose(): void };
  onDidChange(listener: () => void): { dispose(): void };
  onDidDelete(listener: () => void): { dispose(): void };
  dispose(): void;
  fire(kind: 'create' | 'change' | 'delete'): void;
}

function createWatcher(): TestWatcher {
  const listeners: TestWatcher['listeners'] = {
    create: new Set(),
    change: new Set(),
    delete: new Set()
  };
  const on = (kind: keyof TestWatcher['listeners']) => (listener: () => void) => {
    listeners[kind].add(listener);
    return { dispose: () => listeners[kind].delete(listener) };
  };
  return {
    disposed: false,
    listeners,
    onDidCreate: on('create'),
    onDidChange: on('change'),
    onDidDelete: on('delete'),
    dispose() { this.disposed = true; },
    fire(kind) {
      for (const listener of listeners[kind]) listener();
    }
  };
}

function createPanel() {
  const panel = {
    webview: { html: '' },
    disposeListeners: new Set<() => void>(),
    viewStateListeners: new Set<(event: { webviewPanel: { active: boolean } }) => void>(),
    onDidDispose(listener: () => void) {
      this.disposeListeners.add(listener);
      return { dispose: () => this.disposeListeners.delete(listener) };
    },
    onDidChangeViewState(listener: (event: { webviewPanel: { active: boolean } }) => void) {
      this.viewStateListeners.add(listener);
      return { dispose: () => this.viewStateListeners.delete(listener) };
    },
    close() {
      for (const listener of [...this.disposeListeners]) listener();
    },
    focus(active = true) {
      for (const listener of this.viewStateListeners) listener({ webviewPanel: { active } });
    }
  };
  return panel;
}

function entry(id: string): AsmCaseManifestEntry {
  return { manifest: { caseId: id } } as AsmCaseManifestEntry;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function dependencies(
  watcher: TestWatcher,
  list: AsmCaseHistoryLiveDependencies['list'],
  showError = vi.fn()
): AsmCaseHistoryLiveDependencies {
  return {
    watch: vi.fn(() => watcher as never),
    list,
    render: (entries) => entries.map((item) => item.manifest.caseId).join(','),
    showError,
    debounceMs: 500
  };
}

afterEach(() => vi.useRealTimers());

describe('course-test history live refresh', () => {
  it('watches all case manifest events and debounces them into one refresh', async () => {
    vi.useFakeTimers();
    const panel = createPanel();
    const watcher = createWatcher();
    const list = vi.fn(async () => [entry('latest')]);
    const deps = dependencies(watcher, list);
    attachAsmCaseIndexLiveRefresh(panel as unknown as AsmCaseHistoryPanel, 'C:/workspace/.co/cases', deps);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(deps.watch).toHaveBeenCalledWith('C:/workspace/.co/cases');
    expect(panel.webview.html).toBe('latest');

    watcher.fire('create');
    watcher.fire('change');
    watcher.fire('delete');
    await vi.advanceTimersByTimeAsync(499);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('refreshes at each fixed coalescing window while manifest events continue', async () => {
    vi.useFakeTimers();
    const panel = createPanel();
    const watcher = createWatcher();
    const list = vi.fn(async () => [entry(`read-${list.mock.calls.length}`)]);
    attachAsmCaseIndexLiveRefresh(panel as unknown as AsmCaseHistoryPanel, 'workspace/.co/cases', dependencies(watcher, list));
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    watcher.fire('change');
    await vi.advanceTimersByTimeAsync(400);
    watcher.fire('change');
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(400);
    watcher.fire('change');
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  });

  it('serializes reads and reruns once for changes received during a refresh', async () => {
    vi.useFakeTimers();
    const panel = createPanel();
    const watcher = createWatcher();
    const first = deferred<AsmCaseManifestEntry[]>();
    const second = deferred<AsmCaseManifestEntry[]>();
    let activeReads = 0;
    let maximumActiveReads = 0;
    const list = vi.fn(async () => {
      activeReads++;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      const result = list.mock.calls.length === 1 ? await first.promise : await second.promise;
      activeReads--;
      return result;
    });
    attachAsmCaseIndexLiveRefresh(panel as unknown as AsmCaseHistoryPanel, 'workspace/.co/cases', dependencies(watcher, list));
    expect(list).toHaveBeenCalledTimes(1);

    watcher.fire('change');
    await vi.advanceTimersByTimeAsync(500);
    expect(list).toHaveBeenCalledTimes(1);

    first.resolve([entry('stale')]);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(maximumActiveReads).toBe(1);
    expect(panel.webview.html).toBe('stale');
    second.resolve([entry('final')]);
    await vi.waitFor(() => expect(panel.webview.html).toBe('final'));
    expect(maximumActiveReads).toBe(1);
  });

  it('disposes watcher and pending debounce on panel close, and ignores an in-flight result', async () => {
    vi.useFakeTimers();
    const panel = createPanel();
    const watcher = createWatcher();
    const initial = deferred<AsmCaseManifestEntry[]>();
    const list = vi.fn(async () => await initial.promise);
    attachAsmCaseIndexLiveRefresh(panel as unknown as AsmCaseHistoryPanel, 'workspace/.co/cases', dependencies(watcher, list));
    watcher.fire('change');

    panel.close();
    await vi.advanceTimersByTimeAsync(1000);
    initial.resolve([entry('after-close')]);
    await Promise.resolve();

    expect(watcher.disposed).toBe(true);
    expect(watcher.listeners.create.size).toBe(0);
    expect(watcher.listeners.change.size).toBe(0);
    expect(watcher.listeners.delete.size).toBe(0);
    expect(list).toHaveBeenCalledTimes(1);
    expect(panel.webview.html).toBe('');
  });
});
