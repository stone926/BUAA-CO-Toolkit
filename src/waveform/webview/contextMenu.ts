// @index waveform-webview-menu — 通用右键菜单：勾选项、快捷键提示、子菜单（悬停停留后打开/切换）、键盘导航，点击外部/Esc/失焦关闭

import { h } from './dom';

export interface MenuItem {
  readonly label: string;
  readonly action?: () => void;
  readonly submenu?: readonly MenuEntry[];
  /** Dimmed right-aligned hint: a key binding, or a short detail such as a time. */
  readonly shortcut?: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  /** Optional CSS color swatch shown before the label. */
  readonly swatch?: string;
}

export type MenuEntry = MenuItem | 'separator';

/**
 * How long the pointer rests on an item before its submenu opens or replaces the open
 * one. Crossing sibling items on the way into an open submenu takes less than this.
 */
const submenuHoverDelay = 250;

let openMenu: ContextMenu | undefined;

export function showContextMenu(x: number, y: number, entries: readonly MenuEntry[]): void {
  openMenu?.close();
  openMenu = new ContextMenu(entries, undefined);
  openMenu.open(x, y);
}

export function closeContextMenu(): void {
  openMenu?.close();
}

class ContextMenu {
  private readonly element: HTMLDivElement;
  private readonly items: HTMLElement[] = [];
  private active = -1;
  private child: ContextMenu | undefined;
  /** Index of the item whose submenu `child` is. */
  private childOwner = -1;
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onDocumentPointer = (event: PointerEvent): void => {
    if (!this.contains(event.target as Node)) {
      this.root().close();
    }
  };
  private readonly onKey = (event: KeyboardEvent): void => this.handleKey(event);
  private readonly onBlur = (): void => this.root().close();

