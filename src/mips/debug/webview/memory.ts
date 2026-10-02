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
  private readonly go: HTMLButtonElement;
  private readonly range = el('span', 'muted');
  private readonly notice = el('span', 'muted memory-notice');
  private readonly hint = empty('查看数据与栈', '汇编后可按内存区域或地址查看。每行一个 32 位字，字节和 ASCII 按小端顺序排列。');
  private state?: WorkbenchState;
  private regionKey = '';
  private readonly scroll = el('div', 'table-scroll');
  private requestedAddress?: number;
  private addressEdited = false;
  constructor(private readonly send: (request: WorkbenchRequest) => void) {
    const toolbar = el('form', 'panel-toolbar memory-toolbar');
    this.region = select('内存区域', [['', '选择区域']], value => { if (value) this.navigate(Number(value)); });
    this.address.type = 'text';
    this.address.placeholder = '0x10010000';
    this.address.setAttribute('aria-label', '内存地址（十六进制或十进制，四字节对齐）');
    this.address.setAttribute('aria-describedby', 'memory-address-error');
    this.error.id = 'memory-address-error';
    this.error.setAttribute('role', 'status');
    this.address.addEventListener('input', () => { this.addressEdited = true; });
    this.go = button('转到', () => toolbar.requestSubmit(), '读取指定地址开始的 64 个字（256 字节）');
    toolbar.addEventListener('submit', event => {
      event.preventDefault();
      const address = parseAddress(this.address.value);
      const invalid = address === undefined || address > 0xffffff00;
      this.address.setAttribute('aria-invalid', String(invalid));
      text(this.error, invalid ? '请输入 0–0xffffff00 范围内、四字节对齐的页起始地址。' : '');
      if (!invalid && address !== undefined) this.navigate(address);
    });
    toolbar.append(this.region, this.address, this.go, el('span', 'subtle', '每页 256 字节 · 小端序'), this.error);
    const memory = table(['地址', '32 位字', '+0  +1  +2  +3', 'ASCII']);
    memory.table.classList.add('memory-table', 'mono');
    this.body = memory.body;
    this.scroll.append(memory.table, this.hint);
    const footer = el('footer', 'pane-footer');
    this.previous = button('← 上一页', () => this.page(-1));
    this.next = button('下一页 →', () => this.page(1));
    this.notice.setAttribute('role', 'status');
    footer.append(this.range, this.previous, this.next);
    this.element.append(toolbar, this.notice, this.scroll, footer);
  }
  reveal(focus = false): void {
    this.scroll.scrollTop = 0;
    if (focus) this.scroll.focus({ preventScroll: true });
  }
  update(state: WorkbenchState): void {
    const addressChanged = this.state?.memoryAddress !== state.memoryAddress;
    this.state = state;
    const arrived = this.requestedAddress === state.memoryAddress;
    if ((arrived || addressChanged) && !this.addressEdited) {
      this.address.value = hex(state.memoryAddress);
      this.addressEdited = false;
    }
    if (addressChanged || arrived) this.reveal();
    if (arrived) this.requestedAddress = undefined;
    const available = state.memoryAvailable;
    if (!available) this.requestedAddress = undefined;
    this.go.disabled = this.region.disabled = this.address.disabled = !available;
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
    this.previous.disabled = !available || !state.memory.length || state.memoryAddress < state.memory.length * 4;
    this.next.disabled = !available || !state.memory.length || state.memoryAddress + state.memory.length * 4 > 0xffffff00;
    text(this.notice, this.requestedAddress !== undefined ? `正在读取 ${hex(this.requestedAddress)}…`
      : !available ? (state.status === 'stopped' ? '已停止，当前显示最后一次快照。重置后可切换内存页。' : '汇编并载入程序后可查看内存。')
      : state.memory.length && state.memory.every(word => word.value === undefined) ? '当前页没有已映射的内存。可选择数据段、堆或栈区域。' : '');
    this.notice.hidden = !this.notice.textContent;
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
    const address = (this.requestedAddress ?? this.state.memoryAddress) + direction * this.state.memory.length * 4;
    if (address >= 0 && address <= 0xffffff00) this.navigate(address);
  }
  private navigate(address: number): void {
    if (!this.state || this.go.disabled) return;
    this.requestedAddress = address;
    this.addressEdited = false;
    this.address.setAttribute('aria-invalid', 'false');
    text(this.error, '');
    // Keep the region control tied to the displayed page until the Worker replies.
    this.region.value = this.state.memoryRegions.some(region => region.address === this.state!.memoryAddress) ? String(this.state.memoryAddress) : '';
    text(this.notice, `正在读取 ${hex(address)}…`);
    this.notice.hidden = false;
    this.send({ type: 'memory', address });
  }
}
