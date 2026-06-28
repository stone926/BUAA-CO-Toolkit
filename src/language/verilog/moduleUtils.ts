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
  const lines: string[] = [
    '`timescale 1ns / 1ps',
    '',
    `module ${tbName};`,
    ...declarations
  ];

  if (hasExternalInstructionMemory) {
    lines.push(`    reg [31:0] inst[0:${isP7ExternalInterface ? p7InstructionMemoryWords - 1 : courseMemoryWords - 1}];`);
  }
  if (hasExternalDataMemory) {
    lines.push(`    reg [31:0] data[0:${isP7ExternalInterface ? p7DataMemoryWords - 1 : courseMemoryWords - 1}];`, '    integer i;', '    reg [31:0] fixed_addr;', '    reg [31:0] fixed_wdata;');
  }

  lines.push(
    '',
    `    ${module.name} uut (`,
    ...connections,
    '    );',
    ''
  );

  if (hasExternalInstructionMemory || hasExternalDataMemory) {
    lines.push(...externalMemoryInitialLines(hasExternalInstructionMemory, hasExternalDataMemory, isP7ExternalInterface), '');
  }

  if (hasExternalInstructionMemory) {
    lines.push(isP7ExternalInterface
      ? `    assign i_inst_rdata = inst[((i_inst_addr - ${verilogHex32(p7UserTextBaseAddress)}) >> 2) % ${p7InstructionMemoryWords}];`
      : `    assign i_inst_rdata = inst[(i_inst_addr - ${verilogHex32(p7UserTextBaseAddress)}) >> 2];`);
  }
  if (hasExternalDataMemory) {
    lines.push(isP7ExternalInterface
      ? `    assign m_data_rdata = data[(m_data_addr >> 2) % ${p7DataMemoryWords}];`
      : '    assign m_data_rdata = data[m_data_addr >> 2];');
  }
  if (hasExternalInstructionMemory || hasExternalDataMemory) {
    lines.push('');
  }

  if (hasExternalDataMemory && hasClk) {
    lines.push(...externalDataMemoryWriteLines(hasReset, isP7ExternalInterface, hasDataMemoryTrace), '');
  }

  if (hasWritebackTrace && hasClk) {
    lines.push(...writebackTraceLines(hasReset), '');
  }

  if (hasCourseExternalMemory) {
    lines.push(...courseExternalInitialLines(module, hasClk, hasReset), '');
    if (hasClk) {
      lines.push('    always #2 clk <= ~clk;', '');
    }
    lines.push('endmodule', '');
    return lines.join('\n');
  }

  if (hasClk) {
    lines.push(
      '    initial begin',
      "        clk = 1'b0;",
      '        forever #5 clk = ~clk;',
      '    end',
      ''
    );
  }

  lines.push('    initial begin');
  if (hasReset) {
    lines.push(
      "        reset = 1'b1;",
      '        #20;',
      "        reset = 1'b0;"
    );
  }
  lines.push(`        #${finishDelay};`, '        $finish;', '    end', 'endmodule', '');
  return lines.join('\n');
}

