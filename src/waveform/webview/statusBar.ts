// @index waveform-webview-status — 底部状态栏与覆盖层：文件/精度/时间范围/信号与跳变统计、解析提示弹出、临时通知、加载进度与错误重试

import { formatTicks, unitLabel } from '../model/timeScale';
import { showContextMenu } from './contextMenu';
import { h, setText } from './dom';
import type { HostChannel } from './hostChannel';
import type { DirtyFlag, WaveStore } from './store';

export class StatusBar {
  readonly element: HTMLElement;
  private readonly summary: HTMLSpanElement;
  private readonly diagnostics: HTMLButtonElement;
  private readonly notice: HTMLSpanElement;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly store: WaveStore) {
    this.summary = h('span', { className: 'status-summary' });
    this.diagnostics = h('button', { className: 'status-diagnostics', title: '解析波形时的提示' });
    this.diagnostics.addEventListener('click', (event) => {
      const items = this.store.data?.diagnostics ?? [];
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      showContextMenu(rect.left, rect.top - Math.min(items.length, 12) * 26 - 8, items.map((item) => ({ label: item.message, disabled: true })));
    });
    this.notice = h('span', { className: 'status-notice', attrs: { role: 'status' } });
    this.element = h('footer', { className: 'status-bar' }, [this.summary, this.diagnostics, h('span', { className: 'spacer' }), this.notice]);
  }

  notify(message: string): void {
    setText(this.notice, message);
    this.notice.classList.add('visible');
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
    }
    this.noticeTimer = setTimeout(() => this.notice.classList.remove('visible'), 4000);
  }

  render(dirty: ReadonlySet<DirtyFlag>): void {
    if (!dirty.has('status')) {
      return;
    }
    const data = this.store.data;
    if (!data) {
      setText(this.summary, this.store.fileName);
      this.diagnostics.hidden = true;
      return;
    }
    const scale = data.timescale;
    const parts = [
      this.store.fileName,
      `精度 ${scale.magnitude}${unitLabel(scale.unit)}`,
      `${formatTicks(data.startTime, scale)} – ${formatTicks(data.endTime, scale)}`,
      `${data.vars.length} 个信号`,
      formatChanges(data.metadata.changeCount),
      formatBytes(data.metadata.byteLength)
    ];
    if (this.store.cycles) {
      parts.push(`${this.store.cycles.totalCycles} 个时钟周期`);
    }
    setText(this.summary, parts.join('  ·  '));
    const count = data.diagnostics.length;
    this.diagnostics.hidden = count === 0;
    setText(this.diagnostics, `⚠ ${count} 条解析提示`);
  }
}

/** Centered overlay for loading progress and load errors. */
export class LoadOverlay {
  readonly element: HTMLElement;
  private readonly title: HTMLDivElement;
  private readonly detail: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly progress: HTMLDivElement;
  private readonly retry: HTMLButtonElement;

  constructor(private readonly store: WaveStore, host: HostChannel) {
    this.title = h('div', { className: 'overlay-title' });
    this.detail = h('div', { className: 'overlay-detail' });
    this.bar = h('div', { className: 'progress-bar' });
    this.progress = h('div', { className: 'progress' }, [this.bar]);
    this.retry = h('button', { className: 'primary-button', text: '重试' });
    this.retry.addEventListener('click', () => host.reload(true));
    this.element = h('div', { className: 'load-overlay' }, [
      h('div', { className: 'overlay-card' }, [this.title, this.progress, this.detail, this.retry])
    ]);
  }

  render(): void {
    const { loading, error, data } = this.store;
    if (error) {
      this.element.hidden = false;
      this.element.classList.toggle('blocking', !data);
      setText(this.title, error.message);
      setText(this.detail, data ? '当前显示的是上一次成功加载的内容' : '');
      this.progress.hidden = true;
      this.retry.hidden = !error.canRetry;
      setText(this.retry, error.message.includes('较大') ? '仍然加载' : '重试');
      return;
    }
    if (loading) {
      this.element.hidden = false;
      this.element.classList.toggle('blocking', !data);
      setText(this.title, data ? '正在重新加载波形…' : '正在解析波形…');
      const ratio = loading.total > 0 ? Math.min(1, loading.loaded / loading.total) : 0;
      this.progress.hidden = false;
      this.bar.style.width = `${(ratio * 100).toFixed(1)}%`;
      setText(this.detail, loading.total > 0 ? `${formatBytes(loading.loaded)} / ${formatBytes(loading.total)}` : '');
      this.retry.hidden = true;
      return;
    }
    this.element.hidden = true;
  }
}

function formatChanges(value: number): string {
  if (value >= 1e8) {
    return `${(value / 1e8).toFixed(1)} 亿次跳变`;
  }
  if (value >= 1e4) {
    return `${(value / 1e4).toFixed(1)} 万次跳变`;
  }
  return `${value} 次跳变`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KiB`;
  }
  return `${bytes} B`;
}
