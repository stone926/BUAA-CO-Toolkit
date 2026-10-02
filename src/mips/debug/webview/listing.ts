// @index mips-debug — Bounded instruction listing, current PC and source/breakpoint navigation
import type { WorkbenchRequest, WorkbenchState } from '../protocol';
import { button, el, empty, reconcile, table, text } from './dom';
import { hex } from './format';

export class Listing {
  readonly element = el('section', 'listing-pane pane');
  private readonly body: HTMLTableSectionElement;
  private readonly range = el('span', 'muted');
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly follow: HTMLButtonElement;
  private readonly hint = empty('从第一条指令开始', '在编辑器中打开 MIPS 源文件，点击「汇编」。在左侧圆点设置断点，然后运行或单步观察。');
  private state?: WorkbenchState;
  private pageSize = 1;
  constructor(private readonly send: (request: WorkbenchRequest) => void) {
    const header = el('header', 'pane-header');
    const title = el('div', 'pane-title');
    title.append(el('h2', '', '指令'), el('span', 'subtle', 'TEXT SEGMENT'));
    this.follow = button('定位 PC', () => this.locatePc(), '定位当前程序计数器');
    header.append(title, this.follow);
    const content = el('div', 'table-scroll listing-scroll');
    const listing = table(['断点', '地址', '机器码', '基本指令', '源代码']);
    listing.table.classList.add('listing-table');
    this.body = listing.body;
    content.append(listing.table, this.hint);
    const footer = el('footer', 'pane-footer');
    this.previous = button('← 上一页', () => {
      if (this.state) send({ type: 'listing', offset: Math.max(0, this.state.instructionOffset - this.pageSize) });
    });
    this.next = button('下一页 →', () => {
      if (this.state) send({ type: 'listing', offset: this.state.instructionOffset + this.state.instructions.length });
    });
    footer.append(this.range, this.previous, this.next);
    this.element.append(header, content, footer);
  }
  update(state: WorkbenchState): void {
    this.state = state;
    this.pageSize = Math.max(this.pageSize, state.instructions.length);
    this.hint.hidden = state.instructionCount > 0;
    this.previous.disabled = state.instructionOffset === 0;
    this.next.disabled = state.instructionOffset + state.instructions.length >= state.instructionCount;
    this.follow.disabled = state.pc === undefined;
    text(this.range, state.instructionCount ? `${state.instructionOffset + 1}–${state.instructionOffset + state.instructions.length} / ${state.instructionCount} 条` : '尚未汇编');
    const breaks = new Set(state.breakpoints);
    reconcile(this.body, state.instructions, item => String(item.address), item => {
      const row = el('tr');
      const breakpoint = el('td', 'breakpoint-cell');
      breakpoint.append(button('○', () => this.send({ type: 'breakpoint', address: item.address }), '', 'breakpoint'));
      const source = el('td', 'source-cell');
      const sourceButton = button('', () => this.send({ type: 'source', address: item.address }), '', 'source-link');
      sourceButton.append(el('span', 'source-line'), el('span', 'source-code'));
      source.append(sourceButton);
      row.append(breakpoint, el('td', 'mono address'), el('td', 'mono word'), el('td', 'mono instruction'), source);
      return row;
    }, (row, item) => {
      row.classList.toggle('current-instruction', state.pc === item.address);
      row.setAttribute('aria-current', state.pc === item.address ? 'step' : 'false');
      const cells = row.children;
      const breakpoint = cells[0].firstElementChild as HTMLButtonElement;
      text(breakpoint, breaks.has(item.address) ? '●' : '○');
      breakpoint.classList.toggle('set', breaks.has(item.address));
      breakpoint.setAttribute('aria-pressed', String(breaks.has(item.address)));
      breakpoint.setAttribute('aria-label', `${breaks.has(item.address) ? '移除' : '设置'} ${hex(item.address)} 断点`);
      text(cells[1] as HTMLElement, hex(item.address));
      text(cells[2] as HTMLElement, hex(item.word).slice(2));
      text(cells[3] as HTMLElement, item.instruction);
      const source = cells[4].firstElementChild as HTMLButtonElement;
      source.disabled = !item.source;
      text(source.children[0] as HTMLElement, item.source ? `${item.source.line}: ` : '');
      text(source.children[1] as HTMLElement, item.source?.text ?? '—');
      source.title = item.source ? `打开 ${item.source.name}:${item.source.line}` : '无源代码映射';
    });
  }
  private locatePc(): void {
    if (this.state?.pc === undefined) return;
    const index = this.state.instructions.findIndex(item => item.address === this.state!.pc);
    if (index >= 0) this.body.children[index].scrollIntoView({ block: 'center', behavior: 'smooth' });
    else this.send({ type: 'listing', offset: this.state.instructionOffset, address: this.state.pc });
  }
}
