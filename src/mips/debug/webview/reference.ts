// @index mips-debug — Searchable canonical syscall reference and symbol navigation with P7 exception guidance
import type { WorkbenchRequest, WorkbenchState, WorkbenchSyscall } from '../protocol';
import { button, el, empty, reconcile, table, text } from './dom';
import { hex } from './format';

export class ReferenceViews {
  readonly symbols = el('section', 'symbols-panel');
  readonly syscalls = el('section', 'syscalls-panel');
  private readonly symbolBody: HTMLTableSectionElement;
  private readonly symbolHint = empty('源程序的符号', '汇编后显示标签与 .eqv 常量。点击标签地址可定位指令或内存。');
  private readonly search = el('input');
  private readonly syscallBody: HTMLTableSectionElement;
  private readonly trap = el('div', 'info-card');
  private readonly intro = el('div', 'reference-intro');
  private readonly course = el('div', 'info-card');
  private readonly syscallToolbar = el('div', 'panel-toolbar');
  private readonly syscallScroll = el('div', 'table-scroll syscall-scroll');
  private readonly count = el('span', 'muted');
  private readonly noMatches = empty('没有匹配的服务', '可以搜索服务号、名称、类别或参数。');
  private state?: WorkbenchState;
  constructor(private readonly send: (request: WorkbenchRequest) => void) {
    const symbols = table(['符号', '地址或值', '段']);
    this.symbolBody = symbols.body;
    const symbolScroll = el('div', 'table-scroll');
    symbolScroll.append(symbols.table, this.symbolHint);
    this.symbols.append(symbolScroll);
    this.trap.append(el('strong', '', 'P7 · syscall 是异常入口'), el('p', '', '执行 syscall 将产生 Sys 异常（ExcCode=8）并跳转到 0x00004180，由你的内核异常处理程序处理。检查 CP0 的 Cause、EPC 和 Status，以及延迟槽状态；普通 MARS 的服务号在此模式下不执行。'));
    this.intro.append(el('strong', '', '普通 MARS · 系统服务'), el('p', '', '将服务号写入 $v0，并按参数约定准备寄存器，然后执行 syscall。下表直接反映内置引擎的支持情况。'));
    this.trap.append(el('p', '', '工作台观察指令的体系结构状态，不模拟流水线周期、Timer 计时或外部中断。'));
    this.course.append(el('strong', '', '课程模式 · 按课程指令集执行'), el('p', '', '课程 P3–P6 不执行普通 MARS 的系统服务。工作台逐条观察指令的体系结构状态，不模拟流水线周期、Timer 计时或外部中断。'));
    this.search.type = 'search';
    this.search.placeholder = '搜索服务号、名称、参数…';
    this.search.setAttribute('aria-label', '搜索系统服务');
    this.search.addEventListener('input', () => this.updateSyscalls());
    this.syscallToolbar.append(this.search, this.count);
    const syscall = table(['服务', '参数 / 返回值', '说明', '支持']);
    this.syscallBody = syscall.body;
    this.syscallScroll.append(syscall.table, this.noMatches);
    this.syscalls.append(this.trap, this.course, this.intro, this.syscallToolbar, this.syscallScroll);
  }
  update(state: WorkbenchState): void {
    this.state = state;
    this.symbolHint.hidden = state.symbols.length > 0;
    reconcile(this.symbolBody, state.symbols, symbol => symbol.name, symbol => {
      const row = el('tr');
      const address = el('td');
      const link = button('', () => {
        const current = this.state?.symbols.find(value => value.name === symbol.name);
        if (!current || current.kind === 'eqv') return;
        if (current.segment?.toLowerCase().includes('text')) this.send({ type: 'listing', offset: this.state?.instructionOffset ?? 0, address: current.value });
        else this.send({ type: 'memory', address: current.value - current.value % 4 });
      }, '', 'source-link mono');
      address.append(link);
      row.append(el('td', 'mono'), address, el('td', 'muted'));
      return row;
    }, (row, symbol) => {
      text(row.children[0] as HTMLElement, symbol.name);
      const link = row.children[1].firstElementChild as HTMLButtonElement;
      text(link, hex(symbol.value));
      link.disabled = symbol.kind === 'eqv';
      link.classList.toggle('symbol-constant', symbol.kind === 'eqv');
      link.title = symbol.kind === 'eqv' ? `${symbol.name} 的常量值` : `定位 ${symbol.name}`;
      text(row.children[2] as HTMLElement, symbol.kind === 'eqv' ? '.eqv' : symbol.segment ?? '—');
    });
    this.trap.hidden = state.mode !== 'P7';
    this.course.hidden = state.mode === 'mars' || state.mode === 'P7';
    this.intro.hidden = state.mode !== 'mars';
    this.syscallToolbar.hidden = state.mode !== 'mars';
    this.syscallScroll.hidden = state.mode !== 'mars';
    this.updateSyscalls();
  }
  private updateSyscalls(): void {
    if (!this.state) return;
    const query = this.search.value.trim().toLowerCase();
    const services = this.state.syscalls.filter(service => `${service.code} ${service.name} ${service.parameters} ${service.returns} ${service.description} ${service.category}`.toLowerCase().includes(query));
    text(this.count, `${services.length} / ${this.state.syscalls.length} 项服务`);
    this.noMatches.hidden = services.length > 0;
    reconcile(this.syscallBody, services, service => String(service.code), () => {
      const row = el('tr');
      const name = el('td');
      name.append(el('strong'), el('div', 'subtle'));
      const args = el('td');
      args.append(el('div', 'mono'), el('div', 'subtle mono'));
      row.append(name, args, el('td'), el('td'));
      return row;
    }, (row, service: WorkbenchSyscall) => {
      text(row.children[0].children[0] as HTMLElement, `${service.code} · ${service.name}`);
      text(row.children[0].children[1] as HTMLElement, service.category);
      text(row.children[1].children[0] as HTMLElement, service.parameters || '无参数');
      text(row.children[1].children[1] as HTMLElement, `返回：${service.returns || '无'}`);
      text(row.children[2] as HTMLElement, service.description);
      const support = row.children[3] as HTMLElement;
      text(support, service.supported ? '✓ 已支持' : '— 不支持');
      support.className = service.supported ? 'supported' : 'muted';
    });
  }
}
