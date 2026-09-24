// @index waveform-webview-menu — 通用右键菜单：勾选项、快捷键提示、子菜单、键盘导航，点击外部/Esc/失焦关闭

import { h } from './dom';

export interface MenuItem {
  readonly label: string;
  readonly action?: () => void;
  readonly submenu?: readonly MenuEntry[];
  readonly shortcut?: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  /** Optional CSS color swatch shown before the label. */
  readonly swatch?: string;
}

export type MenuEntry = MenuItem | 'separator';

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
  private readonly onDocumentPointer = (event: PointerEvent): void => {
    if (!this.contains(event.target as Node)) {
      this.root().close();
    }
  };
  private readonly onKey = (event: KeyboardEvent): void => this.handleKey(event);
  private readonly onBlur = (): void => this.root().close();

  constructor(private readonly entries: readonly MenuEntry[], private readonly parent: ContextMenu | undefined) {
    this.element = h('div', { className: 'menu', attrs: { role: 'menu' } });
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
      item.addEventListener('pointerenter', () => this.highlight(index, true));
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        this.activate(index);
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
    this.child?.close();
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

  private highlight(index: number, openSubmenu: boolean): void {
    this.items[this.active]?.classList.remove('active');
    this.active = index;
    this.items[index]?.classList.add('active');
    const entry = this.entryAt(index);
    if (this.child && (!entry?.submenu || !openSubmenu)) {
      this.child.close();
      this.child = undefined;
    }
    if (openSubmenu && entry?.submenu && !entry.disabled && !this.child) {
      this.openSubmenu(index, entry.submenu);
    }
  }

  private openSubmenu(index: number, entries: readonly MenuEntry[]): void {
    const rect = this.items[index].getBoundingClientRect();
    this.child = new ContextMenu(entries, this);
    this.child.open(rect.right - 2, rect.top - 4);
    const childRect = this.child.element.getBoundingClientRect();
    if (childRect.left < rect.right - 4) {
      this.child.element.style.left = `${Math.max(2, rect.left - childRect.width + 2)}px`;
    }
  }

  private activate(index: number): void {
    const entry = this.entryAt(index);
    if (!entry || entry.disabled) {
      return;
    }
    if (entry.submenu) {
      this.highlight(index, true);
      this.child?.highlight(0, false);
      return;
    }
    this.root().close();
    entry.action?.();
  }

  private handleKey(event: KeyboardEvent): void {
    const menu = this.deepest();
    event.stopPropagation();
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        if (menu.parent) {
          const parent = menu.parent;
          parent.child = undefined;
          menu.close();
        } else {
          this.close();
        }
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const count = menu.items.length;
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        let next = menu.active;
        for (let step = 0; step < count; step++) {
          next = (next + direction + count) % count;
          if (!menu.entryAt(next)?.disabled) {
            break;
          }
        }
        menu.highlight(next, false);
        return;
      }
      case 'ArrowRight':
        event.preventDefault();
        if (menu.entryAt(menu.active)?.submenu) {
          menu.activate(menu.active);
        }
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (menu.parent) {
          menu.parent.child = undefined;
          menu.close();
        }
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        menu.activate(menu.active);
        return;
      default:
        event.preventDefault();
    }
  }

  private deepest(): ContextMenu {
    return this.child ? this.child.deepest() : this;
  }
}
