// @index mips-debug — Bounded memory inspector with address validation, region navigation and little-endian bytes
import type { WorkbenchRequest, WorkbenchState } from '../protocol';
import { button, el, empty, reconcile, select, table, text } from './dom';
import { ascii, bytes, hex, parseAddress } from './format';

export class MemoryView {
  readonly element = el('section', 'memory-panel');
  private readonly address = el('input');
  private readonly region: HTMLSelectElement;
  private readonly error = el('span', 'address-error');
  private readonly body: HTMLTableSectionElement;
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly range = el('span', 'muted');
  private readonly hint = empty('查看数据与栈', '汇编后可按内存区域或地址查看。每行一个 32 位字，字节和 ASCII 按小端顺序排列。');
  private state?: WorkbenchState;
  private regionKey = '';
  constructor(private readonly send: (request: WorkbenchRequest) => void) {
    const toolbar = el('form', 'panel-toolbar memory-toolbar');
    this.region = select('内存区域', [['', '选择区域']], value => { if (value) send({ type: 'memory', address: Number(value) }); });
    this.address.type = 'text';
    this.address.placeholder = '0x10010000';
    this.address.setAttribute('aria-label', '内存地址（十六进制或十进制，四字节对齐）');
    this.address.setAttribute('aria-describedby', 'memory-address-error');
    this.error.id = 'memory-address-error';
    this.error.setAttribute('role', 'status');
    const go = button('转到', () => toolbar.requestSubmit());
    toolbar.addEventListener('submit', event => {
      event.preventDefault();
      const address = parseAddress(this.address.value);
      const invalid = address === undefined || address > 0xffffff00;
      this.address.setAttribute('aria-invalid', String(invalid));
      text(this.error, invalid ? '请输入 0–0xffffff00 范围内、四字节对齐的页起始地址。' : '');
      if (!invalid && address !== undefined) send({ type: 'memory', address });
    });
    toolbar.append(this.region, this.address, go, el('span', 'subtle', '小端序 · 每行 4 字节'), this.error);
    const memory = table(['地址', '32 位字', '+0  +1  +2  +3', 'ASCII']);
    memory.table.classList.add('memory-table', 'mono');
    this.body = memory.body;
    const scroll = el('div', 'table-scroll');
    scroll.append(memory.table, this.hint);
    const footer = el('footer', 'pane-footer');
    this.previous = button('← 上一页', () => this.page(-1));
    this.next = button('下一页 →', () => this.page(1));
    footer.append(this.range, this.previous, this.next);
    this.element.append(toolbar, scroll, footer);
  }
  update(state: WorkbenchState): void {
    const addressChanged = this.state?.memoryAddress !== state.memoryAddress;
    this.state = state;
    if (addressChanged && document.activeElement !== this.address) this.address.value = hex(state.memoryAddress);
    this.hint.hidden = state.memory.length > 0;
    const key = state.memoryRegions.map(region => `${region.address}:${region.name}`).join('|');
    if (key !== this.regionKey) {
      this.regionKey = key;
      this.region.replaceChildren();
      const placeholder = el('option', '', '选择区域');
      placeholder.value = '';
      this.region.append(placeholder);
      for (const region of state.memoryRegions) {
        const option = el('option', '', `${region.name} · ${hex(region.address)}`);
        option.value = String(region.address);
        this.region.append(option);
      }
    }
    this.region.value = state.memoryRegions.some(region => region.address === state.memoryAddress) ? String(state.memoryAddress) : '';
    this.previous.disabled = !state.memory.length || state.memoryAddress < state.memory.length * 4;
    this.next.disabled = !state.memory.length || state.memoryAddress + state.memory.length * 4 > 0xffffff00;
    text(this.range, state.memory.length ? `${hex(state.memoryAddress)}–${hex(state.memoryAddress + (state.memory.length - 1) * 4)}` : '尚未加载');
    reconcile(this.body, state.memory, word => String(word.address), () => {
      const row = el('tr');
      row.append(el('td', 'address'), el('td'), el('td'), el('td', 'ascii'));
      return row;
    }, (row, word) => {
      row.classList.toggle('changed', word.changed === true);
      row.classList.toggle('unmapped', word.value === undefined);
      [hex(word.address), word.value === undefined ? '—' : hex(word.value), bytes(word.value), ascii(word.value)].forEach((value, i) => text(row.children[i] as HTMLElement, value));
    });
  }
  private page(direction: number): void {
    if (!this.state) return;
    const address = this.state.memoryAddress + direction * this.state.memory.length * 4;
    if (address >= 0 && address <= 0xffffff00) this.send({ type: 'memory', address });
  }
}