function buildP7OfficialTestbench(
  topModuleName: string,
  tbName: string,
  interruptSchedule?: number[],
  p7Probe?: P7ProbeTestbenchMetadata
): string {
  return [
    '`timescale 1ns/1ps',
    '',
    `module ${tbName};`,
    '',
    '    reg clk;',
    '    reg reset;',
    '    reg interrupt;',
    '',
    '    wire [31:0] macroscopic_pc;',
    '',
    '    wire [31:0] i_inst_addr;',
    '    wire [31:0] i_inst_rdata;',
    '',
    '    wire [31:0] m_data_addr;',
    '    wire [31:0] m_data_rdata;',
    '    wire [31:0] m_data_wdata;',
    '    wire [3 :0] m_data_byteen;',
    '',
    '    wire [31:0] m_int_addr;',
    '    wire [3 :0] m_int_byteen;',
    '',
    '    wire [31:0] m_inst_addr;',
    '',
    '    wire        w_grf_we;',
    '    wire [4 :0] w_grf_addr;',
    '    wire [31:0] w_grf_wdata;',
    '',
    '    wire [31:0] w_inst_addr;',
    '',
    `    ${topModuleName} uut(`,
    '        .clk(clk),',
    '        .reset(reset),',
    '        .interrupt(interrupt),',
    '        .macroscopic_pc(macroscopic_pc),',
    '',
    '        .i_inst_addr(i_inst_addr),',
    '        .i_inst_rdata(i_inst_rdata),',
    '',
    '        .m_data_addr(m_data_addr),',
    '        .m_data_rdata(m_data_rdata),',
    '        .m_data_wdata(m_data_wdata),',
    '        .m_data_byteen(m_data_byteen),',
    '',
    '        .m_int_addr(m_int_addr),',
    '        .m_int_byteen(m_int_byteen),',
    '',
    '        .m_inst_addr(m_inst_addr),',
    '',
    '        .w_grf_we(w_grf_we),',
    '        .w_grf_addr(w_grf_addr),',
    '        .w_grf_wdata(w_grf_wdata),',
    '',
    '        .w_inst_addr(w_inst_addr)',
    '    );',
    '',
    '    initial begin',
    '        clk <= 0;',
    '        reset <= 1;',
    '        interrupt <= 0;',
    '        #20 reset <= 0;',
    '    end',
    '',
    '    integer i;',
    '    reg [31:0] fixed_addr;',
    '    reg [31:0] fixed_wdata;',
    `    reg [31:0] data[0:${p7DataMemoryWords - 1}];`,
    `    reg [31:0] inst[0:${p7InstructionMemoryWords - 1}];`,
    '',
    '    // ----------- For Instructions -----------',
    '',
    `    assign m_data_rdata = data[(m_data_addr >> 2) % ${p7DataMemoryWords}];`,
    `    assign i_inst_rdata = inst[((i_inst_addr - ${verilogHex32(p7UserTextBaseAddress)}) >> 2) % ${p7InstructionMemoryWords}];`,
    '',
    '    initial begin',
    '        $readmemh("code.txt", inst);',
    `        for (i = 0; i < ${p7DataMemoryWords}; i = i + 1) data[i] <= 0;`,
    '    end',
    '',
    '    // ----------- For Data Memory -----------',
    '',
    '    always @(*) begin',
    `        fixed_wdata = data[(m_data_addr >> 2) & ${p7DataMemoryWords - 1}];`,
    "        fixed_addr = m_data_addr & 32'hfffffffc;",
    '        if (m_data_byteen[3]) fixed_wdata[31:24] = m_data_wdata[31:24];',
    '        if (m_data_byteen[2]) fixed_wdata[23:16] = m_data_wdata[23:16];',
    '        if (m_data_byteen[1]) fixed_wdata[15: 8] = m_data_wdata[15: 8];',
    '        if (m_data_byteen[0]) fixed_wdata[7 : 0] = m_data_wdata[7 : 0];',
    '    end',
    '',
    '    always @(posedge clk) begin',
    `        if (reset) for (i = 0; i < ${p7DataMemoryWords}; i = i + 1) data[i] <= 0;`,
    `        else if (|m_data_byteen && fixed_addr >> 2 < ${p7DataMemoryWords}) begin`,
    '            data[fixed_addr >> 2] <= fixed_wdata;',
    '            $display("%d@%h: *%h <= %h", $time, m_inst_addr, fixed_addr, fixed_wdata);',
    '        end',
    '    end',
    '',
    '    // ----------- For Registers -----------',
    '',
    '    always @(posedge clk) begin',
    '        if (~reset) begin',
    '            if (w_grf_we && (w_grf_addr != 0)) begin',
    '                $display("%d@%h: $%d <= %h", $time, w_inst_addr, w_grf_addr, w_grf_wdata);',
    '            end',
    '        end',
    '    end',
    '',
    ...(p7Probe ? p7ProbeBlock(p7Probe) : p7InterruptBlock(interruptSchedule)),
    '',
    '    always #2 clk <= ~clk;',
    '',
    'endmodule',
    ''
  ].join('\n');
}

