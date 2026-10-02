// @index mips-debug — Safe DOM construction and accessible reusable workbench controls
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className = '', text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function text(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

export function button(label: string, action: () => void, title = label, className = ''): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.title = title;
  node.addEventListener('click', action);
  return node;
}

export function select(label: string, options: readonly [string, string][], action: (value: string) => void): HTMLSelectElement {
  const node = el('select');
  node.setAttribute('aria-label', label);
  for (const [value, name] of options) {
    const option = el('option', '', name);
    option.value = value;
    node.append(option);
  }
  node.addEventListener('change', () => action(node.value));
  return node;
}

export function table(headers: readonly string[]): { table: HTMLTableElement; body: HTMLTableSectionElement } {
  const node = el('table');
  const head = el('thead');
  const row = el('tr');
  for (const name of headers) {
    const cell = el('th', '', name);
    cell.scope = 'col';
    row.append(cell);
  }
  head.append(row);
  const body = el('tbody');
  node.append(head, body);
  return { table: node, body };
}

export function empty(title: string, description: string): HTMLElement {
  const node = el('div', 'empty-state');
  node.append(el('strong', '', title), el('p', '', description));
  return node;
}

/** Reconcile by key; existing interactive nodes survive frequent execution updates. */
export function reconcile<T>(parent: HTMLElement, items: readonly T[], key: (item: T) => string,
  create: (item: T) => HTMLElement, update: (node: HTMLElement, item: T) => void): void {
  const previous = new Map(Array.from(parent.children).map(node => [(node as HTMLElement).dataset.key, node as HTMLElement]));
  let cursor: ChildNode | null = parent.firstChild;
  for (const item of items) {
    const id = key(item);
    const node = previous.get(id) ?? create(item);
    node.dataset.key = id;
    update(node, item);
    if (node !== cursor) parent.insertBefore(node, cursor);
    cursor = node.nextSibling;
    previous.delete(id);
  }
  for (const node of previous.values()) node.remove();
}