  constructor(private readonly entries: readonly MenuEntry[], private readonly parent: ContextMenu | undefined) {
    this.element = h('div', { className: 'menu', attrs: { role: 'menu' } });
    // Leaving the menu (e.g. into its submenu) keeps the open submenu even if other items were crossed on the way.
    this.element.addEventListener('pointerleave', () => this.settle());
    entries.forEach((entry) => {
      if (entry === 'separator') {
        this.element.append(h('div', { className: 'menu-separator' }));
        return;
      }
      const swatch = entry.swatch ? h('span', { className: 'menu-swatch' }) : undefined;
      if (swatch && entry.swatch) {
        swatch.style.background = entry.swatch;
      }
      const item = h('div', {
        className: `menu-item${entry.disabled ? ' disabled' : ''}${entry.submenu ? ' has-submenu' : ''}`,
        attrs: { role: 'menuitem' }
      }, [
        h('span', { className: 'menu-check', text: entry.checked ? '✓' : '' }),
        swatch,
        h('span', { className: 'menu-label', text: entry.label }),
        h('span', { className: 'menu-shortcut', text: entry.shortcut ?? (entry.submenu ? '›' : '') })
      ]);
      const index = this.items.length;
      this.items.push(item);
      item.addEventListener('pointerenter', () => this.hover(index));
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        this.activate(index, false);
      });
      this.element.append(item);
    });
  }

  open(x: number, y: number): void {
    document.body.append(this.element);
    const rect = this.element.getBoundingClientRect();
    const left = Math.max(2, Math.min(x, window.innerWidth - rect.width - 2));
    const top = Math.max(2, Math.min(y, window.innerHeight - rect.height - 2));
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
    if (!this.parent) {
      document.addEventListener('pointerdown', this.onDocumentPointer, true);
      document.addEventListener('keydown', this.onKey, true);
      window.addEventListener('blur', this.onBlur);
    }
  }

  close(): void {
    this.cancelHover();
    this.closeSubmenu();
    this.element.remove();
    if (!this.parent) {
      document.removeEventListener('pointerdown', this.onDocumentPointer, true);
      document.removeEventListener('keydown', this.onKey, true);
      window.removeEventListener('blur', this.onBlur);
      if (openMenu === this) {
        openMenu = undefined;
      }
    }
  }

  private root(): ContextMenu {
    return this.parent ? this.parent.root() : this;
  }

  private contains(node: Node): boolean {
    return this.element.contains(node) || (this.child?.contains(node) ?? false);
  }

  private entryAt(index: number): MenuItem | undefined {
    let count = -1;
    for (const entry of this.entries) {
      if (entry !== 'separator' && ++count === index) {
        return entry;
      }
    }
    return undefined;
  }

  private setActive(index: number): void {
    this.items[this.active]?.classList.remove('active');
    this.active = index;
    this.items[index]?.classList.add('active');
  }

  /** Pointer over item `index`: highlight it now; open, replace or close the submenu once the pointer rests there. */
  private hover(index: number): void {
    this.setActive(index);
    this.cancelHover();
    if (index !== this.childOwner && (this.child || this.entryAt(index)?.submenu)) {
      this.hoverTimer = setTimeout(() => {
        this.hoverTimer = undefined;
        this.showSubmenu(index);
      }, submenuHoverDelay);
    }
  }

  private cancelHover(): void {
    if (this.hoverTimer !== undefined) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = undefined;
    }
  }

  /** Drop a pending submenu change and highlight the item whose submenu is open again. */
  private settle(): void {
    this.cancelHover();
    if (this.child) {
      this.setActive(this.childOwner);
    }
  }

  /** Show the submenu of item `index` (if it has one), closing any other item's submenu. */
  private showSubmenu(index: number): void {
    this.cancelHover();
    if (this.child && this.childOwner === index) {
      return;
    }
    this.closeSubmenu();
    const entry = this.entryAt(index);
    if (!entry?.submenu || entry.disabled) {
      return;
    }
    const rect = this.items[index].getBoundingClientRect();
    const child = new ContextMenu(entry.submenu, this);
    this.child = child;
    this.childOwner = index;
    child.open(rect.right - 2, rect.top - 4);
    const childRect = child.element.getBoundingClientRect();
    if (childRect.left < rect.right - 4) {
      child.element.style.left = `${Math.max(2, rect.left - childRect.width + 2)}px`;
    }
  }

  private closeSubmenu(): void {
    this.child?.close();
    this.child = undefined;
    this.childOwner = -1;
  }

  private activate(index: number, fromKeyboard: boolean): void {
    const entry = this.entryAt(index);
    if (!entry || entry.disabled) {
      return;
    }
    if (entry.submenu) {
      this.setActive(index);
      this.showSubmenu(index);
      if (fromKeyboard) {
        this.child?.step(1);
      }
      return;
    }
    this.root().close();
    entry.action?.();
  }

  /** Move the highlight to the next enabled item in `direction`, wrapping around. */
  private step(direction: -1 | 1): void {
    const count = this.items.length;
    // With nothing highlighted, start just outside the list so the first step lands on its first/last item.
    let next = this.active < 0 ? (direction > 0 ? -1 : count) : this.active;
    for (let step = 0; step < count; step++) {
      next = (next + direction + count) % count;
      if (!this.entryAt(next)?.disabled) {
        break;
      }
    }
    this.setActive(next);
    // Long menus scroll; keep the keyboard highlight in view.
    this.items[next]?.scrollIntoView({ block: 'nearest' });
  }

  private handleKey(event: KeyboardEvent): void {
    const menu = this.keyboardTarget();
    event.stopPropagation();
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        if (menu.parent) {
          menu.parent.closeSubmenu();
        } else {
          this.close();
        }
        return;
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        menu.step(event.key === 'ArrowDown' ? 1 : -1);
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (menu.entryAt(menu.active)?.submenu) {
          menu.activate(menu.active, true);
        }
        return;
      case 'ArrowLeft':
        event.preventDefault();
        menu.parent?.closeSubmenu();
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        menu.activate(menu.active, true);
        return;
      default:
        event.preventDefault();
    }
  }

  /** Keys act on the deepest open menu; pending pointer-driven submenu changes are dropped along the way. */
  private keyboardTarget(): ContextMenu {
    this.settle();
    return this.child ? this.child.keyboardTarget() : this;
  }
}
