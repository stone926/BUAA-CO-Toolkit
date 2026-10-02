// @index mips-debug — Incremental console output and stable interactive stdin/EOF controls
import type { WorkbenchRequest, WorkbenchState } from '../protocol';
import { button, el, text } from './dom';

export class ConsoleView {
  readonly element = el('section', 'console-panel');
  private readonly output = el('pre', 'console-output');
  private readonly form = el('form', 'console-input');
  private readonly prompt = el('label', 'input-prompt');
  private readonly input = el('input');
  private readonly sendButton: HTMLButtonElement;
  private readonly eof: HTMLButtonElement;
  private readonly stateLabel = el('span', 'muted console-state');
  private waiting = false;
  constructor(send: (request: WorkbenchRequest) => void) {
    const toolbar = el('div', 'panel-toolbar');
    toolbar.append(this.stateLabel, button('清空输出', () => send({ type: 'clearConsole' })));
    this.output.setAttribute('role', 'log');
    this.output.setAttribute('aria-label', '程序控制台输出');
    this.output.setAttribute('aria-live', 'off');
    this.output.tabIndex = 0;
    this.input.id = 'console-stdin';
    this.input.type = 'text';
    this.input.autocomplete = 'off';
    this.input.maxLength = 16383;
    this.input.spellcheck = false;
    this.input.placeholder = '输入内容，按 Enter 发送';
    this.prompt.htmlFor = this.input.id;
    this.sendButton = button('发送 ↵', () => this.form.requestSubmit(), '发送输入（Enter）', 'primary');
    this.eof = button('结束输入', () => send({ type: 'eof' }), '发送 EOF，结束标准输入');
    this.form.append(this.prompt, this.input, this.sendButton, this.eof);
    this.form.addEventListener('submit', event => {
      event.preventDefault();
      if (!this.waiting) return;
      send({ type: 'input', text: this.input.value });
      this.input.value = '';
    });
    this.element.append(toolbar, this.output, this.form);
  }
  update(state: WorkbenchState): void {
    const nearBottom = this.output.scrollHeight - this.output.scrollTop - this.output.clientHeight < 48;
    text(this.output, state.console || '程序输出将显示在这里。');
    this.output.classList.toggle('empty-output', !state.console);
    if (nearBottom) this.output.scrollTop = this.output.scrollHeight;
    this.waiting = state.status === 'input';
    this.input.disabled = !this.waiting;
    this.sendButton.disabled = !this.waiting;
    this.eof.disabled = !this.waiting;
    text(this.prompt, this.waiting ? state.inputPrompt || '程序正在等待输入' : '标准输入');
    text(this.stateLabel, this.waiting ? '等待输入 · 输入后继续执行' : '标准输出 / 标准错误');
    this.element.classList.toggle('waiting-input', this.waiting);
  }
}
