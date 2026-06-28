import { Position } from 'vscode-languageserver/node';
import { containsPosition } from '../common/lsp';
import { ProjectProfile } from '../../projectProfile';
import {
  p7DataMemoryWords,
  p7ExternalInterruptAckAddress,
  p7InstructionMemoryWords,
  p7Timer0Ctrl,
  p7UserTextBaseAddress
} from '../../courseTesting/p7Hardware';
import { renderResourceTemplate } from '../../templates/templateRegistry';
import { VerilogDecl, VerilogModule } from './model';

const courseMemoryWords = 4096;

export function moduleAtPosition(modules: VerilogModule[], position: Position): VerilogModule | undefined {
  return modules.find((module) => containsPosition(module.range, position));
}

export function declDetail(decl: VerilogDecl): string {
  return `${decl.direction ?? decl.kind} ${decl.width ? `${decl.width} ` : ''}${decl.name}`.trim();
}

interface TestbenchOptions {
  finishDelay?: string;
  profile?: ProjectProfile;
  interruptSchedule?: number[];
  p7Probe?: P7ProbeTestbenchMetadata;
}

interface P7ProbeTestbenchMetadata {
  scenarios: Array<{
    id: number;
    kind: string;
    waitPc?: number;
    armAddress?: number;
    armValue?: number;
    externalDelayCycles?: number;
  }>;
}

export function buildTestbench(module: VerilogModule, tbName: string, options: TestbenchOptions = {}): string {
  const finishDelay = options.finishDelay?.trim() || '200000';
  const hasExternalInstructionMemory = hasPort(module, 'i_inst_addr') && hasPort(module, 'i_inst_rdata');
  const hasExternalDataMemory = hasPort(module, 'm_data_addr') && hasPort(module, 'm_data_rdata') && hasPort(module, 'm_data_wdata') && hasPort(module, 'm_data_byteen');
  const hasCourseExternalMemory = hasExternalInstructionMemory || hasExternalDataMemory;
  const isP7ExternalInterface = hasPort(module, 'interrupt') || hasPort(module, 'macroscopic_pc') || hasPort(module, 'm_int_addr') || hasPort(module, 'm_int_byteen');
  if (options.profile === 'P7' || isP7ExternalInterface) {
    return buildP7OfficialTestbench(module.name, tbName, options.interruptSchedule, options.p7Probe);
  }
  const hasWritebackTrace = hasPort(module, 'w_grf_we') && hasPort(module, 'w_grf_addr') && hasPort(module, 'w_grf_wdata') && hasPort(module, 'w_inst_addr');
  const hasDataMemoryTrace = hasExternalDataMemory && hasPort(module, 'm_inst_addr');
  const declarations = module.ports.map((port) => {
    const kind = testbenchSignalKind(port, hasCourseExternalMemory);
    return `    ${kind} ${port.width ? `${port.width} ` : ''}${port.name};`;
  });
  const connections = module.ports.map((port, index) => {
    const comma = index === module.ports.length - 1 ? '' : ',';
    return `        .${port.name}(${port.name})${comma}`;
  });
  const hasClk = module.ports.some((port) => port.name === 'clk');
  const hasReset = module.ports.some((port) => port.name === 'reset');

  if (hasCourseExternalMemory) {
    return renderExternalMemoryTestbench({
      connections,
      declarations,
      hasClk,
      hasDataMemoryTrace,
      hasExternalDataMemory,
      hasExternalInstructionMemory,
      hasReset,
      hasWritebackTrace,
      isP7ExternalInterface,
      module,
      tbName
    });
  }

  return renderBasicTestbench({
    connections,
    declarations,
    finishDelay,
    hasClk,
    hasReset,
    module,
    tbName
  });
}

interface BasicTestbenchViewModel {
  connections: string[];
  declarations: string[];
  finishDelay: string;
  hasClk: boolean;
  hasReset: boolean;
  module: VerilogModule;
  tbName: string;
}

