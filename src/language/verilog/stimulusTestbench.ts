// @index verilog-stimulus-testbench — 为独立模块渲染可编辑的激励 testbench 骨架：输入初始化、时钟/复位、$monitor 与激励区
import { renderResourceTemplate } from '../../templates/templateRegistry';
import { VerilogDecl, VerilogModule } from './model';
import { lineList, separatedBlock } from './moduleUtils';

const clockPortNames = new Set(['clk', 'clock']);
const activeHighResetPortNames = new Set(['reset', 'rst', 'clr', 'clear']);
const activeLowResetPortNames = new Set(['reset_n', 'rst_n', 'resetn', 'rstn', 'nreset', 'nrst', 'clr_n', 'clrn']);
const clockHalfPeriodNs = 5;
const resetHoldNs = 20;
/** Narrow control fields (for example a 3-bit ALUOp) read better in binary. */
const binaryMonitorMaxWidth = 4;
const identifierPattern = /[A-Za-z_][A-Za-z0-9_$]*/g;

interface ResetPort {
  port: VerilogDecl;
  activeLow: boolean;
}

/**
 * Render the user-owned stimulus testbench for one design module. Unlike the
 * course CPU testbenches it has no memories or trace hooks: the student writes
 * the marked stimulus, and `$monitor` makes every non-clock change visible in
 * the text-only simulator output.
 */
export function buildStimulusTestbench(module: VerilogModule, tbName: string): string {
  const inputs = module.ports.filter(isDrivenByTestbench);
  const outputs = module.ports.filter((port) => !isDrivenByTestbench(port));
  const clock = inputs.find((port) => isSingleBit(port) && clockPortNames.has(port.name.toLowerCase()));
  const reset = findResetPort(inputs, clock);
  const dataInputs = inputs.filter((port) => port !== clock && port !== reset?.port);
  const parameters = portWidthParameters(module);
  const overrides = parameters.filter((parameter) => parameter.kind === 'parameter');

  return renderResourceTemplate('verilog/stimulus_testbench.v', {
    tbName,
    topModuleName: module.name,
    parameterBlock: separatedBlock(parameters.length ? [
      '    // 与被测模块一致的参数，可按需修改',
      ...parameters.map((parameter) => `    localparam ${parameter.name} = ${parameter.initializer?.trim()};`)
    ] : []),
    inputBlock: separatedBlock(inputs.length ? ['    // 输入', ...inputs.map((port) => declaration('reg', port))] : []),
    outputBlock: separatedBlock(outputs.length ? ['    // 输出', ...outputs.map((port) => declaration('wire', port))] : []),
    parameterOverrides: overrides.length
      ? ` #(${overrides.map((parameter) => `.${parameter.name}(${parameter.name})`).join(', ')})`
      : '',
    connections: lineList(module.ports.map((port, index) =>
      `        .${port.name}(${port.name})${index === module.ports.length - 1 ? '' : ','}`)),
    clockBlock: clock ? separatedBlock([
      `    // 时钟：周期 ${clockHalfPeriodNs * 2}ns`,
      `    always #${clockHalfPeriodNs} ${clock.name} = ~${clock.name};`
    ]) : '',
    monitorBlock: monitorBlock(module.ports.filter((port) => port !== clock), Boolean(clock)),
    stimulusBody: lineList(stimulusLines(clock, reset, dataInputs))
  });
}

function isDrivenByTestbench(port: VerilogDecl): boolean {
  return port.direction !== 'output' && port.direction !== 'inout';
}

function findResetPort(inputs: VerilogDecl[], clock: VerilogDecl | undefined): ResetPort | undefined {
  for (const port of inputs) {
    if (port === clock || !isSingleBit(port)) {
      continue;
    }
    const name = port.name.toLowerCase();
    if (activeHighResetPortNames.has(name) || activeLowResetPortNames.has(name)) {
      return { port, activeLow: activeLowResetPortNames.has(name) };
    }
  }
  return undefined;
}

function declaration(kind: 'reg' | 'wire', port: VerilogDecl): string {
  return `    ${kind} ${port.width ? `${port.width} ` : ''}${port.name};`;
}

function monitorBlock(signals: VerilogDecl[], excludesClock: boolean): string {
  if (!signals.length) {
    return '';
  }
  const format = signals
    .map((port) => `${port.name}=${(portBitWidth(port) ?? Infinity) <= binaryMonitorMaxWidth ? '%b' : '%h'}`)
    .join(' ');
  return separatedBlock([
    `    // 任一信号变化时打印一行${excludesClock ? '（不含时钟）' : ''}`,
    '    initial begin',
    `        $monitor("t=%0d ${format}", $time, ${signals.map((port) => port.name).join(', ')});`,
    '    end'
  ]);
}

function stimulusLines(clock: VerilogDecl | undefined, reset: ResetPort | undefined, dataInputs: VerilogDecl[]): string[] {
  const lines: string[] = [];
  if (clock || reset || dataInputs.length) {
    lines.push('        // 初始化输入');
    if (clock) {
      lines.push(`        ${clock.name} = 1'b0;`);
    }
    if (reset) {
      lines.push(`        ${reset.port.name} = ${reset.activeLow ? "1'b0" : "1'b1"};`);
    }
    lines.push(...dataInputs.map((port) => `        ${port.name} = 0;`), '');
  }
  if (reset) {
    lines.push(
      `        // 保持复位 ${resetHoldNs}ns 后释放`,
      `        #${resetHoldNs};`,
      `        ${reset.port.name} = ${reset.activeLow ? "1'b1" : "1'b0"};`,
      ''
    );
  }
  lines.push('        // ===== 在此编写激励：先用 #延时 推进时间，再修改输入 =====');
  if (dataInputs.length) {
    lines.push('        // 例如：', '        // #10;', `        // ${dataInputs[0].name} = 1;`);
  }
  lines.push('', `        #${clock ? 100 : 10};`, '        $finish;');
  return lines;
}

/** Module parameters referenced by port widths (with their dependencies), so the testbench declarations compile. */
function portWidthParameters(module: VerilogModule): VerilogDecl[] {
  const byName = new Map<string, VerilogDecl>();
  for (const parameter of module.parameters) {
    if (!byName.has(parameter.name)) {
      byName.set(parameter.name, parameter);
    }
  }
  const needed = new Set<string>();
  const visit = (text: string | undefined): void => {
    for (const name of text?.match(identifierPattern) ?? []) {
      const parameter = byName.get(name);
      if (parameter && !needed.has(name)) {
        needed.add(name);
        visit(parameter.initializer);
      }
    }
  };
  for (const port of module.ports) {
    visit(port.width);
  }
  return [...byName.values()].filter((parameter) => needed.has(parameter.name) && parameter.initializer?.trim());
}

function isSingleBit(port: VerilogDecl): boolean {
  return portBitWidth(port) === 1;
}

function portBitWidth(port: VerilogDecl): number | undefined {
  if (!port.width) {
    return 1;
  }
  const range = /^\[\s*(\d+)\s*:\s*(\d+)\s*\]$/.exec(port.width);
  return range ? Math.abs(Number(range[1]) - Number(range[2])) + 1 : undefined;
}
