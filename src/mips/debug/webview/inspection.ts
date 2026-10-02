// @index mips-debug — Adaptive inspection tabs and an accessible expanded reading dialog
import { button, el, text } from './dom';
import { Tabs } from './tabs';

export class Inspection {
  readonly element = el('div', 'inspection-slot');
  private readonly pane = el('section', 'inspection pane');
  private readonly dialog = el('dialog', 'inspection-dialog');
  private readonly expand: HTMLButtonElement;
  private readonly tabs: Tabs;
  private readonly scrollPositions = new Map<HTMLElement, { top: number; left: number }>();
  private returnFocus = true;

  constructor() {
    this.dialog.setAttribute('aria-label', '程序检查 · 展开阅读');
    this.expand = button('展开阅读', () => this.toggle(), '在大窗口中查看当前面板', 'inspection-expand');
    this.expand.setAttribute('aria-haspopup', 'dialog');
    this.expand.setAttribute('aria-expanded', 'false');
    this.tabs = new Tabs('程序检查', {
      beforeChange: () => this.saveScroll(), changed: () => this.restoreScroll()
    });
    const header = el('header', 'inspection-header');
    header.append(this.tabs.element, this.expand);
    this.pane.append(header);
    this.element.append(this.pane, this.dialog);
    this.dialog.addEventListener('close', () => {
      this.element.prepend(this.pane);
      this.restoreScroll();
      this.setExpanded(false);
      if (this.returnFocus) this.expand.focus({ preventScroll: true });
      this.returnFocus = true;
    });
    this.dialog.addEventListener('cancel', () => this.saveScroll());
  }

  add(id: string, name: string, panel: HTMLElement): void {
    this.tabs.add(id, name, panel);
    this.pane.append(panel);
  }

  activate(id: string): void { this.tabs.activate(id); }

  /** Explicit navigation to code should also leave the reading dialog. */
  close(returnFocus = true): void {
    if (!this.dialog.open) return;
    this.saveScroll();
    this.returnFocus = returnFocus;
    this.dialog.close();
  }

  private toggle(): void {
    if (this.dialog.open) { this.close(); return; }
    this.saveScroll();
    this.dialog.append(this.pane);
    this.setExpanded(true);
    this.dialog.showModal();
    this.restoreScroll();
    this.expand.focus({ preventScroll: true });
  }

  private saveScroll(): void {
    for (const element of this.pane.querySelectorAll<HTMLElement>('.table-scroll, .console-output')) {
      if (element.getClientRects().length > 0) {
        this.scrollPositions.set(element, { top: element.scrollTop, left: element.scrollLeft });
      }
    }
  }

  private restoreScroll(): void {
    for (const [element, { top, left }] of this.scrollPositions) {
      if (!element.getClientRects().length) continue;
      element.scrollTop = top;
      element.scrollLeft = left;
    }
  }

  private setExpanded(expanded: boolean): void {
    text(this.expand, expanded ? '还原布局' : '展开阅读');
    this.expand.title = expanded ? '关闭展开阅读（Esc）' : '在大窗口中查看当前面板';
    this.expand.setAttribute('aria-expanded', String(expanded));
  }
}