function renderBasicTestbench(view: BasicTestbenchViewModel): string {
  const finishLines = ['    initial begin'];
  if (view.hasReset) {
    finishLines.push(
      "        reset = 1'b1;",
      '        #20;',
      "        reset = 1'b0;"
    );
  }
  finishLines.push(`        #${view.finishDelay};`, '        $finish;', '    end');

  return renderResourceTemplate('verilog/basic_testbench.v.tmpl', {
    tbName: view.tbName,
    topModuleName: view.module.name,
    declarations: lineList(view.declarations),
    connections: lineList(view.connections),
    clockBlock: view.hasClk ? separatedBlock([
      '    initial begin',
      "        clk = 1'b0;",
      '        forever #5 clk = ~clk;',
      '    end'
    ]) : '',
    finishBlock: separatedBlock(finishLines)
  });
}

interface ExternalMemoryTestbenchViewModel {
  connections: string[];
  declarations: string[];
  hasClk: boolean;
  hasDataMemoryTrace: boolean;
  hasExternalDataMemory: boolean;
  hasExternalInstructionMemory: boolean;
  hasReset: boolean;
  hasWritebackTrace: boolean;
  isP7ExternalInterface: boolean;
  module: VerilogModule;
  tbName: string;
}

function renderExternalMemoryTestbench(view: ExternalMemoryTestbenchViewModel): string {
  const memoryDeclarations: string[] = [];
  if (view.hasExternalInstructionMemory) {
    memoryDeclarations.push(`    reg [31:0] inst[0:${view.isP7ExternalInterface ? p7InstructionMemoryWords - 1 : courseMemoryWords - 1}];`);
  }
  if (view.hasExternalDataMemory) {
    memoryDeclarations.push(
      `    reg [31:0] data[0:${view.isP7ExternalInterface ? p7DataMemoryWords - 1 : courseMemoryWords - 1}];`,
      '    integer i;',
      '    reg [31:0] fixed_addr;',
      '    reg [31:0] fixed_wdata;'
    );
  }

  const memoryReadLines: string[] = [];
  if (view.hasExternalInstructionMemory) {
    memoryReadLines.push(view.isP7ExternalInterface
      ? `    assign i_inst_rdata = inst[((i_inst_addr - ${verilogHex32(p7UserTextBaseAddress)}) >> 2) % ${p7InstructionMemoryWords}];`
      : `    assign i_inst_rdata = inst[(i_inst_addr - ${verilogHex32(p7UserTextBaseAddress)}) >> 2];`);
  }
  if (view.hasExternalDataMemory) {
    memoryReadLines.push(view.isP7ExternalInterface
      ? `    assign m_data_rdata = data[(m_data_addr >> 2) % ${p7DataMemoryWords}];`
      : '    assign m_data_rdata = data[m_data_addr >> 2];');
  }

  return renderResourceTemplate('verilog/external_memory_testbench.v.tmpl', {
    tbName: view.tbName,
    topModuleName: view.module.name,
    declarations: lineList(view.declarations),
    memoryDeclarations: lineList(memoryDeclarations),
    connections: lineList(view.connections),
    memoryInitialBlock: separatedBlock(externalMemoryInitialLines(view.hasExternalInstructionMemory, view.hasExternalDataMemory, view.isP7ExternalInterface)),
    memoryReadBlock: separatedBlock(memoryReadLines),
    dataWriteBlock: view.hasExternalDataMemory && view.hasClk
      ? separatedBlock(externalDataMemoryWriteLines(view.hasReset, view.isP7ExternalInterface, view.hasDataMemoryTrace))
      : '',
    writebackTraceBlock: view.hasWritebackTrace && view.hasClk ? separatedBlock(writebackTraceLines(view.hasReset)) : '',
    courseInitialBlock: separatedBlock(courseExternalInitialLines(view.module, view.hasClk, view.hasReset)),
    clockBlock: view.hasClk ? separatedBlock(['    always #2 clk <= ~clk;']) : ''
  });
}

