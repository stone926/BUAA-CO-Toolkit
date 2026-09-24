// @index waveform-webview-browser — 侧栏信号树：搜索过滤与高亮、虚拟列表、展开折叠、已显示标记、双击/+/拖拽添加、右键菜单与键盘导航

import { collectVarIndexes, FlatTreeNode, flattenSignalTree, TreeNode } from '../view/signalTree';
import type { WaveActions } from './actions';
import { showContextMenu, MenuEntry } from './contextMenu';
import { h, setText, toggleClass } from './dom';
import type { HostChannel } from './hostChannel';
import { icons } from './icons';
import type { DirtyFlag, WaveStore } from './store';
import { encodeSignalDrag, signalDragType } from './dragData';

const treeRowHeight = 22;
const maximumRecursiveSignals = 512;

interface TreeRowElement {
  readonly root: HTMLDivElement;
  readonly indent: HTMLSpanElement;
  readonly twisty: HTMLSpanElement;
  readonly icon: HTMLSpanElement;
  readonly label: HTMLSpanElement;
  readonly detail: HTMLSpanElement;
  readonly add: HTMLButtonElement;
  index: number;
}

export class SignalBrowser {
  readonly element: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly list: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  private readonly footer: HTMLDivElement;
  private readonly pool: TreeRowElement[] = [];
  private readonly expanded = new Set<string>();
  private flat: FlatTreeNode[] = [];
  private truncated = false;
  private query = '';
  private selected = -1;
  private tree: readonly TreeNode[] | undefined;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: WaveStore,
    private readonly actions: WaveActions,
    private readonly host: HostChannel,
    private readonly notify: (message: string) => void
  ) {
    this.search = h('input', {
      className: 'search-input',
      attrs: { type: 'search', placeholder: '搜索信号（支持 CPU.GRF 这样的路径片段）', spellcheck: 'false' }
    });
    this.search.addEventListener('input', () => {
      if (this.searchTimer) {
        clearTimeout(this.searchTimer);
      }
      this.searchTimer = setTimeout(() => {
        this.query = this.search.value;
        this.selected = 0;
        this.rebuild();
      }, 90);
    });
    this.search.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.list.focus();
        this.moveSelection(Math.max(0, this.selected));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        this.addNode(this.flat[Math.max(0, this.selected)]?.node);
      } else if (event.key === 'Escape' && this.search.value) {
        event.preventDefault();
        event.stopPropagation();
        this.search.value = '';
        this.query = '';
        this.rebuild();
      }
    });
    this.spacer = h('div', { className: 'tree-spacer' });
    this.list = h('div', { className: 'tree-list', attrs: { tabindex: '0', role: 'tree' } }, [this.spacer]);
    this.list.addEventListener('scroll', () => this.renderRows());
    this.list.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.list.addEventListener('click', (event) => this.onClick(event));
    this.list.addEventListener('dblclick', (event) => this.onDoubleClick(event));
    this.list.addEventListener('contextmenu', (event) => this.onContextMenu(event));
    this.list.addEventListener('dragstart', (event) => this.onDragStart(event));
    this.footer = h('div', { className: 'tree-footer' });
    this.element = h('div', { className: 'signal-browser' }, [
      h('div', { className: 'search-box' }, [h('span', { className: 'search-icon', html: icons.search }), this.search]),
      this.list,
      this.footer
    ]);
    new ResizeObserver(() => this.renderRows()).observe(this.list);
  }

  focusSearch(): void {
    this.search.focus();
    this.search.select();
  }

  render(dirty: ReadonlySet<DirtyFlag>): void {
    if (this.store.tree !== this.tree) {
      if (!this.tree?.length && this.store.tree.length) {
        // First real tree: open the testbench and its direct instances.
        this.expandDefaults(this.store.tree);
      }
      this.tree = this.store.tree;
      this.rebuild();
      return;
    }
    if (dirty.has('labels') || dirty.has('browser')) {
      this.renderRows();
    }
  }

  private expandDefaults(roots: readonly TreeNode[]): void {
    for (const root of roots) {
      this.expanded.add(root.id);
      for (const child of root.children) {
        if (child.kind === 'scope') {
          this.expanded.add(child.id);
        }
      }
    }
  }

  private rebuild(): void {
    const result = flattenSignalTree(this.store.tree, this.expanded, this.query);
    this.flat = result.nodes;
    this.truncated = result.truncated;
    this.selected = Math.min(this.selected, this.flat.length - 1);
    this.spacer.style.height = `${this.flat.length * treeRowHeight}px`;
    const signals = this.store.data?.vars.length ?? 0;
    setText(this.footer, this.query.trim()
      ? `${this.flat.filter((entry) => entry.node.kind === 'var').length} 个匹配${this.truncated ? '（结果过多，已截断）' : ''}`
      : `共 ${signals} 个信号 · 双击或拖入右侧添加`);
    this.renderRows();
  }

  private renderRows(): void {
    const displayed = new Set(this.store.rows.allSignals().map((row) => row.varIndex));
    const top = this.list.scrollTop;
    const height = this.list.clientHeight || 400;
    const first = Math.max(0, Math.floor(top / treeRowHeight) - 3);
    const last = Math.min(this.flat.length - 1, Math.ceil((top + height) / treeRowHeight) + 3);
    let used = 0;
    const needle = this.query.trim().toLowerCase();
    for (let index = first; index <= last; index++) {
      const element = this.pool[used] ?? this.createRow();
      used++;
      this.fillRow(element, this.flat[index], index, displayed, needle);
    }
    for (let index = used; index < this.pool.length; index++) {
      this.pool[index].root.hidden = true;
    }
  }

  private createRow(): TreeRowElement {
    const indent = h('span', { className: 'tree-indent' });
    const twisty = h('span', { className: 'twisty' });
    const icon = h('span', { className: 'node-icon' });
    const label = h('span', { className: 'node-label' });
    const detail = h('span', { className: 'node-detail' });
    const add = h('button', { className: 'node-add', title: '添加到波形', html: icons.plus, attrs: { tabindex: '-1' } });
    const root = h('div', { className: 'tree-row', attrs: { role: 'treeitem', draggable: 'true' } }, [indent, twisty, icon, label, detail, add]);
    this.list.append(root);
    const element: TreeRowElement = { root, indent, twisty, icon, label, detail, add, index: -1 };
    this.pool.push(element);
    return element;
  }

  private fillRow(element: TreeRowElement, entry: FlatTreeNode, index: number, displayed: ReadonlySet<number>, needle: string): void {
    const node = entry.node;
    element.index = index;
    element.root.hidden = false;
    element.root.dataset.index = String(index);
    element.root.style.top = `${index * treeRowHeight}px`;
    element.indent.style.width = `${entry.depth * 12}px`;
    element.twisty.innerHTML = entry.expandable ? (entry.expanded ? icons.chevronDown : icons.chevronRight) : '';
    element.icon.innerHTML = nodeIcon(node, this.store);
    element.icon.className = `node-icon kind-${node.kind}`;
    highlight(element.label, node.label, needle);
    setText(element.detail, node.detail ?? '');
    toggleClass(element.root, 'selected', index === this.selected);
    const shown = node.varIndex !== undefined && displayed.has(node.varIndex);
    toggleClass(element.root, 'shown', shown);
    element.root.title = nodeTitle(node, this.store, shown);
    element.root.setAttribute('aria-expanded', entry.expandable ? String(entry.expanded) : 'false');
  }

  private entryAt(event: Event): { entry: FlatTreeNode; index: number } | undefined {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.tree-row');
    const index = row?.dataset.index ? Number(row.dataset.index) : -1;
    const entry = this.flat[index];
    return entry ? { entry, index } : undefined;
  }

  private onClick(event: MouseEvent): void {
    const hit = this.entryAt(event);
    if (!hit) {
      return;
    }
    this.selected = hit.index;
    const target = event.target as HTMLElement;
    if (target.closest('.node-add')) {
      this.addNode(hit.entry.node);
    } else if (target.closest('.twisty') && hit.entry.expandable) {
      this.toggle(hit.entry.node);
    }
    this.renderRows();
  }

  private onDoubleClick(event: MouseEvent): void {
    const hit = this.entryAt(event);
    if (!hit || (event.target as HTMLElement).closest('.node-add, .twisty')) {
      return;
    }
    if (hit.entry.node.kind === 'var') {
      this.addNode(hit.entry.node);
    } else {
      this.toggle(hit.entry.node);
    }
  }

  private onContextMenu(event: MouseEvent): void {
    const hit = this.entryAt(event);
    if (!hit) {
      return;
    }
    event.preventDefault();
    this.selected = hit.index;
    this.renderRows();
    const node = hit.entry.node;
    const entries: MenuEntry[] = [{ label: '添加到波形', action: () => this.addNode(node) }];
    if (node.kind === 'scope') {
      entries.push(
        { label: '逐个添加直属信号（不分组）', action: () => this.actions.addSignals(collectVarIndexes(node, false).filter((index) => !this.isMemoryWord(index))) },
        { label: '添加（含全部子模块）', action: () => this.addRecursive(node) }
      );
    }
    if (node.kind === 'array') {
      entries.push({ label: '逐个添加（不分组）', action: () => this.actions.addSignals(collectVarIndexes(node, false)) });
    }
    entries.push('separator');
    if (node.kind === 'scope' || node.kind === 'var' || node.kind === 'array') {
      entries.push({
        label: node.kind === 'scope' ? '跳转到模块源码' : '跳转到声明',
        action: () => this.host.openSource(node.path, node.kind === 'scope')
      });
    }
    entries.push({ label: '复制路径', action: () => this.host.copyText(node.path) });
    showContextMenu(event.clientX, event.clientY, entries);
  }

  private onDragStart(event: DragEvent): void {
    const hit = this.entryAt(event);
    if (!hit || !event.dataTransfer) {
      return;
    }
    const node = hit.entry.node;
    const payload = this.addPayload(node);
    if (!payload.vars.length) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(signalDragType, encodeSignalDrag(payload));
    event.dataTransfer.setData('text/plain', node.path);
  }

  private onKeyDown(event: KeyboardEvent): void {
    const entry = this.flat[this.selected];
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) {
      // The tree owns these keys; keep them away from the waveform shortcuts.
      event.stopPropagation();
    }
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        this.moveSelection(this.selected + (event.key === 'ArrowDown' ? 1 : -1));
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (entry?.expandable && !entry.expanded) {
          this.toggle(entry.node);
        } else {
          this.moveSelection(this.selected + 1);
        }
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (entry?.expandable && entry.expanded) {
          this.toggle(entry.node);
        } else if (entry) {
          for (let index = this.selected - 1; index >= 0; index--) {
            if (this.flat[index].depth < entry.depth) {
              this.moveSelection(index);
              break;
            }
          }
        }
        return;
      case 'Enter':
        event.preventDefault();
        this.addNode(entry?.node);
        return;
      default:
        return;
    }
  }

  private moveSelection(index: number): void {
    if (!this.flat.length) {
      return;
    }
    this.selected = Math.max(0, Math.min(this.flat.length - 1, index));
    const top = this.selected * treeRowHeight;
    if (top < this.list.scrollTop) {
      this.list.scrollTop = top;
    } else if (top + treeRowHeight > this.list.scrollTop + this.list.clientHeight) {
      this.list.scrollTop = top + treeRowHeight - this.list.clientHeight;
    }
    this.renderRows();
  }

  private toggle(node: TreeNode): void {
    if (this.expanded.has(node.id)) {
      this.expanded.delete(node.id);
    } else {
      this.expanded.add(node.id);
    }
    this.rebuild();
  }

  private addPayload(node: TreeNode): { vars: number[]; group?: string } {
    switch (node.kind) {
      case 'var':
        return { vars: [node.varIndex!] };
      case 'array':
        return { vars: collectVarIndexes(node, false), group: node.label };
      case 'params':
        return { vars: collectVarIndexes(node, false) };
      case 'scope': {
        const vars = node.children.filter((child) => child.kind === 'var').map((child) => child.varIndex!);
        return vars.length > 1 ? { vars, group: node.label } : { vars };
      }
    }
  }

  private addNode(node: TreeNode | undefined): void {
    if (!node) {
      return;
    }
    const payload = this.addPayload(node);
    if (!payload.vars.length) {
      this.notify(`${node.label} 下没有可直接添加的信号，请展开后选择子模块`);
      return;
    }
    if (payload.group) {
      this.actions.addGroup(payload.group, payload.vars);
    } else {
      this.actions.addSignals(payload.vars);
    }
    this.renderRows();
  }

  private addRecursive(node: TreeNode): void {
    const all = collectVarIndexes(node, true).filter((index) => !this.isMemoryWord(index));
    const vars = all.slice(0, maximumRecursiveSignals);
    this.actions.addGroup(node.label, vars);
    if (all.length > vars.length) {
      this.notify(`信号过多，只添加了前 ${vars.length} 个（共 ${all.length} 个）`);
    }
  }

  private isMemoryWord(varIndex: number): boolean {
    return /\[-?\d+\]$/.test(this.store.data?.vars[varIndex]?.name ?? '');
  }
}