function p7InterruptBlock(interruptSchedule?: number[]): string[] {
  const target = interruptSchedule?.find((pc) => Number.isFinite(pc));
  if (target === undefined) {
    return commentedP7InterruptBlock();
  }
  const targetHex = (target >>> 0).toString(16).padStart(8, '0');
  // Official tb_interrupt_demo.v interrupt block: raise `interrupt` once when the
  // macroscopic (M-stage) PC reaches target_pc, clear it when the handler writes the P7 ack MMIO.
  return [
    '    // ----------- For Interrupt -----------',
    '',
    '    wire [31:0] fixed_macroscopic_pc;',
    '',
    "    assign fixed_macroscopic_pc = macroscopic_pc & 32'hfffffffc;",
    '',
    `    parameter target_pc = 32'h${targetHex};`,
    '',
    '    integer count;',
    '',
    '    initial begin',
    '        count = 0;',
    '    end',
    '',
    '    always @(negedge clk) begin',
    '        if (reset) begin',
    '            interrupt = 0;',
    '        end',
    '        else begin',
    '            if (interrupt) begin',
    `                if (|m_int_byteen && (m_int_addr & 32'hfffffffc) == ${verilogHex32(p7ExternalInterruptAckAddress)}) begin`,
    '                    interrupt = 0;',
    '                end',
    '            end',
    '            else if (fixed_macroscopic_pc == target_pc) begin',
    '                if (count == 0) begin',
    '                    count = 1;',
    '                    interrupt = 1;',
    '                end',
    '            end',
    '        end',
    '    end'
  ];
}

