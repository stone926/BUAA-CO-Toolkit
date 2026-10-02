// @index mips-debug — Adaptive inspection tabs and an accessible expanded reading dialog
import { button, el, text } from './dom';
import { Tabs } from './tabs';

export class Inspection {
  readonly element = el('div', 'inspection-slot');
  private readonly pane = el('section', 'inspection pane');
  private readonly dialog = el('dialog', 'inspection-dialog');
  private readonly expand: HTMLButtonElement;
  private readonly tabs: Tabs;

  constructor() {
    this.dialog.setAttribute('aria-label', '程序检查 · 展开阅读');
    this.expand = button('展开阅读', () => this.toggle(), '在大窗口中查看当前面板', 'inspection-expand');
    this.expand.setAttribute('aria-haspopup', 'dialog');
    this.expand.setAttribute('aria-expanded', 'false');
    this.tabs = new Tabs('程序检查', id => { this.element.dataset.tab = id; });
    const header = el('header', 'inspection-header');
    header.append(this.tabs.element, this.expand);
    this.pane.append(header);
    this.element.append(this.pane, this.dialog);
    this.dialog.addEventListener('close', () => {
      this.element.prepend(this.pane);
      this.setExpanded(false);
      this.expand.focus({ preventScroll: true });
    });
  }

  add(id: string, name: string, panel: HTMLElement): void {
    this.tabs.add(id, name, panel);
    this.pane.append(panel);
  }

  activate(id: string): void { this.tabs.activate(id); }

  /** Explicit navigation to code should also leave the reading dialog. */
  close(): void { if (this.dialog.open) this.dialog.close(); }

  private toggle(): void {
    if (this.dialog.open) { this.close(); return; }
    this.dialog.append(this.pane);
    this.setExpanded(true);
    this.dialog.showModal();
    this.expand.focus({ preventScroll: true });
  }

  private setExpanded(expanded: boolean): void {
    text(this.expand, expanded ? '还原布局' : '展开阅读');
    this.expand.title = expanded ? '关闭展开阅读（Esc）' : '在大窗口中查看当前面板';
    this.expand.setAttribute('aria-expanded', String(expanded));
  }
}