function lineList(lines: string[]): string {
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function separatedBlock(lines: string[]): string {
  return lines.length ? `${lines.join('\n')}\n\n` : '';
}

function buildP7OfficialTestbench(
  topModuleName: string,
  tbName: string,
  interruptSchedule?: number[],
  p7Probe?: P7ProbeTestbenchMetadata
): string {
  return renderResourceTemplate('verilog/p7_official_testbench.v.tmpl', {
    tbName,
    topModuleName,
    dataMemoryWords: p7DataMemoryWords,
    dataMemoryLastIndex: p7DataMemoryWords - 1,
    instructionMemoryWords: p7InstructionMemoryWords,
    instructionMemoryLastIndex: p7InstructionMemoryWords - 1,
    userTextBase: verilogHex32(p7UserTextBaseAddress),
    interruptBlock: p7Probe ? p7ProbeBlock(p7Probe) : p7InterruptBlock(interruptSchedule)
  });
}

function p7InterruptBlock(interruptSchedule?: number[]): string {
  const target = interruptSchedule?.find((pc) => Number.isFinite(pc));
  if (target === undefined) {
    return commentedP7InterruptBlock();
  }
  const targetHex = (target >>> 0).toString(16).padStart(8, '0');
  // Official tb_interrupt_demo.v interrupt block: raise `interrupt` once when the
  // macroscopic (M-stage) PC reaches target_pc, clear it when the handler writes the P7 ack MMIO.
  return renderResourceTemplate('verilog/p7_interrupt_block.v.tmpl', {
    targetPcHex: targetHex,
    externalInterruptAckAddress: verilogHex32(p7ExternalInterruptAckAddress)
  });
}

function p7ProbeBlock(probe: P7ProbeTestbenchMetadata): string {
  const externalScenarios = probe.scenarios.filter((scenario) =>
    scenario.kind === 'external' && Number.isFinite(scenario.waitPc));
  const externalScenarioCases = externalScenarios.map((scenario, index) => {
    const target = ((scenario.waitPc ?? 0) >>> 0).toString(16).padStart(8, '0');
    const armAddress = Number.isFinite(scenario.armAddress) ? ((scenario.armAddress ?? 0) >>> 0) : 0;
    const armValue = Number.isFinite(scenario.armValue) ? ((scenario.armValue ?? scenario.id) >>> 0) : scenario.id;
    const delay = Number.isFinite(scenario.externalDelayCycles) ? Math.max(0, Math.floor(scenario.externalDelayCycles ?? 0)) : 0;
    return [
      `            ${index}: begin`,
      `                co_p7_external_scenario = ${scenario.id};`,
      `                co_p7_external_target = 32'h${target};`,
      `                co_p7_external_arm_addr = 32'h${armAddress.toString(16).padStart(8, '0')};`,
      `                co_p7_external_arm_value = 32'h${armValue.toString(16).padStart(8, '0')};`,
      `                co_p7_external_delay = ${delay};`,
      `                co_p7_external_legacy = ${armAddress === 0 ? 1 : 0};`,
      '            end'
    ].join('\n');
  }).join('\n');
  return renderResourceTemplate('verilog/p7_probe_block.v.tmpl', {
    externalScenarioCases,
    externalInterruptAckAddress: verilogHex32(p7ExternalInterruptAckAddress),
    timer0CtrlAddress: verilogHex32(p7Timer0Ctrl),
    externalInterruptMmioMaxAddress: verilogHex32(p7ExternalInterruptAckAddress + 0xf)
  });
}

function commentedP7InterruptBlock(): string {
  return renderResourceTemplate('verilog/p7_interrupt_block_commented.v.tmpl', {
    externalInterruptAckAddress: verilogHex32(p7ExternalInterruptAckAddress)
  });
}

function testbenchSignalKind(port: VerilogDecl, hasExternalMemory: boolean): 'reg' | 'wire' {
  if (port.direction === 'output' || port.direction === 'inout') {
    return 'wire';
  }
  if (hasExternalMemory && (port.name === 'i_inst_rdata' || port.name === 'm_data_rdata')) {
    return 'wire';
  }
  return 'reg';
}

function hasPort(module: VerilogModule, name: string): boolean {
  return module.ports.some((port) => port.name === name);
}

function courseExternalInitialLines(module: VerilogModule, hasClk: boolean, hasReset: boolean): string[] {
  const lines = ['    initial begin'];
  if (hasClk) {
    lines.push("        clk = 1'b0;");
  }
  if (hasReset) {
    lines.push("        reset = 1'b1;");
  }
  for (const port of module.ports) {
    if (port.direction !== 'input' || courseDrivenInputSignals.has(port.name)) {
      continue;
    }
    lines.push(`        ${port.name} = 0;`);
  }
  if (hasReset) {
    lines.push('        #20;', "        reset = 1'b0;");
  }
  lines.push('    end');
  return lines;
}

const courseDrivenInputSignals = new Set(['clk', 'reset', 'i_inst_rdata', 'm_data_rdata']);

function externalMemoryInitialLines(hasInstructionMemory: boolean, hasDataMemory: boolean, isP7ExternalInterface: boolean): string[] {
  const lines = ['    initial begin'];
  if (hasInstructionMemory) {
    lines.push('        $readmemh("code.txt", inst);');
  }
  if (hasDataMemory) {
    lines.push(`        for (i = 0; i < ${isP7ExternalInterface ? p7DataMemoryWords : courseMemoryWords}; i = i + 1) begin`, '            data[i] <= 0;', '        end');
  }
  lines.push('    end');
  return lines;
}

function externalDataMemoryWriteLines(hasReset: boolean, isP7ExternalInterface: boolean, hasDataMemoryTrace: boolean): string[] {
  const fixedReadIndex = isP7ExternalInterface ? `(m_data_addr >> 2) & ${p7DataMemoryWords - 1}` : 'm_data_addr >> 2';
  const writeCondition = isP7ExternalInterface ? `|m_data_byteen && fixed_addr >> 2 < ${p7DataMemoryWords}` : '|m_data_byteen';
  const lines = ['    always @(posedge clk) begin'];
  const combinational = [
    '    always @(*) begin',
    `        fixed_wdata = data[${fixedReadIndex}];`,
    "        fixed_addr = m_data_addr & 32'hfffffffc;",
    '        if (m_data_byteen[3]) fixed_wdata[31:24] = m_data_wdata[31:24];',
    '        if (m_data_byteen[2]) fixed_wdata[23:16] = m_data_wdata[23:16];',
    '        if (m_data_byteen[1]) fixed_wdata[15:8] = m_data_wdata[15:8];',
    '        if (m_data_byteen[0]) fixed_wdata[7:0] = m_data_wdata[7:0];',
    '    end',
    ''
  ];
  if (hasReset) {
    lines.push(
      '        if (reset) begin',
      `            for (i = 0; i < ${isP7ExternalInterface ? p7DataMemoryWords : courseMemoryWords}; i = i + 1) begin`,
      '                data[i] <= 0;',
      '            end',
      `        end else if (${writeCondition}) begin`
    );
  } else {
    lines.push(`        if (${writeCondition}) begin`);
  }
  lines.push('            data[fixed_addr >> 2] <= fixed_wdata;');
  if (hasDataMemoryTrace) {
    lines.push('            $display("%d@%h: *%h <= %h", $time, m_inst_addr, fixed_addr, fixed_wdata);');
  }
  lines.push('        end', '    end');
  return [...combinational, ...lines];
}

function writebackTraceLines(hasReset: boolean): string[] {
  const lines = [
    '    always @(posedge clk) begin',
  ];
  if (hasReset) {
    lines.push(
      '        if (!reset) begin',
      '            if (w_grf_we && (w_grf_addr != 0)) begin',
      '                $display("%d@%h: $%d <= %h", $time, w_inst_addr, w_grf_addr, w_grf_wdata);',
      '            end',
      '        end',
      '    end'
    );
    return lines;
  }
  lines.push(
    '        if (w_grf_we && (w_grf_addr != 0)) begin',
    '            $display("%d@%h: $%d <= %h", $time, w_inst_addr, w_grf_addr, w_grf_wdata);',
    '        end',
    '    end'
  );
  return lines;
}

function verilogHex32(value: number): string {
  return `32'h${(value >>> 0).toString(16).padStart(4, '0')}`;
}
