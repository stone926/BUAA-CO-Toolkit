// @index mips-debug — Workbench composition, execution controls, state batching and focused keyboard shortcuts
import type { WorkbenchRequest, WorkbenchState, WorkbenchUpdate } from '../protocol';
import { button, el, select, text } from './dom';
import { hex } from './format';
import { Listing } from './listing';
import { Registers } from './registers';
import { ConsoleView } from './console';
import { MemoryView } from './memory';
import { ReferenceViews } from './reference';
import { Inspection } from './inspection';

const STATUS: Record<WorkbenchState['status'], string> = {
  empty: '准备开始', assembling: '正在汇编', paused: '已暂停', running: '运行中', input: '等待输入',
  exited: '执行结束', stopped: '已停止', error: '发生错误'
};

export class WorkbenchApp {
  private readonly title = el('h1', '', 'MARS 工作台');
  private readonly source = el('span', 'source-title', '打开源文件，汇编并观察 CPU');
  private readonly status = el('span', 'status-badge', '连接中');
  private readonly pc = el('strong', 'mono', '—');
  private readonly steps = el('strong', 'mono', '0');
  private readonly modeLabel = el('strong', '', '普通 MARS');
  private readonly message = el('div', 'status-message');
  private readonly stale = el('div', 'stale-banner');
  private readonly delay = el('span', 'delay-badge');
  private readonly assemble: HTMLButtonElement;
  private readonly run: HTMLButtonElement;
  private readonly step: HTMLButtonElement;
  private readonly reset: HTMLButtonElement;
  private readonly stop: HTMLButtonElement;
  private readonly exportButton: HTMLButtonElement;
  private readonly mode: HTMLSelectElement;
  private readonly listing: Listing;
  private readonly registers = new Registers();
  private readonly console: ConsoleView;
  private readonly memory: MemoryView;
  private readonly references: ReferenceViews;
  private readonly inspection = new Inspection();
  private state?: WorkbenchState;
  private pending?: WorkbenchState;
  private frame = 0;
  constructor(root: HTMLElement, private readonly send: (request: WorkbenchRequest) => void) {
    const app = el('main', 'workbench');
    const heading = el('header', 'workbench-heading');
    const identity = el('div', 'identity');
    const source = el('div', 'source-context');
    source.append(el('span', 'source-kind mono', 'ASM'), this.source);
    identity.append(el('span', 'app-mark mono', 'M'), this.title, source);
    heading.append(identity, this.status);
    const toolbar = el('div', 'execution-toolbar');
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', '程序执行');
    this.assemble = button('汇编', () => send({ type: 'assemble' }), '汇编当前源文件', 'assemble-control');
    this.run = button('▶ 运行', () => this.runOrPause(), '运行 / 暂停（F5）', 'run-control');
    this.step = button('单步 →', () => this.execute('step'), '执行一条基本指令（F10）');
    this.reset = button('↺ 重置', () => this.execute('reset'), '重置 CPU 和内存，保留断点');
    this.stop = button('■ 停止', () => this.execute('stop'), '停止执行（Shift+F5）', 'stop-control');
    this.exportButton = button('导出机器码', () => this.execute('export'), '导出已汇编的机器码', 'export-control');
    this.mode = select('执行模式', [['mars', '普通 MARS'], ['P3', '课程 P3'], ['P4', '课程 P4'], ['P5', '课程 P5'], ['P6', '课程 P6'], ['P7', '课程 P7']], value => send({ type: 'mode', mode: value }));
    const modeGroup = el('label', 'mode-control');
    modeGroup.append(el('span', 'muted', '执行模式'), this.mode);
    const execution = el('div', 'command-group execution-group');
    execution.append(this.run, this.step);
    const session = el('div', 'command-group session-group');
    session.append(this.reset, this.stop);
    toolbar.append(this.assemble, execution, session, el('span', 'toolbar-spacer'), modeGroup, this.exportButton);
    const summary = el('div', 'summary');
    summary.append(this.metric('PC', this.pc, 'metric-pc'), this.metric('已执行', this.steps), this.metric('模式', this.modeLabel, 'metric-mode'), this.delay);
    this.message.setAttribute('role', 'status');
    this.message.setAttribute('aria-live', 'polite');
    const context = el('div', 'session-context');
    context.append(summary, this.message);
    this.stale.append(el('span', '', '源文件已修改。重新汇编后，调试状态将与最新代码同步。'), button('重新汇编', () => send({ type: 'assemble' })));
    this.stale.hidden = true;
    this.listing = new Listing(send);
    const middle = el('div', 'cpu-layout');
    middle.append(this.listing.element, this.registers.element);
    this.console = new ConsoleView(send);
    this.memory = new MemoryView(send);
    this.references = new ReferenceViews(request => {
      if (request.type === 'listing' && request.address !== undefined) {
        this.inspection.close(false);
        this.listing.revealAddress(request.address);
        this.listing.focus();
        this.listing.element.scrollIntoView({ block: 'nearest' });
      } else {
        if (request.type === 'memory') {
          this.inspection.activate('memory');
          this.memory.reveal(true);
        }
        send(request);
      }
    });
    for (const [id, name, panel] of [
      ['console', '控制台', this.console.element], ['memory', '内存', this.memory.element],
      ['symbols', '符号', this.references.symbols], ['syscalls', '系统服务', this.references.syscalls]
    ] as const) {
      this.inspection.add(id, name, panel);
    }
    const help = el('details', 'workbench-help');
    help.append(el('summary', '', '初次使用 · 操作提示'), el('p', '', '1. 打开 MIPS 源文件并汇编。 2. 点击指令旁的圆点设置断点。 3. 运行至断点或逐条执行，观察高亮寄存器和内存。点击源代码可返回编辑器。'), el('p', '', '工作台获得焦点时：F5 运行 / 暂停 · F10 单步 · Shift+F5 停止。寄存器的十进制视图按有符号 32 位整数显示；浮点页显示原始位模式。'));
    help.append(el('p', '', '课程 P3–P7 模式用于观察逐条指令的体系结构状态，不模拟流水线周期、Timer 计时或外部中断。P7 的 syscall 进入 0x00004180 内核异常处理程序。'));
    const footer = el('footer', 'workbench-footer');
    const shortcuts = el('span', 'keyboard-shortcuts');
    for (const [key, label] of [['F5', '运行 / 暂停'], ['F10', '单步'], ['Shift+F5', '停止']]) {
      const shortcut = el('span');
      shortcut.append(el('kbd', '', key), el('span', '', label));
      shortcuts.append(shortcut);
    }
    footer.append(el('span', 'engine-label', 'BUAA CO · 内置 MIPS 引擎'), shortcuts);
    const footnotes = el('div', 'workbench-footnotes');
    footnotes.append(help, footer);
    app.append(heading, toolbar, context, this.stale, middle, this.inspection.element, footnotes);
    root.replaceChildren(app);
    this.setDisconnected();
    window.addEventListener('message', event => {
      const update = event.data as Partial<WorkbenchUpdate> | undefined;
      if (update?.type === 'state' && update.state) this.schedule(update.state);
    });
    window.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      if (event.key === 'F5') {
        event.preventDefault();
        if (event.shiftKey) this.execute('stop'); else this.runOrPause();
      } else if (event.key === 'F10' && !event.shiftKey) {
        event.preventDefault(); this.execute('step');
      }
    });
    send({ type: 'ready' });
  }
  private metric(label: string, value: HTMLElement, className = ''): HTMLElement {
    const metric = el('div', `metric ${className}`);
    metric.append(el('span', 'muted', label), value);
    return metric;
  }
  private setDisconnected(): void {
    for (const control of [this.assemble, this.run, this.step, this.reset, this.stop, this.exportButton, this.mode]) control.disabled = true;
  }
  private schedule(state: WorkbenchState): void {
    this.pending = state;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const next = this.pending!;
      this.pending = undefined;
      this.update(next);
    });
  }
  private update(state: WorkbenchState): void {
    const wasInput = this.state?.status === 'input';
    this.state = state;
    const busy = state.status === 'running' || state.status === 'assembling' || state.status === 'input';
    const assembled = state.instructionCount > 0;
    this.assemble.classList.toggle('primary', !assembled);
    this.run.classList.toggle('primary', assembled);
    this.assemble.disabled = busy;
    this.mode.disabled = busy;
    this.run.disabled = !assembled || !['paused', 'running'].includes(state.status);
    this.step.disabled = !assembled || state.status !== 'paused';
    this.reset.disabled = !assembled || state.status === 'assembling';
    this.stop.disabled = !['running', 'paused', 'input'].includes(state.status);
    this.exportButton.disabled = !assembled || state.status === 'assembling';
    text(this.run, state.status === 'running' ? 'Ⅱ 暂停' : '▶ 运行');
    text(this.source, state.title || '打开源文件，汇编并观察 CPU');
    this.source.title = state.title;
    text(this.status, STATUS[state.status]);
    this.status.dataset.status = state.status;
    text(this.pc, state.pc === undefined ? '—' : hex(state.pc));
    text(this.steps, state.steps.toLocaleString());
    text(this.modeLabel, state.modeLabel);
    if (this.mode.value !== state.mode) this.mode.value = state.mode;
    text(this.message, state.message);
    this.message.hidden = !state.message;
    this.message.classList.toggle('error-message', state.status === 'error');
    this.stale.hidden = !state.sourceChanged;
    this.stale.querySelector('button')!.disabled = busy;
    this.delay.hidden = !state.delaySlot;
    text(this.delay, '延迟槽');
    // Set the final layout before measuring the listing for PC following.
    if (state.status === 'input' && !wasInput) this.inspection.activate('console');
    this.listing.update(state);
    this.registers.update(state);
    this.console.update(state);
    this.memory.update(state);
    this.references.update(state);
    if (state.status === 'input' && !wasInput) this.console.focusInput();
  }
  private runOrPause(): void {
    if (this.run.disabled) return;
    this.send({ type: this.state?.status === 'running' ? 'pause' : 'run' });
  }
  private execute(action: 'step' | 'reset' | 'stop' | 'export'): void {
    const control = { step: this.step, reset: this.reset, stop: this.stop, export: this.exportButton }[action];
    if (!control.disabled) this.send({ type: action });
  }
}