function p7ProbeBlock(probe: P7ProbeTestbenchMetadata): string[] {
  const externalScenarios = probe.scenarios.filter((scenario) =>
    scenario.kind === 'external' && Number.isFinite(scenario.waitPc));
  const lines: string[] = [
    '    // ----------- For P7 Probe Interrupt -----------',
    '',
    '    wire [31:0] fixed_macroscopic_pc;',
    '',
    "    assign fixed_macroscopic_pc = macroscopic_pc & 32'hfffffffc;",
    '',
    '    integer co_p7_external_index;',
    '    integer co_p7_external_scenario;',
    '    integer co_p7_external_delay;',
    '    integer co_p7_external_wait_count;',
    '    reg [31:0] co_p7_external_target;',
    '    reg [31:0] co_p7_external_arm_addr;',
    '    reg [31:0] co_p7_external_arm_value;',
    '    reg co_p7_external_armed;',
    '    reg co_p7_external_legacy;',
    '',
    '    initial begin',
    '        co_p7_external_index = 0;',
    '        co_p7_external_scenario = 0;',
    '        co_p7_external_delay = 0;',
    '        co_p7_external_wait_count = 0;',
    '        co_p7_external_target = 0;',
    '        co_p7_external_arm_addr = 0;',
    '        co_p7_external_arm_value = 0;',
    '        co_p7_external_armed = 0;',
    '        co_p7_external_legacy = 0;',
    '    end',
    '',
    '    always @(*) begin',
    '        co_p7_external_scenario = 0;',
    '        co_p7_external_delay = 0;',
    '        co_p7_external_target = 0;',
    '        co_p7_external_arm_addr = 0;',
    '        co_p7_external_arm_value = 0;',
    '        co_p7_external_legacy = 0;',
    '        case (co_p7_external_index)'
  ];
  externalScenarios.forEach((scenario, index) => {
    const target = ((scenario.waitPc ?? 0) >>> 0).toString(16).padStart(8, '0');
    const armAddress = Number.isFinite(scenario.armAddress) ? ((scenario.armAddress ?? 0) >>> 0) : 0;
    const armValue = Number.isFinite(scenario.armValue) ? ((scenario.armValue ?? scenario.id) >>> 0) : scenario.id;
    const delay = Number.isFinite(scenario.externalDelayCycles) ? Math.max(0, Math.floor(scenario.externalDelayCycles ?? 0)) : 0;
    lines.push(
      `            ${index}: begin`,
      `                co_p7_external_scenario = ${scenario.id};`,
      `                co_p7_external_target = 32'h${target};`,
      `                co_p7_external_arm_addr = 32'h${armAddress.toString(16).padStart(8, '0')};`,
      `                co_p7_external_arm_value = 32'h${armValue.toString(16).padStart(8, '0')};`,
      `                co_p7_external_delay = ${delay};`,
      `                co_p7_external_legacy = ${armAddress === 0 ? 1 : 0};`,
      '            end'
    );
  });
  lines.push(
    '            default: begin',
    '                co_p7_external_scenario = 0;',
    '                co_p7_external_target = 0;',
    '            end',
    '        endcase',
    '    end',
    '',
    '    always @(negedge clk) begin',
    '        if (reset) begin',
    '            interrupt = 0;',
    '            co_p7_external_index = 0;',
    '            co_p7_external_armed = 0;',
    '            co_p7_external_wait_count = 0;',
    '        end',
    '        else begin',
    '            if (interrupt) begin',
    `                if (|m_int_byteen && (m_int_addr & 32'hfffffffc) == ${verilogHex32(p7ExternalInterruptAckAddress)}) begin`,
    '                    $display("CO_P7_PROBE external_ack scenario=%0d time=%0d", co_p7_external_scenario, $time);',
    '                    interrupt = 0;',
    '                    co_p7_external_armed = 0;',
    '                    co_p7_external_wait_count = 0;',
    '                    co_p7_external_index = co_p7_external_index + 1;',
    '                end',
    '            end',
    '            else if (co_p7_external_target != 0 && co_p7_external_legacy && fixed_macroscopic_pc == co_p7_external_target) begin',
    '                $display("CO_P7_PROBE external_raise scenario=%0d pc=%h time=%0d", co_p7_external_scenario, fixed_macroscopic_pc, $time);',
    '                interrupt = 1;',
    '            end',
    '            else if (co_p7_external_target != 0 && co_p7_external_armed && fixed_macroscopic_pc == co_p7_external_target) begin',
    '                if (co_p7_external_wait_count >= co_p7_external_delay) begin',
    '                    $display("CO_P7_PROBE external_raise scenario=%0d pc=%h time=%0d", co_p7_external_scenario, fixed_macroscopic_pc, $time);',
    '                    interrupt = 1;',
    '                    co_p7_external_armed = 0;',
    '                end',
    '                else begin',
    '                    co_p7_external_wait_count = co_p7_external_wait_count + 1;',
    '                end',
    '            end',
    '        end',
    '    end',
    '',
    '    always @(posedge clk) begin',
    '        if (reset) begin',
    '            co_p7_external_armed = 0;',
    '            co_p7_external_wait_count = 0;',
    '        end',
    "        else if (co_p7_external_arm_addr != 0 && |m_data_byteen && fixed_addr == co_p7_external_arm_addr && fixed_wdata == co_p7_external_arm_value) begin",
    '            co_p7_external_armed = 1;',
    '            co_p7_external_wait_count = 0;',
    '            $display("CO_P7_PROBE external_arm scenario=%0d addr=%h value=%h time=%0d", co_p7_external_scenario, fixed_addr, fixed_wdata, $time);',
    '        end',
    '    end',
    '',
    '    always @(posedge clk) begin',
    `        if (~reset && |m_data_byteen && fixed_addr >= ${verilogHex32(p7Timer0Ctrl)} && fixed_addr <= ${verilogHex32(p7ExternalInterruptAckAddress + 0xf)}) begin`,
    '            $display("CO_P7_PROBE mmio_on_dm pc=%h addr=%h byteen=%h time=%0d", m_inst_addr, fixed_addr, m_data_byteen, $time);',
    '        end',
    '    end'
  );
  return lines;
}

function commentedP7InterruptBlock(): string[] {
  return [
    '    // ----------- For Interrupt -----------',
    '    //',
    '    // wire [31:0] fixed_macroscopic_pc;',
    '    //',
    "    // assign fixed_macroscopic_pc = macroscopic_pc & 32'hfffffffc;",
    '    //',
    "    // parameter target_pc = 32'h00003010;",
    '    //',
    '    // integer count;',
    '    //',
    '    // initial begin',
    '    //     count = 0;',
    '    // end',
    '    //',
    '    // always @(negedge clk) begin',
    '    //     if (reset) begin',
    '    //         interrupt = 0;',
    '    //     end',
    '    //     else begin',
    '    //         if (interrupt) begin',
    `    //             if (|m_int_byteen && (m_int_addr & 32'hfffffffc) == ${verilogHex32(p7ExternalInterruptAckAddress)}) begin`,
    '    //                 interrupt = 0;',
    '    //             end',
    '    //         end',
    '    //         else if (fixed_macroscopic_pc == target_pc) begin',
    '    //             if (count == 0) begin',
    '    //                 count = 1;',
    '    //                 interrupt = 1;',
    '    //             end',
    '    //         end',
    '    //     end',
    '    // end'
  ];
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