function nodeIcon(node: TreeNode, store: WaveStore): string {
  switch (node.kind) {
    case 'scope':
      return icons.module;
    case 'array':
      return icons.array;
    case 'params':
      return icons.parameter;
    case 'var': {
      const kind = store.data?.vars[node.varIndex!]?.kind ?? '';
      if (kind === 'parameter' || kind === 'localparam') {
        return icons.parameter;
      }
      return kind === 'wire' || kind === 'tri' ? icons.wire : icons.register;
    }
  }
}

function nodeTitle(node: TreeNode, store: WaveStore, shown: boolean): string {
  if (node.kind === 'var') {
    const variable = store.data?.vars[node.varIndex!];
    const kind = variable ? `${variable.kind}，${variable.width} 位` : '';
    return `${node.path}\n${kind}${shown ? '\n已在波形中' : ''}`;
  }
  if (node.kind === 'array') {
    return `${node.path}\n存储器（逐字记录），点击 + 作为分组添加`;
  }
  if (node.kind === 'params') {
    return '参数（常量），点击 + 全部添加';
  }
  return `${node.path}\n点击 + 将直属信号作为分组添加`;
}

/** Render `text` with the first case-insensitive occurrence of `needle` emphasized. */
function highlight(element: HTMLElement, text: string, needle: string): void {
  const position = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (position < 0) {
    if (element.childElementCount || element.textContent !== text) {
      element.textContent = text;
    }
    return;
  }
  element.replaceChildren(
    text.slice(0, position),
    h('mark', { text: text.slice(position, position + needle.length) }),
    text.slice(position + needle.length)
  );
}
