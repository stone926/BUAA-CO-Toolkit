// @index mips-debug — Stable GPR/FPU/CP0 tables with radix switching and changed-value indicators
import type { WorkbenchRegister, WorkbenchState } from '../protocol';
import { el, empty, reconcile, select, table, text } from './dom';
import { formatValue, type Radix } from './format';
import { Tabs } from './tabs';

export class Registers {
  readonly element = el('section', 'register-pane pane');
  private radix: Radix = 'hex';
  private state?: WorkbenchState;
  private readonly bodies = new Map<string, HTMLTableSectionElement>();
  private readonly hints = new Map<string, HTMLElement>();
  constructor() {
    const header = el('header', 'pane-header');
    const title = el('div', 'pane-title');
    title.append(el('h2', '', '寄存器'), el('span', 'subtle', 'CPU STATE'));
    const radix = select('寄存器数值进制', [['hex', '十六进制'], ['decimal', '有符号十进制']], value => {
      this.radix = value as Radix;
      if (this.state) this.update(this.state);
    });
    header.append(title, radix);
    const tabs = new Tabs('寄存器组');
    this.element.append(header, tabs.element);
    for (const [id, name] of [['gpr', '通用 GPR'], ['fpu', '浮点 FPU'], ['cp0', '系统 CP0']]) {
      const panel = el('div', 'register-content table-scroll');
      const registers = table(['寄存器', '当前值']);
      this.bodies.set(id, registers.body);
      const hint = empty('等待 CPU 状态', id === 'fpu' ? '普通 MARS 模式下可观察浮点寄存器。' : id === 'cp0' ? 'P7 中可观察 Status、Cause 和 EPC。' : '汇编后将显示通用寄存器、HI 和 LO。');
      this.hints.set(id, hint);
      panel.append(registers.table, hint);
      tabs.add(id, name, panel);
      this.element.append(panel);
    }
    const legend = el('footer', 'register-legend');
    legend.append(el('span', 'change-marker', '◆'), el('span', '', '最近一次执行后变化的值'));
    this.element.append(legend);
  }
  update(state: WorkbenchState): void {
    this.state = state;
    for (const [id, values] of [['gpr', state.registers], ['fpu', state.floatingPoint], ['cp0', state.cp0]] as const) {
      this.hints.get(id)!.hidden = values.length > 0;
      reconcile(this.bodies.get(id)!, values, item => item.name, () => {
        const row = el('tr');
        const value = el('td', 'mono register-value');
        value.append(el('span', 'change-marker', '◆ '), el('span'));
        row.append(el('td', 'mono register-name'), value);
        return row;
      }, (row, item: WorkbenchRegister) => {
        row.classList.toggle('changed', item.changed);
        text(row.children[0] as HTMLElement, item.name);
        const value = row.children[1];
        (value.children[0] as HTMLElement).hidden = !item.changed;
        text(value.children[1] as HTMLElement, formatValue(item.value, this.radix));
        row.title = item.detail ?? '';
      });
    }
  }
}
