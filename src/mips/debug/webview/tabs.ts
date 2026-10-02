// @index mips-debug — Accessible keyboard-navigable tab strip with stable panels
import { button, el } from './dom';

export class Tabs {
  readonly element = el('div', 'tabs');
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly panels = new Map<string, HTMLElement>();
  private active = '';
  constructor(label: string, private readonly callbacks: {
    beforeChange?(): void;
    changed?(id: string): void;
  } = {}) {
    this.element.setAttribute('role', 'tablist');
    this.element.setAttribute('aria-label', label);
    this.element.addEventListener('keydown', event => {
      const keys = [...this.buttons.keys()];
      const current = keys.indexOf(this.active);
      let target: string | undefined;
      if (event.key === 'ArrowRight') target = keys[(current + 1) % keys.length];
      if (event.key === 'ArrowLeft') target = keys[(current + keys.length - 1) % keys.length];
      if (event.key === 'Home') target = keys[0];
      if (event.key === 'End') target = keys[keys.length - 1];
      if (target) { event.preventDefault(); this.activate(target); this.buttons.get(target)?.focus(); }
    });
  }
  add(id: string, label: string, panel: HTMLElement): void {
    const control = button(label, () => this.activate(id), label, 'tab');
    control.id = `tab-${id}`;
    control.setAttribute('role', 'tab');
    control.setAttribute('aria-controls', `panel-${id}`);
    panel.id = `panel-${id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', control.id);
    this.buttons.set(id, control);
    this.panels.set(id, panel);
    this.element.append(control);
    panel.hidden = true;
    control.tabIndex = -1;
    control.setAttribute('aria-selected', 'false');
    if (!this.active) this.activate(id);
  }
  activate(id: string): void {
    if (!this.buttons.has(id)) return;
    if (id === this.active) return;
    this.callbacks.beforeChange?.();
    this.active = id;
    for (const [key, control] of this.buttons) {
      const selected = key === id;
      control.setAttribute('aria-selected', String(selected));
      control.tabIndex = selected ? 0 : -1;
      this.panels.get(key)!.hidden = !selected;
    }
    this.callbacks.changed?.(id);
  }
}
