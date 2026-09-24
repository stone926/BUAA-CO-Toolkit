// @index waveform-webview-tooltip — 悬停提示框：延迟显示、跟随指针并限制在视口内

import { h } from './dom';

export interface TooltipLine {
  readonly label?: string;
  readonly value: string;
  readonly className?: string;
}

export class Tooltip {
  private readonly element: HTMLDivElement;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.element = h('div', { className: 'tooltip', attrs: { role: 'tooltip' } });
    document.body.append(this.element);
  }

  /** Show after `delay` ms unless hidden or rescheduled before then. */
  schedule(x: number, y: number, build: () => readonly TooltipLine[] | undefined, delay = 350): void {
    this.cancel();
    if (this.element.classList.contains('visible')) {
      this.show(x, y, build());
      return;
    }
    this.timer = setTimeout(() => this.show(x, y, build()), delay);
  }

  hide(): void {
    this.cancel();
    this.element.classList.remove('visible');
  }

  private cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private show(x: number, y: number, lines: readonly TooltipLine[] | undefined): void {
    this.timer = undefined;
    if (!lines?.length) {
      this.element.classList.remove('visible');
      return;
    }
    this.element.replaceChildren(...lines.map((line) => h('div', { className: `tooltip-line ${line.className ?? ''}` }, [
      line.label ? h('span', { className: 'tooltip-label', text: line.label }) : null,
      h('span', { className: 'tooltip-value', text: line.value })
    ])));
    this.element.classList.add('visible');
    const rect = this.element.getBoundingClientRect();
    const left = x + 14 + rect.width > window.innerWidth ? x - rect.width - 10 : x + 14;
    const top = y + 18 + rect.height > window.innerHeight ? y - rect.height - 8 : y + 18;
    this.element.style.left = `${Math.max(2, left)}px`;
    this.element.style.top = `${Math.max(2, top)}px`;
  }
}
